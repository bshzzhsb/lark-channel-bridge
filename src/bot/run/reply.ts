import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';

import type { AgentEvent } from '@/agent/types';
import { finalAnswerOnlyState } from '@/bot/cot';
import type { ImRunRequest, ImRunResult } from '@/bot/im/types';
import { addWorkingReaction, removeReaction } from '@/bot/reaction';
import type { StartRunFlowResult } from '@/bot/run-flow';
import { renderCard } from '@/card/run-renderer';
import { initialState, type RunState } from '@/card/run-state';
import { renderText } from '@/card/text-renderer';
import type { Controls } from '@/commands';
import { getMessageReplyMode, getShowToolCalls } from '@/config/schema';
import { log } from '@/core/logger';

import { consumeRun } from './consumer';
import {
  awaitRenderAwareStream,
  createLazyProgressStream,
  finalReplyState,
  recallIfEmptyStreamedReply,
  shouldOpenProgressStream,
} from './progress-stream';

const REACTION_CLEANUP_GRACE_MS = 1000;

interface ReplyInput {
  channel: LarkChannel;
  controls: Controls;
  request: ImRunRequest;
  prepared: {
    chatId: string;
    lastMsg: NormalizedMessage;
    sendOpts: { replyTo: string; replyInThread?: boolean; };
  };
  flow: Extract<StartRunFlowResult, { ok: true; }>;
  recordSession: (event: AgentEvent) => void;
  observedSession: () => { sessionId?: string; threadId?: string; };
  idleTimeoutMs?: number;
  cardRenderOptions: { signCallback?: (action: string) => string; };
}

export async function deliverRunReply(input: ReplyInput): Promise<ImRunResult | undefined> {
  const reply = createReplySession(input);
  const { channel, request, prepared } = input;
  const reactionPromise = request.cotRun.enabled || reply.replyMode === 'card' || reply.silent
    ? undefined : addWorkingReaction(channel, prepared.lastMsg.messageId);

  try {
    if (request.cotRun.enabled) {
      const cotReply = await deliverCotReply(reply);

      if (cotReply.handled) return cotReply.result;
    }

    if (reply.silent) return await deliverSilentReply(reply);

    // Completion notifications need a standalone final message in every mode,
    // including when COT is disabled or its creation failed.
    if (reply.completionMentions.length > 0) {
      const finalState = await reply.consume();
      await reply.sendFinal(finalAnswerOnlyState(reply.project(finalState)));
      return reply.resultFor(finalState);
    }

    if (reply.replyMode === 'card' || reply.replyMode === 'markdown') {
      await deliverProgressReply(reply, reply.replyMode);
    } else {
      const finalState = await reply.consume();

      await reply.sendFinal(reply.isCodex()
        ? finalAnswerOnlyState(reply.project(finalState)) : reply.project(finalState));
    }
  } catch (err) {
    log.fail('stream', err);

    const reason = err instanceof Error ? err.message : String(err);

    await request.cotRun.fail(reason);

    return { error: reason };
  } finally {
    scheduleWorkingReactionCleanup(channel, prepared.lastMsg.messageId, reactionPromise);
  }
}

function createReplySession(input: ReplyInput) {
  const { channel, controls, request, prepared, flow, cardRenderOptions } = input;
  const { scope, runOptions, cotRun } = request;
  const { chatId, sendOpts } = prepared;

  const replyMode = getMessageReplyMode(controls.cfg);
  const completionMentions = [...new Set(runOptions?.completionMentions?.filter(Boolean) ?? [])];

  log.info('flush', 'reply-mode', { mode: replyMode });

  // Subscribe before starting COT or any outbound requests so early events are retained.
  const events = flow.execution.subscribe();
  const consume = (flush: (state: RunState) => Promise<void> = async () => { }) => consumeRun({
    handle: flow.execution.handle, events, scope,
    idleTimeoutMs: input.idleTimeoutMs, recordSession: input.recordSession, flush,
  });
  const project = (state: RunState): RunState => getShowToolCalls(controls.cfg)
    ? state : { ...state, blocks: state.blocks.filter((b) => b.kind !== 'tool') };
  const sendFinal = (state: RunState) => sendFinalReply({
    channel, chatId, scope, state, replyMode, sendOpts, cardRenderOptions,
    completionMentions,
  });
  const resultFor = (state: RunState): ImRunResult => ({
    finalText: state.finalText, ...input.observedSession(), cwdRealpath: flow.cwdRealpath,
  });

  return {
    channel, chatId, scope, sendOpts, cardRenderOptions, replyMode, cotRun,
    execution: flow.execution, silent: runOptions?.reply === 'silent',
    completionMentions,
    isCodex: () => controls.profileConfig.agentKind === 'codex',
    consume, project, sendFinal, resultFor,
  };
}

type ReplySession = ReturnType<typeof createReplySession>;

async function deliverCotReply(reply: ReplySession) {
  const { cotRun, execution, scope } = reply;

  if (!await cotRun.start({ runId: execution.runId, scope })) {
    log.warn('cot', 'fallback-existing-reply', { reason: 'create-disabled' });

    return { handled: false as const };
  }

  const cotDone = cotRun.consume(execution.subscribe());

  const finalState = await reply.consume();

  await cotDone;

  if (reply.silent) {
    return { handled: true as const, result: reply.resultFor(finalState) };
  }

  if (cotRun.degradedReason) {
    await sendCotDegradedNotice({
      channel: reply.channel, chatId: reply.chatId, scope,
      sendOpts: reply.sendOpts, reason: cotRun.degradedReason,
    });
  }

  await reply.sendFinal(finalAnswerOnlyState(finalState));

  return { handled: true as const, result: undefined };
}

async function deliverSilentReply(reply: ReplySession): Promise<ImRunResult> {
  const finalState = await reply.consume();

  return {
    ...reply.resultFor(finalState),
    ...(reply.cotRun.creationFailed ? { error: '无法创建 COT' } : {}),
  };
}

async function deliverProgressReply(reply: ReplySession, mode: 'card' | 'markdown') {
  let latestState: RunState = initialState;

  const producer = createProgressProducer(reply, mode);

  const progress = createLazyProgressStream(reply.scope, mode, () => producer.open({
    abandoned: () => progress.abandoned(),
    state: () => reply.project(latestState),
    done: () => renderDone,
  }));

  const renderDone = reply.consume(async (state) => {
    latestState = state;

    const projected = reply.project(state);

    if (shouldOpenProgressStream(projected)) progress.ensureOpen();

    await producer.update(projected);
  });
  const fallback = async (state: RunState) => {
    if (reply.isCodex()) return;

    const projected = reply.project(state);

    const body = renderText(projected);

    if (!body.trim()) return;

    const content = mode === 'card'
      ? { card: renderCard(projected, reply.cardRenderOptions) } : { markdown: body };

    await reply.channel.send(reply.chatId, content, reply.sendOpts);
  };

  try {
    await awaitRenderAwareStream({
      mode, progress, renderDone, producerStarted: producer.started, fallback,
    });
  } catch (err) {
    if (!reply.isCodex()) throw err;

    log.fail('stream', err, { mode, step: 'progress-stream' });
  }

  const finalState = reply.project(latestState);

  await recallIfEmptyStreamedReply(reply.channel, progress, finalState, reply.scope);

  if (reply.isCodex()) await reply.sendFinal(finalReplyState(progress, finalState));
}

interface ProducerSource {
  abandoned(): boolean;
  state(): RunState;
  done(): Promise<RunState>;
}

function createProgressProducer(reply: ReplySession, mode: 'card' | 'markdown') {
  let started = false;
  let update: ((state: RunState) => Promise<void>) | undefined;
  const open = (source: ProducerSource) => {
    const content = mode === 'card' ? {
      card: {
        initial: renderCard(initialState, reply.cardRenderOptions),
        producer: async (ctrl: { update(next: object): Promise<void>; }) => {
          started = true;

          if (source.abandoned()) return;

          update = (state) => ctrl.update(renderCard(state, reply.cardRenderOptions));
          await update(source.state());
          await source.done();
        },
      },
    } : {
      markdown: async (ctrl: { setContent(markdown: string): Promise<void>; }) => {
        started = true;

        if (source.abandoned()) return;

        update = (state) => ctrl.setContent(renderText(state));
        await update(source.state());
        await source.done();
      },
    };

    return reply.channel.stream(reply.chatId, content, reply.sendOpts);
  };

  return {
    open, started: () => started,
    update: async (state: RunState) => { await update?.(state); },
  };
}

async function sendFinalReply(input: {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  state: RunState;
  replyMode: ReturnType<typeof getMessageReplyMode>;
  sendOpts: { replyTo: string; replyInThread?: boolean; };
  cardRenderOptions: { signCallback?: (action: string) => string; };
  completionMentions: string[];
}): Promise<void> {
  const body = renderText(input.state);

  // Nothing deliverable to send (agent produced no text on a clean finish;
  // error/interrupt/timeout keep `body` non-empty via their notices). Skip
  // rather than post an empty card that renders as "(no content)".
  if (!body.trim()) {
    log.info('outbound', 'skip-empty', { scope: input.scope, mode: input.replyMode });

    return;
  }

  const mentionIds = input.completionMentions;
  const cardState = mentionIds.length > 0 ? {
    ...input.state,
    blocks: [{ kind: 'text' as const,
      content: mentionIds.map((id) => `<at id=${JSON.stringify(id)}></at>`).join(' '), streaming: false },
      ...input.state.blocks],
  } : input.state;
  const content = input.replyMode === 'card'
    ? { card: renderCard(cardState, input.cardRenderOptions) } : { markdown: body };
  const sendOpts = input.replyMode !== 'card' && mentionIds.length > 0
    ? { ...input.sendOpts, mentions: mentionIds.map((id, index) => ({ key: `@recipient_${index}`, openId: id })) }
    : input.sendOpts;

  const result = await input.channel.send(input.chatId, content, sendOpts);

  requireMessageReceipt(result, input.replyMode);
  log.info('outbound', 'sent', outboundLogFields(input, input.replyMode, body, result));
}

function requireMessageReceipt(result: { messageId?: string; }, type: string): void {
  if (!result.messageId?.trim()) {
    throw new Error(`final ${type} reply missing message receipt`);
  }
}

async function sendCotDegradedNotice(input: {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  sendOpts: { replyTo: string; replyInThread?: boolean; };
  reason: string;
}): Promise<void> {
  log.warn('cot', 'degraded', {
    scope: input.scope,
    reason: input.reason,
    replyInThread: input.sendOpts.replyInThread === true,
  });

  try {
    await input.channel.send(
      input.chatId,
      { markdown: 'COT 过程消息更新失败，已停止展示过程；最终答案仍会继续发送。' },
      input.sendOpts,
    );
  } catch (err) {
    log.warn('cot', 'degraded-notice-failed', {
      scope: input.scope,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function outboundLogFields(
  input: {
    scope?: string;
    replyMode: ReturnType<typeof getMessageReplyMode>;
    sendOpts?: { replyTo?: string; replyInThread?: boolean; };
  },
  type: string,
  body: string,
  result?: { messageId?: string; },
): Record<string, unknown> {
  return {
    type,
    scope: input.scope,
    mode: input.replyMode,
    chars: body.length,
    messageId: result?.messageId,
    replyTo: input.sendOpts?.replyTo,
    replyInThread: input.sendOpts?.replyInThread === true,
  };
}

function scheduleWorkingReactionCleanup(
  channel: LarkChannel,
  messageId: string,
  reactionPromise: Promise<string | undefined> | undefined,
): void {
  if (!reactionPromise) return;

  void (async () => {
    const reactionResult = reactionPromise.then(
      (reactionId) => ({ ok: true as const, reactionId }),
      (err) => ({ ok: false as const, err }),
    );

    const settled = await Promise.race([
      reactionResult,
      delay(REACTION_CLEANUP_GRACE_MS).then(() => undefined),
    ]);

    if (!settled) {
      log.warn('reaction', 'cleanup-deferred', {
        messageId,
        graceMs: REACTION_CLEANUP_GRACE_MS,
      });
      void reactionResult.then((result) => {
        if (!result.ok || !result.reactionId) return;

        void removeReaction(channel, messageId, result.reactionId);
      });

      return;
    }

    if (!settled.ok || !settled.reactionId) return;

    await removeReaction(channel, messageId, settled.reactionId);
  })();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
