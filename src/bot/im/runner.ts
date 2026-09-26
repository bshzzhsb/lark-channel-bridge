import type { LarkChannel } from '@larksuite/channel';

import { claudeCapability, codexCapability } from '@/agent/capability';
import type { AgentEvent } from '@/agent/types';
import { replyOptions } from '@/bot/reply-placement';
import { deliverRunReply } from '@/bot/run/reply';
import type { StartRunFlowResult } from '@/bot/run-flow';
import { recordRunSessionEvent, startRunFlow } from '@/bot/run-flow';
import { policyThreadId } from '@/bot/topic-scope';
import type { CallbackAuth } from '@/card/callback-auth';
import type { Controls } from '@/commands';
import { getAgentStopGraceMs, getRunIdleTimeoutMs } from '@/config/schema';
import { log } from '@/core/logger';
import { toPolicyAttachment } from '@/media/attachment';
import type { MediaCache } from '@/media/cache';
import { canUseDm, canUseGroup } from '@/policy/access';
import type { ScopeContext } from '@/policy/run-policy';
import type { RunExecutor } from '@/runtime/run-executor';
import type { SessionCatalog } from '@/session/catalog';
import type { SessionStore } from '@/session/store';
import type { WorkspaceStore } from '@/workspace/store';

import { createImPromptPreparer } from './prompt';
import type { ImRunner,ImRunRequest, ImRunResult } from './types';

export interface ImRunnerDeps {
  channel: LarkChannel;
  executor: RunExecutor;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  media: MediaCache;
  controls: Controls;
  callbackAuth?: CallbackAuth;
}

export function createImRunner(deps: ImRunnerDeps) {
  const preparePrompt = createImPromptPreparer(deps);
  const activePolicyFingerprints = new Map<string, string>();
  const run: ImRunner = async (request) => {
    try {
      return await executeImRun(deps, request, preparePrompt, activePolicyFingerprints);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);

      await request.cotRun.fail(reason, 'agent-run-failed', { scope: request.scope });
      throw err;
    } finally {
      activePolicyFingerprints.delete(request.scope);
      await request.cotRun.finish('done');
    }
  };

  return { run, policyFingerprintForScope: (scope: string) => activePolicyFingerprints.get(scope) };
}

async function prepareImRun(
  deps: ImRunnerDeps, request: ImRunRequest,
  preparePrompt: ReturnType<typeof createImPromptPreparer>,
) {
  const { channel, controls, workspaces } = deps;
  const { batch, scope, mode, runOptions } = request;
  const firstMsg = batch[0];
  const lastMsg = batch[batch.length - 1];

  if (!firstMsg || !lastMsg) return;

  const chatId = firstMsg.chatId;
  const threadId = firstMsg.threadId;

  if (scope.startsWith(`${chatId}:root:`) && !workspaces.cwdFor(scope)) {
    const inheritedCwd = workspaces.cwdFor(chatId);

    if (inheritedCwd) workspaces.setCwd(scope, inheritedCwd);
  }

  const prompt = await preparePrompt(request);
  // Existing topics always stay threaded; ordinary group and DM messages
  // follow their independent profile preferences.
  const sendOpts = runOptions?.sendOpts ?? replyOptions(controls.cfg, lastMsg, mode === 'topic');

  log.info('flush', 'reply-target', {
    scope,
    mode,
    chatId,
    threadId,
    replyTo: sendOpts.replyTo,
    replyInThread: sendOpts.replyInThread === true,
  });

  const accessDecision =
    firstMsg.chatType === 'p2p'
      ? canUseDm(controls.profileConfig, controls, firstMsg.senderId)
      : canUseGroup(controls.profileConfig, controls, firstMsg.chatId, firstMsg.senderId);
  const scopeContext: ScopeContext = {
    source: 'im',
    chatId,
    actorId: firstMsg.senderId,
    ...(policyThreadId(scope, chatId, threadId)
      ? { threadId: policyThreadId(scope, chatId, threadId) } : {}),
  };
  const profileCapability =
    controls.profileConfig.agentKind === 'codex'
      ? codexCapability(controls.profileConfig)
      : claudeCapability(controls.profileConfig);
  const capability = runOptions?.access === 'read-only'
    ? { ...profileCapability, permissions: { ...profileCapability.permissions, maxAccess: 'read-only' as const } }
    : profileCapability;

  return { ...prompt, firstMsg, lastMsg, chatId, sendOpts, accessDecision, scopeContext, capability };
}

type PreparedImRun = NonNullable<Awaited<ReturnType<typeof prepareImRun>>>;

function submitImRun(deps: ImRunnerDeps, request: ImRunRequest, prepared: PreparedImRun) {
  const { controls, sessions, sessionCatalog, workspaces, executor } = deps;
  const { scope, runOptions } = request;
  const { scopeContext, prompt, attachments, accessDecision, capability } = prepared;

  return startRunFlow({
    scopeId: scope,
    scope: scopeContext,
    prompt,
    attachments: attachments.map(toPolicyAttachment),
    access: accessDecision,
    capability,
    profileConfig: controls.profileConfig,
    sessions,
    sessionCatalog,
    workspaces,
    executor,
    now: Date.now(),
    stopGraceMs: getAgentStopGraceMs(controls.cfg),
    observability: {
      profile: controls.profile,
      agent: capability.agentId,
      source: 'im',
      stage: runOptions?.stage ?? 'submit',
    },
  });
}

async function reportRejection(
  deps: ImRunnerDeps, request: ImRunRequest, prepared: PreparedImRun,
  flow: Extract<StartRunFlowResult, { ok: false; }>,
) {
  const { channel } = deps;
  const { scope, cotRun, runOptions } = request;
  const { chatId, sendOpts } = prepared;

  log.info('run-flow', 'rejected', { scope, code: flow.rejectReason.code });
  log.warn('policy', 'denied', {
    scope,
    source: 'im',
    code: flow.rejectReason.code,
  });
  await cotRun.fail(flow.rejectReason.userVisible, flow.rejectReason.code, { scope });

  const errorReported = runOptions?.reply !== 'silent';

  if (errorReported) {
    await channel.send(chatId, { markdown: flow.rejectReason.userVisible }, sendOpts);
  }

  return { error: flow.rejectReason.userVisible, errorReported };
}

async function executeImRun(
  deps: ImRunnerDeps, request: ImRunRequest,
  preparePrompt: ReturnType<typeof createImPromptPreparer>,
  activePolicyFingerprints: Map<string, string>,
): Promise<ImRunResult | undefined> {
  const prepared = await prepareImRun(deps, request, preparePrompt);

  if (!prepared) return;

  const flow = await submitImRun(deps, request, prepared);

  if (!flow.ok) return reportRejection(deps, request, prepared, flow);

  activePolicyFingerprints.set(request.scope, flow.policy.policyFingerprint);

  const observer = createSessionObserver(deps, request, prepared, flow);

  const idleTimeoutMs = resolveIdleTimeout(deps, request.scope);

  const cardRenderOptions = createCardRenderOptions(deps, request, prepared, flow);

  return deliverRunReply({
    channel: deps.channel, controls: deps.controls, request, prepared, flow,
    recordSession: observer.record, observedSession: observer.result,
    idleTimeoutMs, cardRenderOptions,
  });
}

function createSessionObserver(
  deps: ImRunnerDeps, request: ImRunRequest, prepared: PreparedImRun,
  flow: Extract<StartRunFlowResult, { ok: true; }>,
) {
  const { sessions, sessionCatalog } = deps;
  const { scope, runOptions } = request;
  const { capability, requestedModel } = prepared;
  const cwd = flow.cwdRealpath;

  if (flow.resumeFrom) {
    log.info('session', 'resume', { sessionId: flow.resumeFrom, cwd });
  } else {
    log.info('session', 'fresh', { cwd });
  }

  let observedSessionId: string | undefined;
  let observedThreadId: string | undefined;
  const recordSession = (evt: AgentEvent): void => {
    if (evt.type === 'system' || evt.type === 'done') {
      observedSessionId = evt.sessionId ?? observedSessionId;
      observedThreadId = evt.threadId ?? observedThreadId;
    }

    if (runOptions?.persistSession === false) return;

    recordRunSessionEvent({
      scopeId: scope,
      sessions,
      sessionCatalog,
      capability,
      policy: flow.policy,
      event: evt,
    });

    if (evt.type === 'system' && evt.sessionId) {
      log.info('session', 'set', { sessionId: evt.sessionId });
    }

    // Ground truth for "which model is actually running": claude reports the
    // model it loaded in its init event. Logging requested-vs-actual reveals
    // whether the --model pin took effect or claude silently fell back (e.g.
    // an id this claude build/account doesn't recognize).
    if (evt.type === 'system' && evt.model) {
      log.info('session', 'model', {
        requested: requestedModel ?? 'default',
        actual: evt.model,
      });
    }

    if (evt.type === 'system' && evt.threadId) {
      log.info('session', 'set-thread', { threadId: evt.threadId });
    }
  };

  return {
    record: recordSession,
    result: () => ({ sessionId: observedSessionId, threadId: observedThreadId }),
  };
}

function resolveIdleTimeout(deps: ImRunnerDeps, scope: string) {
  const { sessions, controls } = deps;

  const scopeOverride = sessions.getIdleTimeoutMinutes(scope);
  const idleTimeoutMs =
    scopeOverride !== undefined
      ? scopeOverride > 0
        ? scopeOverride * 60_000
        : undefined
      : getRunIdleTimeoutMs(controls.cfg);

  if (idleTimeoutMs) {
    log.info('flush', 'idle-watchdog', { idleTimeoutMs });
  }

  return idleTimeoutMs;
}

function createCardRenderOptions(
  deps: ImRunnerDeps, request: ImRunRequest, prepared: PreparedImRun,
  flow: Extract<StartRunFlowResult, { ok: true; }>,
) {
  const { callbackAuth } = deps;
  const { scope } = request;
  const { chatId, firstMsg } = prepared;
  const { execution } = flow;
  const cardRenderOptions = callbackAuth
    ? {
      signCallback: (action: string) =>
        callbackAuth.sign({
          runId: execution.runId,
          scope,
          chatId,
          operatorOpenId: firstMsg.senderId,
          action,
          policyFingerprint: flow.policy.policyFingerprint,
          ttlMs: 24 * 60 * 60 * 1000,
        }),
    }
    : {};

  return cardRenderOptions;
}
