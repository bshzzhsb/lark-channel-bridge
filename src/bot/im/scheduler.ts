import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';

import type { ChatModeCache } from '@/bot/chat-mode-cache';
import { type CotClient, RunCot } from '@/bot/cot';
import { PendingQueue } from '@/bot/pending-queue';
import { replyOptions } from '@/bot/reply-placement';
import { rootTopicScope } from '@/bot/topic-scope';
import type { Controls } from '@/commands';
import { getCotMessages } from '@/config/schema';
import { log, withTrace } from '@/core/logger';
import type { SessionStore } from '@/session/store';

import type { LogThreadModeOverride } from './intake';
import type { ImRunner } from './types';

export const DEBOUNCE_MS = 600;

export function blockPendingScope(pending: PendingQueue, scope: string): () => void {
  pending.block(scope);

  let released = false;

  return () => {
    if (released) return;

    released = true;
    pending.unblock(scope);
  };
}

interface SchedulerDeps {
  channel: LarkChannel;
  controls: Pick<Controls, 'cfg'>;
  sessions: Pick<SessionStore, 'markTopicRoot'>;
  chatModeCache: ChatModeCache;
  cotClient: CotClient;
  logThreadModeOverride: LogThreadModeOverride;
  run: ImRunner;
}

export function createBatchScheduler(deps: SchedulerDeps): PendingQueue {
  const pending = new PendingQueue(DEBOUNCE_MS, (scope, batch) => {
    const first = batch[0];

    if (!first) return;

    const release = blockPendingScope(pending, scope);

    void withTrace({ chatId: first.chatId }, () => flushBatch(deps, pending, scope, batch, release));
  });

  return pending;
}

async function resolveBatchRoute(deps: SchedulerDeps, scope: string, batch: NormalizedMessage[]) {
  const { channel, controls, sessions, chatModeCache, logThreadModeOverride } = deps;
  const firstMsg = batch[0]!;

  const resolvedMode = await chatModeCache.resolve(channel, firstMsg.chatId);
  // Feishu/Lark converted topic groups may still resolve as `group` from
  // the chat info API/cache, while message events already carry threadId.
  // Treat threadId as authoritative for IM messages so scope and replies
  // stay isolated per topic.
  const mode = firstMsg.threadId || scope.startsWith(`${firstMsg.chatId}:root:`)
    ? 'topic' : resolvedMode;

  if (firstMsg.chatType !== 'p2p' && firstMsg.threadId && resolvedMode !== 'topic') {
    chatModeCache.invalidate(firstMsg.chatId);
    logThreadModeOverride({
      chatId: firstMsg.chatId,
      resolvedMode,
      threadId: firstMsg.threadId,
    });
  }

  const lastMsg = batch[batch.length - 1]!;

  const sendOpts = replyOptions(controls.cfg, lastMsg, mode === 'topic');
  // Start a new topic's session with the triggering message. The normal
  // prompt path still includes that message and any message it quotes;
  // later replies resolve to this same scope and resume the session.
  const opensReplyTopic = !scope.startsWith(`${firstMsg.chatId}:root:`)
    && !firstMsg.threadId
    && sendOpts.replyInThread;
  const runScope = opensReplyTopic ? rootTopicScope(firstMsg.chatId, lastMsg.messageId) : scope;

  if (opensReplyTopic) sessions.markTopicRoot(runScope);

  return { mode, runScope, sendOpts };
}

async function flushBatch(
  deps: SchedulerDeps, pending: PendingQueue, scope: string,
  batch: NormalizedMessage[], release: () => void,
) {
  const first = batch[0]!;
  const last = batch[batch.length - 1]!;
  let releaseRunScope: (() => void) | undefined;

  log.info('flush', 'start', {
    scope, batchSize: batch.length, chatId: first.chatId,
    threadId: first.threadId, msgId: first.messageId,
  });

  try {
    const { mode, runScope, sendOpts } = await resolveBatchRoute(deps, scope, batch);

    if (runScope !== scope) releaseRunScope = blockPendingScope(pending, runScope);

    const cotRun = new RunCot({
      client: deps.cotClient, mode: () => getCotMessages(deps.controls.cfg),
      chatId: first.chatId, originMessageId: last.messageId,
      replyInThread: sendOpts.replyInThread, scope: runScope, inputPreview: last.content,
    });

    await deps.run({ batch, scope: runScope, mode, cotRun });
  } catch (err) {
    log.fail('flush', err);
  } finally {
    releaseRunScope?.();
    release();
    log.info('flush', 'end');
  }
}
