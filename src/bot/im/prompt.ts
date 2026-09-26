import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';

import { modelLabel, normalizeModelSelection, resolveModelArg } from '@/agent/models';
import {
  type BridgePromptContext,
  type BridgePromptInteractiveCard,
  type BridgePromptMention,
  type BridgePromptQuotedMessage,
  type BridgePromptTopicMessage,
  buildAgentPrompt,
} from '@/agent/prompt';
import type { ChatMode } from '@/bot/chat-mode-cache';
import { fetchQuotedContext, fetchTopicContext, type QuotedContext } from '@/bot/quote';
import type { Controls } from '@/commands';
import { log } from '@/core/logger';
import { toPromptAttachment } from '@/media/attachment';
import type { LocalAttachment,MediaCache } from '@/media/cache';
import type { SessionCatalog } from '@/session/catalog';
import type { SessionStore } from '@/session/store';

import type { ImRunRequest } from './types';

const BRIDGE_AGENT_INSTRUCTIONS = [
  '你在 bridge 进程中运行，普通 lark-cli 会继承 LARK_CHANNEL=1 并进入 bridge-bound 模式。',
  '不要 unset LARK_CHANNEL / LARK_CHANNEL_HOME / LARK_CHANNEL_PROFILE / LARKSUITE_CLI_CONFIG_DIR，也不要用 env -u LARK_CHANNEL 绕回本机普通配置。',
  'Codex bridge 默认使用 danger-full-access 对齐 Claude bridge 的 bypassPermissions 行为，因此 lark-cli 应能像用户本机终端一样访问 keychain。',
  '如果提示 lark-channel context detected but not bound，停止当前操作并请用户重启 bridge 或运行 bridge doctor/preflight；不要改用普通 profile，不要自行 bind，也不要直接读取 config.json 里的账号或密钥。',
];

export interface ImPromptDeps {
  channel: LarkChannel;
  media: MediaCache;
  controls: Controls;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
}

export function createImPromptPreparer(deps: ImPromptDeps) {
  const lastRunModelByScope = new Map<string, string>();

  return async (request: ImRunRequest) => {
    const { channel, controls } = deps;
    const { batch, scope, runOptions } = request;

    const attachments = await resolveAttachments(deps, request);
    const batchIds = new Set(batch.map((m) => m.messageId));

    const quotes = await resolveQuotes(channel, request, batchIds);

    const topicContext = await resolveTopicHistory(deps, request, batchIds, quotes);

    const model = resolveModelInstructions(controls, lastRunModelByScope, scope);
    const { extraInstructions, requestedModel, modelSwitched, modelSelection } = model;
    const prompt = runOptions?.prompt !== undefined
      ? [...(extraInstructions ?? []), runOptions.prompt].filter(Boolean).join('\n\n')
      : buildPrompt({
        batch, attachments, quotes, topicContext,
        botIdentity: channel.botIdentity, extraInstructions
      });

    log.info('prompt', 'built', {
      promptChars: prompt.length,
      quotes: quotes.length,
      topicContext: topicContext.length,
      ...(modelSwitched ? { modelSwitchedTo: modelSelection } : {}),
    });

    return { prompt, attachments, requestedModel };
  };
}

function buildPrompt(input: {
  batch: NormalizedMessage[];
  attachments: LocalAttachment[];
  quotes: QuotedContext[];
  topicContext: QuotedContext[];
  botIdentity?: { openId: string; name?: string; };
  extraInstructions?: string[];
}): string {
  const { batch, attachments, quotes, topicContext, botIdentity, extraInstructions } = input;
  const first = batch[0];

  if (!first) return '';

  const context = buildPromptContext(batch, first, botIdentity);

  const userInput = buildUserInput(batch, attachments);

  return buildAgentPrompt({
    context,
    instructions:
      extraInstructions && extraInstructions.length > 0
        ? [...BRIDGE_AGENT_INSTRUCTIONS, ...extraInstructions]
        : BRIDGE_AGENT_INSTRUCTIONS,
    userInput,
    ...(topicContext.length > 0 ? { topicContext: topicContext.map(toPromptTopicMessage) } : {}),
    quotedMessages: quotes.map(toPromptQuote),
    interactiveCards: batch.map(toPromptInteractiveCard).filter(isDefined),
    attachments: attachments.map(toPromptAttachment),
  });
}

function buildUserInput(batch: NormalizedMessage[], attachments: LocalAttachment[]): string {
  const fileKeys = batch.flatMap((m) => m.resources.map((r) => r.fileKey));
  // When the debounce window merged messages (possibly from several senders —
  // common in bot-at-bot group chats), annotate each segment with its sender
  // so the agent can tell who said what. Single-message batches stay verbatim.
  const annotate = batch.length > 1;

  const texts = batch
    .map((m) => {
      const text = stripAttachmentRefs(m.content, fileKeys).trim();

      if (!text) return '';

      return annotate ? `${senderAnnotation(m)} ${text}` : text;
    })
    .filter(Boolean);

  return texts.length > 0
    ? texts.join('\n\n')
    : attachments.length > 0
      ? '请看下面的附件。'
      : '（对方发来一条没有正文的消息——通常是只 @ 了你的唤醒（ping）。请简短回应。）';
}

function buildPromptContext(
  batch: NormalizedMessage[], first: NormalizedMessage,
  botIdentity?: { openId: string; name?: string; },
): BridgePromptContext {
  const senderType = senderTypeOf(first);

  const mentions = mergeMentions(batch);

  return {
    chatId: first.chatId,
    chatType: first.chatType,
    senderId: first.senderId,
    ...(first.senderName ? { senderName: first.senderName } : {}),
    ...(senderType ? { senderType } : {}),
    ...(botIdentity?.openId ? { botOpenId: botIdentity.openId } : {}),
    ...(mentions.length > 0 ? { mentions } : {}),
    ...(first.threadId ? { threadId: first.threadId } : {}),
    messageIds: batch.map((m) => m.messageId),
    source: 'im',
  };
}

/**
 * Classify the sender as human or bot from the raw Feishu event
 * (`sender.sender_type`: 'user' = human, 'app' = bot). The normalizer drops
 * this field, so read it off `msg.raw` (`includeRawEvent: true` above).
 * Unknown / missing values return undefined — omit rather than guess.
 */
function senderTypeOf(msg: NormalizedMessage): 'user' | 'bot' | undefined {
  const raw = msg.raw as { sender?: { sender_type?: unknown; }; } | undefined;
  const senderType = raw?.sender?.sender_type;

  if (senderType === 'user') return 'user';

  if (senderType === 'app' || senderType === 'bot') return 'bot';

  return undefined;
}

function senderAnnotation(msg: NormalizedMessage): string {
  const name = msg.senderName ?? msg.senderId;

  const type = senderTypeOf(msg);

  return type ? `[${name} (${type})]:` : `[${name}]:`;
}

function mergeMentions(batch: NormalizedMessage[]): BridgePromptMention[] {
  const seen = new Set<string>();
  const out: BridgePromptMention[] = [];

  for (const msg of batch) {
    for (const mention of msg.mentions ?? []) {
      const dedupeKey = mention.openId ?? `${mention.name ?? ''}:${mention.key}`;

      if (seen.has(dedupeKey)) continue;

      seen.add(dedupeKey);
      out.push({
        ...(mention.openId ? { openId: mention.openId } : {}),
        ...(mention.name ? { name: mention.name } : {}),
        ...(mention.isBot !== undefined ? { isBot: mention.isBot } : {}),
      });
    }
  }

  return out;
}

function replyQuoteTargetForMessage(
  msg: NormalizedMessage,
  mode: ChatMode,
): string | undefined {
  const replyTo = msg.replyToMessageId;

  if (!replyTo) return undefined;

  // Feishu topic messages use root_id/parent_id as the topic root anchor even
  // for ordinary in-topic messages. Treat that as structure, not a quote.
  if (mode === 'topic' && msg.threadId && msg.rootId && replyTo === msg.rootId) {
    return undefined;
  }

  return replyTo;
}

function stripAttachmentRefs(text: string, fileKeys: string[]): string {
  if (!text || fileKeys.length === 0) return text;

  let out = text;

  for (const key of fileKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    out = out.replace(new RegExp(`!?\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), '');
    out = out.replace(
      new RegExp(
        `<\\s*(?:file|image|img|audio|video|media|folder)\\b[^>]*\\bkey\\s*=\\s*["']${escaped}["'][^>]*>`,
        'gi',
      ),
      '',
    );
  }

  return out.replace(/\n{3,}/g, '\n\n');
}

function toPromptQuote(q: QuotedContext): BridgePromptQuotedMessage {
  return {
    messageId: q.messageId,
    senderId: q.senderId,
    ...(q.senderName ? { senderName: q.senderName } : {}),
    ...(q.createdAt ? { createdAt: q.createdAt } : {}),
    rawContentType: q.rawContentType,
    content: q.content,
  };
}

function toPromptTopicMessage(q: QuotedContext): BridgePromptTopicMessage {
  return {
    messageId: q.messageId,
    senderId: q.senderId,
    ...(q.senderName ? { senderName: q.senderName } : {}),
    ...(q.senderType ? { senderType: q.senderType } : {}),
    ...(q.createdAt ? { createdAt: q.createdAt } : {}),
    rawContentType: q.rawContentType,
    content: q.content,
  };
}

function toPromptInteractiveCard(m: NormalizedMessage): BridgePromptInteractiveCard | undefined {
  if (m.rawContentType !== 'interactive') return undefined;

  const rawContent = (m.raw as { message?: { content?: unknown; }; } | undefined)
    ?.message?.content;

  if (typeof rawContent !== 'string' || rawContent.length === 0) return undefined;

  return {
    messageId: m.messageId,
    content: parseJsonOrRaw(rawContent),
  };
}

function parseJsonOrRaw(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

async function resolveAttachments(deps: ImPromptDeps, request: ImRunRequest) {
  const { media, controls } = deps;
  const { batch, runOptions } = request;

  const resourceItems = batch.flatMap((m) =>
    m.resources.map((r) => ({ messageId: m.messageId, resource: r })),
  );
  const attachments = runOptions?.prompt === undefined
    ? await media.resolve(resourceItems, controls.profileConfig.attachments)
    : [];

  if (attachments.length > 0) {
    log.info('media', 'resolved', { count: attachments.length });

    for (const attachment of attachments) {
      log.info('attachment', 'decision', {
        decision: attachment.decision,
        kind: attachment.kind,
        hash: attachment.hash,
        size: attachment.size,
        sourceMessageId: attachment.sourceMessageId,
        reason: attachment.rejectionReason,
      });
    }
  }

  return attachments;
}

async function resolveQuotes(channel: LarkChannel, request: ImRunRequest, batchIds: Set<string>) {
  const { batch, mode, runOptions } = request;
  const quoteTargets = runOptions?.prompt !== undefined
    ? []
    : [
      ...new Set(
        batch
          .map((m) => replyQuoteTargetForMessage(m, mode))
          .filter((id): id is string => Boolean(id) && !batchIds.has(id!)),
      ),
    ];
  const quotes: QuotedContext[] = [];

  for (const targetId of quoteTargets) {
    const q = await fetchQuotedContext(channel, targetId);

    if (q) {
      quotes.push(q);
      log.info('quote', 'fetched', {
        messageId: targetId,
        type: q.rawContentType,
        contentChars: q.content.length,
      });
    }
  }

  return quotes;
}

async function resolveTopicHistory(
  deps: ImPromptDeps, request: ImRunRequest, batchIds: Set<string>, quotes: QuotedContext[],
) {
  const { channel, sessions, sessionCatalog } = deps;
  const { batch, scope, mode, runOptions } = request;
  const threadId = batch[0]?.threadId;
  let topicContext: QuotedContext[] = [];

  const hasTopicSession = Boolean(sessions.getRaw(scope)?.sessionId
    || sessionCatalog?.entries().some((entry) => entry.scopeId === scope && entry.status === 'active'));

  if (runOptions?.prompt === undefined && mode === 'topic' && threadId && !hasTopicSession) {
    const exclude = new Set(batchIds);

    for (const quote of quotes) exclude.add(quote.messageId);

    const rootMessageId = batch.find((m) => Boolean(m.rootId))?.rootId;

    topicContext = await fetchTopicContext(channel, threadId, {
      maxMessages: 50,
      rootMessageId,
      excludeIds: exclude,
    });

    if (topicContext.length > 0) {
      log.info('topic', 'context-fetched', {
        scope,
        threadId,
        count: topicContext.length,
      });
    }
  }

  return topicContext;
}

function resolveModelInstructions(
  controls: Controls, lastRunModelByScope: Map<string, string>, scope: string,
) {
  const agentKind = controls.profileConfig.agentKind;
  const modelPref = controls.profileConfig.preferences.model;

  const modelSelection = normalizeModelSelection(agentKind, modelPref);

  const requestedModel = resolveModelArg(agentKind, modelPref);

  const prevModel = lastRunModelByScope.get(scope);
  const modelSwitched = prevModel !== undefined && prevModel !== modelSelection;

  lastRunModelByScope.set(scope, modelSelection);

  const extraInstructions = modelSwitched
    ? [
      `用户刚把本会话使用的模型切换为「${modelLabel(agentKind, modelPref)}」。` +
      '之前的对话里可能提到别的模型,请以当前模型为准;若被问到你用的是什么模型,据此回答。',
    ]
    : undefined;

  return { requestedModel, extraInstructions, modelSwitched, modelSelection };
}
