import { dirname, join } from 'node:path';

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
import { getMaxConcurrentRuns } from '@/config/schema';
import { resolveAppSecret } from '@/config/secret-resolver';
import { log } from '@/core/logger';
import { MediaCache } from '@/media/cache';
import { RunExecutor } from '@/runtime/run-executor';

import { bindChannelEvents } from './events';
import { createBridgeSdk } from './sdk';
import type { StartChannelDeps } from './types';

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

export async function createChannelRuntime(deps: StartChannelDeps) {
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

export type ChannelRuntime = Awaited<ReturnType<typeof createChannelRuntime>>;

export function bindRuntimeHandlers(
  deps: StartChannelDeps, runtime: ChannelRuntime, isActive: () => boolean,
) {
  const { channel, activeRuns, chatModeCache, pool, executor, callbackAuth,
    pending, runAgent, logThreadModeOverride, policyFingerprintForScope } = runtime;
  const { agent, sessions, sessionCatalog, workspaces, controls } = deps;

  bindChannelEvents({
    channel, agent, sessions, sessionCatalog, workspaces, controls,
    activeRuns, chatModeCache, pool, executor, callbackAuth,
    pending, runAgent, logThreadModeOverride, policyFingerprintForScope, isActive,
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
