import type {
  ApiMessageItem,
  LarkChannel,
  RawMessageEvent,
} from '@larksuite/channel';
import { normalize } from '@larksuite/channel';

import { log } from '@/core/logger';

import { expandInteractiveCard } from './interactive-card';

type MessageGetResponse = Awaited<ReturnType<LarkChannel['rawClient']['im']['v1']['message']['get']>>;
export type FeishuMessageItem = NonNullable<NonNullable<MessageGetResponse['data']>['items']>[number];

/** The channel wrapper forwards message.get items but publishes a narrower item type. */
export async function fetchFeishuMessageItems(
  channel: LarkChannel,
  messageId: string,
  cardContentType: string | null = 'user_card_content',
): Promise<FeishuMessageItem[]> {
  return await channel.fetchRawMessage(messageId, { cardContentType }) as unknown as FeishuMessageItem[];
}

export interface QuotedContext {
  messageId: string;
  senderId: string;
  senderName?: string;
  /** Human vs bot, derived from the Feishu `sender.sender_type`. Undefined when
   * the source item didn't carry it (single-quote fetch path). */
  senderType?: 'user' | 'bot';
  /** ISO timestamp of the quoted message's creation. Empty when SDK can't
   * resolve it from the fetched item. */
  createdAt: string;
  /** Normalized human-readable content. For text/post this is plain text;
   * for merge_forward the SDK expands the tree into `<forwarded_messages>...
   * </forwarded_messages>` (capped at 50 items by the SDK). */
  content: string;
  rawContentType: string;
  mentionedOpenIds?: string[];
  threadId?: string;
  rootId?: string;
  parentId?: string;
}

/**
 * Fetch and normalize the content of a message that the user is reply-quoting.
 *
 * Why this is non-trivial: `im.v1.message.get` returns a flat message item
 * list (parent + descendants for merge_forward), but the bot intake pipeline
 * deals in `NormalizedMessage`. We synthesize a `RawMessageEvent` from the
 * parent item and feed it through the SDK's `normalize` so merge_forward gets
 * the same `<forwarded_messages>` expansion path that live events do.
 *
 * `chatId` / `chatType` on the synthesized raw event don't have to be real —
 * normalize doesn't validate them, and downstream only uses the resulting
 * `content`. Same for mentions (we don't pass any).
 */
/**
 * Rewrite an interactive sub-message's body.content so the SDK's
 * `convertInteractive` → `walkCard` finds a text node and emits real card
 * content instead of the literal `[interactive card]` placeholder. We wrap
 * our expanded `<interactive_card>` block as a `plain_text` node — that's
 * one of the three tags walkCard treats as text-bearing
 * (plain_text / lark_md / markdown).
 *
 * This is the merge_forward fix: sub-messages bypass the parent-level
 * expansion because the SDK assembles `<forwarded_messages>` internally from
 * each sub's flattened form, so we have to inject expansion at the sub-fetch
 * layer.
 */
function preExpandInteractive(item: FeishuMessageItem): FeishuMessageItem {
  if (item.msg_type !== 'interactive') return item;
  const raw = item.body?.content;
  if (typeof raw !== 'string' || raw.length === 0) return item;
  const expanded = expandInteractiveCard('[interactive card]', raw);
  // expandInteractiveCard returns the placeholder unchanged when there's
  // nothing to expand — skip rewriting in that case to avoid double wrapping.
  if (expanded === '[interactive card]') return item;
  const wrapper = JSON.stringify({ tag: 'plain_text', content: expanded });
  return { ...item, body: { ...item.body, content: wrapper } };
}

export async function fetchQuotedContext(
  channel: LarkChannel,
  messageId: string,
): Promise<QuotedContext | undefined> {
  let items: FeishuMessageItem[];
  try {
    // Ask for the original card JSON (incl. v2 user_dsl) instead of the
    // default v1-canonical fallback that strips it.
    items = await fetchFeishuMessageItems(channel, messageId);
  } catch (err) {
    log.warn('quote', 'fetch-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  const parent = items[0];
  if (!parent || !parent.message_id) return undefined;

  // Reuse the already-fetched items when the SDK re-asks for sub-messages of
  // this same id (merge_forward case). For nested merge_forwards inside, fetch
  // fresh — and let a fetch failure throw so it surfaces as a fetch_failed
  // forward rather than a silently-empty one (see fetchSubTreeItems).
  const fetchSubMessages = async (mid: string): Promise<FeishuMessageItem[]> => {
    if (mid === parent.message_id) return items.map(preExpandInteractive);
    const subItems = await fetchSubTreeItems(channel, mid);
    return subItems.map(preExpandInteractive);
  };

  return normalizeItemToQuoted(channel, parent, fetchSubMessages);
}

function mapSenderType(raw: unknown): 'user' | 'bot' | undefined {
  if (raw === 'user') return 'user';
  if (raw === 'app' || raw === 'bot') return 'bot';
  return undefined;
}

function normalizedMentions(value: FeishuMessageItem['mentions']): RawMessageEvent['message']['mentions'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const mention = item as { key?: unknown; id?: unknown; name?: unknown };
    const id = typeof mention.id === 'string'
      ? { open_id: mention.id }
      : mention.id && typeof mention.id === 'object'
        ? mention.id as { open_id?: string; user_id?: string; union_id?: string }
        : undefined;
    if (typeof mention.key !== 'string' || !id) return [];
    return [{ key: mention.key, id, ...(typeof mention.name === 'string' ? { name: mention.name } : {}) }];
  });
}

function toApiMessageItem(item: FeishuMessageItem): ApiMessageItem {
  return { ...item, mentions: normalizedMentions(item.mentions) };
}

/**
 * Normalize a single fetched message item (from `im.v1.message.get` or
 * `im.v1.message.list`) into a {@link QuotedContext}. Shared by the reply-quote
 * path and the topic-context path. `fetchSubMessages` resolves merge_forward
 * children — callers decide whether to reuse an already-fetched batch or fetch
 * fresh.
 */
export async function normalizeItemToQuoted(
  channel: LarkChannel,
  parent: FeishuMessageItem,
  fetchSubMessages: (mid: string) => Promise<FeishuMessageItem[]>,
): Promise<QuotedContext | undefined> {
  if (!parent.message_id) return undefined;
  const senderOpenId = parent.sender?.id;
  const fakeRaw: RawMessageEvent = {
    sender: { sender_id: { open_id: senderOpenId } },
    message: {
      message_id: parent.message_id,
      // chat_id / chat_type aren't actually used by normalize's converters,
      // but the field is required by the type. Empty strings are safe.
      chat_id: '',
      chat_type: 'group',
      message_type: parent.msg_type ?? 'text',
      content: parent.body?.content ?? '',
      create_time: parent.create_time !== undefined ? String(parent.create_time) : undefined,
      mentions: normalizedMentions(parent.mentions),
    },
  };

  const botIdentity = channel.botIdentity ?? { openId: '', name: '' };
  try {
    const normalized = await normalize(fakeRaw, {
      botIdentity,
      fetchSubMessages: async (mid) => (await fetchSubMessages(mid)).map(toApiMessageItem),
      // We want the raw content here, not the trimmed @bot mention form.
      stripBotMentions: false,
    });
    const createMs = parent.create_time
      ? Number.parseInt(String(parent.create_time), 10)
      : 0;
    return {
      messageId: parent.message_id,
      senderId: senderOpenId ?? '',
      senderName: normalized.senderName,
      senderType: mapSenderType(parent.sender?.sender_type),
      createdAt: Number.isFinite(createMs) && createMs > 0
        ? new Date(createMs).toISOString()
        : '',
      // For zero-text interactive cards the SDK gave us "[interactive card]"
      // — substitute the raw JSON so Claude can still see what was quoted.
      content: expandInteractiveCard(normalized.content, parent.body?.content),
      rawContentType: parent.msg_type ?? 'text',
      mentionedOpenIds: normalizedMentions(parent.mentions)?.map((mention) => mention.id.open_id).filter((id): id is string => Boolean(id)),
      ...(parent.thread_id ? { threadId: parent.thread_id } : {}),
      ...(parent.root_id ? { rootId: parent.root_id } : {}),
      ...(parent.parent_id ? { parentId: parent.parent_id } : {}),
    };
  } catch (err) {
    log.warn('quote', 'normalize-failed', {
      messageId: parent.message_id,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Fetch a Feishu topic's upstream messages (chronological) so the agent has the
 * conversation it's being pulled into. The root message is fetched by ID
 * separately because the thread-list endpoint is not a reliable source for
 * the message that started the thread. Used only on the bot's first engagement
 * in a topic (an already-engaged topic keeps its history in the resumed
 * session).
 *
 * `excludeIds` drops the triggering messages and any explicit reply-quotes so
 * they aren't duplicated. The root is returned once at the beginning and does
 * not count against `maxMessages`. Thread history is capped at that limit
 * (keeps the most recent when the topic is longer). Reads are best-effort: a
 * list result can supply the root if its direct fetch fails.
 */
export async function fetchTopicContext(
  channel: LarkChannel,
  threadId: string,
  opts: { maxMessages: number; excludeIds?: Set<string>; rootMessageId?: string },
): Promise<QuotedContext[]> {
  const exclude = new Set(opts.excludeIds ?? []);
  const rootMessageId = opts.rootMessageId;
  const rootContext = rootMessageId && !exclude.has(rootMessageId)
    ? await fetchQuotedContext(channel, rootMessageId)
    : undefined;
  const rootAlreadyProvided = Boolean(rootMessageId && exclude.has(rootMessageId));
  // When the direct lookup succeeds (or the root is already in the current
  // batch/quoted context), exclude it from the thread list to avoid duplicates.
  if (rootMessageId && (rootContext || rootAlreadyProvided)) exclude.add(rootMessageId);

  const collected: FeishuMessageItem[] = [];
  const seen = new Set<string>();
  let rootFromList: FeishuMessageItem | undefined;
  let pageToken: string | undefined;
  try {
    do {
      const res = await channel.rawClient.im.v1.message.list({
        params: {
          container_id_type: 'thread',
          container_id: threadId,
          sort_type: 'ByCreateTimeDesc',
          page_size: 50,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      const data = res.data;
      const items = data?.items ?? [];
      for (const item of items) {
        const messageId = item.message_id;
        if (!messageId || item.deleted) continue;
        if (messageId === rootMessageId && !rootContext && !rootAlreadyProvided) {
          rootFromList ??= item;
          continue;
        }
        if (exclude.has(messageId) || seen.has(messageId)) continue;
        seen.add(messageId);
        collected.push(item);
      }
      pageToken = data?.has_more ? data.page_token : undefined;
    } while (pageToken && collected.length < opts.maxMessages);
  } catch (err) {
    log.warn('topic', 'context-fetch-failed', {
      threadId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // The API results are newest-first to avoid paging through the entire thread;
  // restore chronological order for the prompt after retaining the newest N.
  const relevant = collected.slice(0, opts.maxMessages).reverse();

  const out: QuotedContext[] = [];
  for (const item of relevant) {
    const fetchSubMessages = async (mid: string): Promise<FeishuMessageItem[]> => {
      const source = mid === item.message_id ? [item] : await fetchSubTreeItems(channel, mid);
      return source.map(preExpandInteractive);
    };
    const quoted = await normalizeItemToQuoted(channel, item, fetchSubMessages);
    if (quoted) out.push(quoted);
  }
  const rootItem = rootFromList;
  const listedRootContext = !rootContext && rootItem
    ? await normalizeItemToQuoted(channel, rootItem, async (mid) => {
        const source = mid === rootItem.message_id
          ? [rootItem]
          : await fetchSubTreeItems(channel, mid);
        return source.map(preExpandInteractive);
      })
    : undefined;
  const root = rootContext ?? listedRootContext;
  return root ? [root, ...out] : out;
}

/**
 * Fetch a nested sub-message's items for merge_forward expansion. Unlike a
 * best-effort context fetch, this RE-THROWS on failure: the SDK's
 * convertMergeForward turns a throw into the `<forwarded_messages
 * status="fetch_failed"/>` sentinel, so a transient fetch failure surfaces as
 * fetch_failed instead of being silently flattened to an empty forward — the
 * same distinction @larksuite/channel makes on the live-event path. Passed into
 * `normalize` as `fetchSubMessages`.
 */
async function fetchSubTreeItems(
  channel: LarkChannel,
  messageId: string,
): Promise<FeishuMessageItem[]> {
  try {
    return await fetchFeishuMessageItems(channel, messageId);
  } catch (err) {
    log.warn('quote', 'sub-fetch-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Render one or more quoted contexts as an XML block intended to sit at the
 * top of the prompt body (after `<bridge_context>`, before the user's actual
 * question). Returns empty string when there are no quotes — keeps callers
 * concatenating without conditional checks.
 */
export function renderQuotedBlock(quotes: QuotedContext[]): string {
  if (quotes.length === 0) return '';
  const parts = quotes.map((q) => {
    const attrs = [
      `id="${q.messageId}"`,
      q.senderId ? `sender_id="${q.senderId}"` : '',
      q.senderName ? `sender_name="${q.senderName}"` : '',
      q.createdAt ? `created_at="${q.createdAt}"` : '',
      `type="${q.rawContentType}"`,
    ]
      .filter(Boolean)
      .join(' ');
    return `<quoted_message ${attrs}>\n${q.content}\n</quoted_message>`;
  });
  return parts.join('\n');
}
