import type { LarkChannel } from '@larksuite/channel';

import { dirname, join } from 'node:path';

import type { AgentAdapter } from '@/agent/types';
import { ActiveRuns } from '@/bot/active-runs';
import { ChatModeCache } from '@/bot/chat-mode-cache';
import { CotClient } from '@/bot/cot';
import type { LogThreadModeOverride } from '@/bot/im/intake';
import { createImRunner } from '@/bot/im/runner';
import { createBatchScheduler } from '@/bot/im/scheduler';
import { createOnboardOrchestrator } from '@/bot/onboard-orchestrator';
import { ProcessPool } from '@/bot/process-pool';
import { CallbackAuth } from '@/card/callback-auth';
import { CallbackNonceStore } from '@/card/callback-store';
import type { Controls } from '@/commands';
import type { AppPaths } from '@/config/app-paths';
import type { AppConfig } from '@/config/schema';
import { getMaxConcurrentRuns } from '@/config/schema';
import { resolveAppSecret } from '@/config/secret-resolver';
import { log } from '@/core/logger';
import { MediaCache } from '@/media/cache';
import { RunExecutor } from '@/runtime/run-executor';
import type { SessionCatalog } from '@/session/catalog';
import type { SessionStore } from '@/session/store';
import type { WorkspaceStore } from '@/workspace/store';

import { bindChannelEvents } from './events';
import { createBridgeSdk } from './sdk';
import { createChannelServices } from './services';

export interface BridgeChannel {
  channel: LarkChannel;
  disconnect(): Promise<void>;
}

export interface StartChannelDeps {
  cfg: AppConfig;
  agent: AgentAdapter;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  controls: Controls;
  appPaths?: Pick<AppPaths, 'secretsFile' | 'keystoreSaltFile' | 'mediaDir'>;
}

export { shouldSuppressSdkErrorLog } from './sdk';

export async function startChannel(deps: StartChannelDeps): Promise<BridgeChannel> {
  const runtime = await createChannelRuntime(deps);

  bindRuntimeHandlers(deps, runtime);

  const services = createChannelServices({
    channel: runtime.channel, cfg: deps.cfg, controls: deps.controls,
    executor: runtime.executor, activeRuns: runtime.activeRuns,
    sessions: deps.sessions, sessionCatalog: deps.sessionCatalog, workspaces: deps.workspaces,
  });

  await runtime.channel.connect();
  await services.start();

  announceConnection(deps, runtime.channel);
  services.startKeepalive();

  return {
    channel: runtime.channel,
    disconnect: () => disconnectChannel(deps, runtime, services),
  };
}

async function createCallbackAuth(deps: StartChannelDeps, appSecret: string) {
  const callbackNonceStore = deps.appPaths?.mediaDir
    ? new CallbackNonceStore(join(dirname(deps.appPaths.mediaDir), 'callback-nonces.json'))
    : undefined;

  await callbackNonceStore?.load();

  const callbackAuth = callbackNonceStore
    ? new CallbackAuth({
      keys: [{ version: 1, secret: appSecret }],
      nonceStore: callbackNonceStore,
    })
    : undefined;

  return { callbackAuth, callbackNonceStore };
}

async function createChannelRuntime(deps: StartChannelDeps) {
  const { cfg, agent, sessions, sessionCatalog, workspaces, controls } = deps;
  const activeRuns = new ActiveRuns();
  const chatModeCache = new ChatModeCache();
  const pool = new ProcessPool(() => getMaxConcurrentRuns(controls.cfg));
  const executor = new RunExecutor({ agent, pool, activeRuns });

  const appSecret = await resolveAppSecret(cfg, deps.appPaths);

  const { callbackAuth, callbackNonceStore } = await createCallbackAuth(deps, appSecret);

  const channel = createBridgeSdk(cfg, appSecret);
  const media = new MediaCache(channel, deps.appPaths?.mediaDir);
  const cotClient = new CotClient({ tenant: cfg.accounts.app.tenant, appId: cfg.accounts.app.id, appSecret });

  const runner = createImRunner({
    channel, executor, sessions, sessionCatalog, workspaces, media, controls, callbackAuth,
  });

  const logThreadModeOverride = createThreadModeLogger();

  const pending = createBatchScheduler({
    channel, controls, sessions, chatModeCache, cotClient, logThreadModeOverride, run: runner.run,
  });

  const runAgent = createOnboardOrchestrator({
    channel, controls, cotClient, pending, sessions, workspaces,
    execute: ({ message, ...request }) => runner.run({ ...request, batch: [message] }),
  });

  return {
    channel, activeRuns, chatModeCache, pool, executor, callbackAuth, callbackNonceStore,
    pending, runAgent, logThreadModeOverride, policyFingerprintForScope: runner.policyFingerprintForScope,
  };
}

type ChannelRuntime = Awaited<ReturnType<typeof createChannelRuntime>>;

function bindRuntimeHandlers(deps: StartChannelDeps, runtime: ChannelRuntime) {
  const { channel, activeRuns, chatModeCache, pool, executor, callbackAuth,
    pending, runAgent, logThreadModeOverride, policyFingerprintForScope } = runtime;
  const { agent, sessions, sessionCatalog, workspaces, controls } = deps;

  bindChannelEvents({
    channel, agent, sessions, sessionCatalog, workspaces, controls,
    activeRuns, chatModeCache, pool, executor, callbackAuth,
    pending, runAgent, logThreadModeOverride, policyFingerprintForScope,
  });
}

function createThreadModeLogger(): LogThreadModeOverride {
  const threadModeOverrideWarnedChats = new Set<string>();
  const logThreadModeOverride: LogThreadModeOverride = ({ chatId, resolvedMode, threadId }) => {
    const fields = { chatId, cachedMode: resolvedMode, threadId };

    if (threadModeOverrideWarnedChats.has(chatId)) {
      log.info('chat', 'mode-overridden-by-thread', fields);

      return;
    }

    threadModeOverrideWarnedChats.add(chatId);
    log.warn('chat', 'mode-overridden-by-thread', fields);
  };

  return logThreadModeOverride;
}

function announceConnection(deps: StartChannelDeps, channel: LarkChannel) {
  const { agent, cfg, controls } = deps;
  const identity = channel.botIdentity;

  // Late-bind the bot's own IM identity into the agent adapter so the system
  // prompt can state "this open_id is you" with the real value. Covers both
  // initial start and credential-swap reconnects (both go through here).
  if (identity?.openId) {
    agent.setBotIdentity?.({
      openId: identity.openId,
      ...(identity.name ? { name: identity.name } : {}),
    });
  }

  log.info('ws', 'connected', {
    bot: identity?.name ?? 'unknown',
    openId: identity?.openId ?? '-',
    agent: `${agent.displayName} (${agent.id})`,
    appId: cfg.accounts.app.id,
    procId: controls.processId,
  });
  console.log('正在监听消息。按 Ctrl+C 退出。\n');
}

async function disconnectChannel(
  deps: StartChannelDeps, runtime: ChannelRuntime,
  services: ReturnType<typeof createChannelServices>,
) {
  const { channel, activeRuns, pending, callbackNonceStore } = runtime;
  const { sessions, sessionCatalog, workspaces } = deps;

  activeRuns.pauseNewRuns('bridge-disconnect');
  services.stop();
  pending.cancelAll();

  const [disconnectResult, stopAllResult, ...flushResults] = await Promise.allSettled([
    channel.disconnect(),
    activeRuns.stopAll(),
    sessions.flush(),
    sessionCatalog?.flush(),
    callbackNonceStore?.flush(),
    workspaces.flush(),
  ]);

  if (stopAllResult.status === 'rejected') {
    log.fail('disconnect', stopAllResult.reason, { step: 'stopAll' });
  }

  for (const [idx, result] of flushResults.entries()) {
    if (result.status === 'rejected') {
      log.fail('disconnect', result.reason, { step: `flush-${idx}` });
    }
  }

  if (disconnectResult.status === 'rejected') {
    throw disconnectResult.reason;
  }
}
