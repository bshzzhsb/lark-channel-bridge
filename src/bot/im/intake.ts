import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';

import type { AgentAdapter } from '@/agent/types';
import type { ActiveRuns } from '@/bot/active-runs';
import type { ChatMode,ChatModeCache } from '@/bot/chat-mode-cache';
import type { PendingQueue } from '@/bot/pending-queue';
import type { ProcessPool } from '@/bot/process-pool';
import { replyOptions } from '@/bot/reply-placement';
import { commandSessionCatalogIdentity } from '@/bot/session-catalog-identity';
import { lookupMessageThreadContext } from '@/bot/thread-id';
import { existingRootTopicScope } from '@/bot/topic-scope';
import {
  type AgentRunRequest,
  type AgentRunResult,
  type Controls,
  tryHandleCommand,
} from '@/commands';
import type { AppConfig } from '@/config/schema';
import { log } from '@/core/logger';
import type { AccessDecision } from '@/policy/access';
import { canUseDm, canUseGroup, requireMentionForChat } from '@/policy/access';
import type { RunExecutor } from '@/runtime/run-executor';
import type { SessionCatalog } from '@/session/catalog';
import type { SessionStore } from '@/session/store';
import type { WorkspaceStore } from '@/workspace/store';

import { blockPendingScope, DEBOUNCE_MS } from './scheduler';

function sendNonAllowedGroupHint(
  channel: LarkChannel,
  msg: NormalizedMessage,
  cfg: AppConfig,
  topicGroup: boolean,
): Promise<void> {
  const text =
    '当前群尚未加入响应列表，所以 bot 不会处理消息。\n' +
    'Bot owner/管理员可在本群发 /invite group 加入白名单。';

  return sendHint(channel, msg, cfg, topicGroup, text);
}

async function sendHint(
  channel: LarkChannel,
  msg: NormalizedMessage,
  cfg: AppConfig,
  topicGroup: boolean,
  text: string,
): Promise<void> {
  const options = replyOptions(cfg, msg, topicGroup);

  try {
    await channel.send(msg.chatId, { text }, options);
  } catch (err) {
    if (options.replyInThread) throw err;

    await channel.send(msg.chatId, { text });
  }
}

/**
 * The SDK (@larksuite/channel >= 0.4.1) normalizes a merge_forward whose
 * sub-messages it could not fetch — after its own retries — to this exact
 * sentinel, rather than the empty `<forwarded_messages/>` it emits for a
 * genuinely empty forward. Distinguishing the two is the whole point of that
 * fix: pre-0.4.1 a transient Feishu 5xx/timeout on `im.v1.message.get` was
 * silently indistinguishable from empty, so the agent saw an empty forward and
 * replied "转发内容是空的，请重新转发一次".
 */
const FORWARD_FETCH_FAILED_CONTENT = '<forwarded_messages status="fetch_failed"/>';

/** True when a message is a merge_forward the SDK failed to fetch (see above). */
function isForwardFetchFailed(msg: NormalizedMessage): boolean {
  return (
    msg.rawContentType === 'merge_forward' &&
    msg.content.trim() === FORWARD_FETCH_FAILED_CONTENT
  );
}

function sendForwardFetchFailedHint(
  channel: LarkChannel,
  msg: NormalizedMessage,
  cfg: AppConfig,
  topicGroup: boolean,
): Promise<void> {
  const text =
    '这条合并转发的内容没能从飞书拉取到（上游超时/网络抖动，已自动重试仍失败），' +
    '所以我没收到里面的消息。麻烦稍后重新转发一次。';

  return sendHint(channel, msg, cfg, topicGroup, text);
}

export interface IntakeDeps {
  channel: LarkChannel;
  agent: AgentAdapter;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  pending: PendingQueue;
  controls: Controls;
  chatModeCache: ChatModeCache;
  logThreadModeOverride: LogThreadModeOverride;
  executor: RunExecutor;
  pool: ProcessPool;
  runAgent: (request: AgentRunRequest) => Promise<AgentRunResult>;
}

export type LogThreadModeOverride = (input: {
  chatId: string;
  resolvedMode: ChatMode;
  threadId: string;
}) => void;

export interface MessageRoute {
  message: NormalizedMessage;
  scope: string;
  mode: ChatMode;
}

export function createMessageIntake(deps: IntakeDeps): (msg: NormalizedMessage) => Promise<void> {
  const handleCommand = createCommandIntake(deps);

  return async (msg) => {
    const route = await resolveMessageRoute(deps, msg);

    const access = await checkResponse(deps, route);

    if (!access) return;

    if (await handleCommand(route, access)) {
      log.info('intake', 'command', { scope: route.scope });

      return;
    }

    const size = deps.pending.push(route.scope, route.message);

    log.info('intake', 'queued', { scope: route.scope, queueSize: size, debounceMs: DEBOUNCE_MS });
  };
}

async function resolveMessageRoute(deps: IntakeDeps, msg: NormalizedMessage): Promise<MessageRoute> {
  const { channel, chatModeCache, sessions, sessionCatalog, logThreadModeOverride } = deps;
  const preview = msg.content.length > 80 ? `${msg.content.slice(0, 80)}…` : msg.content;

  // Resolve scope (and underlying chat mode) once at intake — every
  // downstream consumer keys off these.
  const resolvedMode = await chatModeCache.resolve(channel, msg.chatId);

  const emsg = await recoverMessageThread(deps, msg);
  const { threadId, rootId } = emsg;

  // Some groups are converted into topic groups after creation. In that state
  // getChatMode can lag behind the message event shape, so threadId is the
  // stronger signal for topic-scoped sessions and reply routing.
  const rootScope = existingRootTopicScope({ chatId: msg.chatId, rootId, sessions, sessionCatalog });
  const chatMode = threadId || rootScope ? 'topic' : resolvedMode;

  if (msg.chatType !== 'p2p' && threadId && resolvedMode !== 'topic') {
    chatModeCache.invalidate(msg.chatId);
    logThreadModeOverride({
      chatId: msg.chatId,
      resolvedMode,
      threadId,
    });
  }

  const scope = rootScope ?? (threadId ? `${msg.chatId}:${threadId}` : msg.chatId);

  log.info('intake', 'enter', {
    scope,
    chatType: msg.chatType,
    chatMode,
    resolvedMode,
    threadId,
    msgId: msg.messageId,
    sender: msg.senderId,
    preview,
    resources: msg.resources.length,
  });

  return { message: emsg, scope, mode: chatMode };
}

async function recoverMessageThread(
  deps: Pick<IntakeDeps, 'channel' | 'controls'>, msg: NormalizedMessage,
): Promise<NormalizedMessage> {
  const { channel, controls } = deps;

  // Message events can omit thread_id / root_id, including in topic groups
  // and DMs. Recover them from the raw message before choosing the session
  // scope, reply placement, and first-engagement topic context. Skip this
  // lookup for group messages we will ignore.
  let threadId = msg.threadId;
  let rootId = msg.rootId;
  const mayRespond = msg.chatType === 'p2p' || msg.mentionedBot
    || !requireMentionForChat(controls.profileConfig, controls.cfg, msg.chatId);

  if ((!threadId || !rootId) && mayRespond) {
    const context = await lookupMessageThreadContext(channel, msg.messageId);

    threadId ??= context.threadId;
    rootId ??= context.rootId;

    if (!msg.threadId && threadId) {
      log.info('intake', 'thread-id-backfilled', {
        chatId: msg.chatId,
        msgId: msg.messageId,
        threadId,
      });
    }

    if (!msg.rootId && rootId) {
      log.info('intake', 'thread-root-backfilled', {
        chatId: msg.chatId,
        msgId: msg.messageId,
        rootId,
      });
    }
  }

  // Carry the (possibly backfilled) threadId on the message so the batched
  // flush — which reads `firstMsg.threadId` for reply routing and topic scope —
  // sees it.
  return threadId === msg.threadId && rootId === msg.rootId
    ? msg : { ...msg, threadId, rootId };
}

async function checkResponse(deps: IntakeDeps, route: MessageRoute) {
  const { channel, controls } = deps;
  const { message: msg, scope, mode: chatMode } = route;
  const accessDecision =
    msg.chatType === 'p2p'
      ? canUseDm(controls.profileConfig, controls, msg.senderId)
      : canUseGroup(controls.profileConfig, controls, msg.chatId, msg.senderId);

  if (!accessDecision.ok) {
    log.info('intake', 'skip-not-allowed-user', {
      scope,
      sender: msg.senderId.slice(-6),
      reason: accessDecision.reason,
    });

    if (msg.chatType !== 'p2p' && accessDecision.reason === 'denied-chat' && msg.mentionedBot) {
      void sendNonAllowedGroupHint(channel, msg, controls.cfg, chatMode === 'topic').catch((err) =>
        log.warn('intake', 'non-allowed-hint-failed', { err: String(err) }),
      );
    }

    return;
  }

  // Group-mention policy. p2p is always unrestricted; in groups (regular and
  // topic) we drop messages that don't @bot when the user has opted into the
  // quiet-by-default behavior. A per-chat override (set from /config's group
  // picker) takes priority over the global setting, so one group can respond
  // to everything while others stay @-only (or vice versa). Slash commands are
  // NOT exempt — the user chose strict mode so the group stays uniformly quiet
  // unless mentioned. @全员 is already filtered by SDK
  // (`respondToMentionAll: false`), so any event reaching here is either
  // targeted or undirected chatter.
  if (
    msg.chatType !== 'p2p' &&
    requireMentionForChat(controls.profileConfig, controls.cfg, msg.chatId) &&
    !msg.mentionedBot
  ) {
    log.info('intake', 'skip-no-mention', { scope, chatType: msg.chatType });

    return;
  }

  // A merge_forward whose sub-messages the SDK could not fetch (transient
  // upstream failure, already retried inside @larksuite/channel) arrives as the
  // fetch_failed sentinel. Feeding it to the agent would read as an empty
  // forward, so surface a recoverable hint and skip the run — the user can
  // resend once the upstream recovers.
  if (isForwardFetchFailed(msg)) {
    log.warn('intake', 'forward-fetch-failed', {
      scope,
      msgId: msg.messageId,
      chatType: msg.chatType,
    });
    await sendForwardFetchFailedHint(channel, msg, controls.cfg, chatMode === 'topic').catch((err) =>
      log.warn('intake', 'forward-fetch-failed-hint-failed', { err: String(err) }),
    );

    return;
  }

  return accessDecision;
}

function createCommandIntake(deps: IntakeDeps) {
  const { channel, sessions, workspaces, agent, activeRuns, sessionCatalog,
    executor, runAgent, pool, controls, pending } = deps;
  const commandDeps = {
    channel, sessions, workspaces, agent, activeRuns, sessionCatalog,
    runExecutor: executor, runAgent, processPool: pool, controls,
    clearPending: (scope: string) => { pending.cancel(scope); },
  };

  return async (route: MessageRoute, access: AccessDecision): Promise<boolean> => {
    const { message: msg, scope, mode: chatMode } = route;
    const release = msg.content.trim().startsWith('/') ? blockPendingScope(pending, scope) : undefined;

    try {
      const sessionCatalogIdentity = await commandSessionCatalogIdentity({
        msg, scope, mode: chatMode, workspaces, controls, access,
      });

      return await tryHandleCommand({ ...commandDeps, msg, scope, chatMode, sessionCatalogIdentity });
    } finally {
      release?.();
    }
  };
}
