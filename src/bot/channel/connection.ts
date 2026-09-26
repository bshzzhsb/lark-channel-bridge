import { log } from '@/core/logger';

import { bindRuntimeHandlers, type ChannelRuntime, createChannelRuntime } from './runtime';
import { createChannelServices } from './services';
import type { BridgeChannel, StartChannelDeps } from './types';

/** Owns one connection. Profile configuration and reconnects belong to the supervisor. */
export class ChannelConnection implements BridgeChannel {
  private services?: ReturnType<typeof createChannelServices>;
  private startPromise?: Promise<void>;
  private startupTask?: Promise<void>;
  private disconnectPromise?: Promise<void>;
  private acceptingEvents = false;

  private constructor(
    private readonly deps: StartChannelDeps,
    private readonly runtime: ChannelRuntime,
  ) {}

  static async create(deps: StartChannelDeps): Promise<ChannelConnection> {
    return new ChannelConnection(deps, await createChannelRuntime(deps));
  }

  get channel() {
    return this.runtime.channel;
  }

  start(): Promise<void> {
    if (this.disconnectPromise) {
      return Promise.reject(new Error('cannot start a disconnected channel; create a new connection'));
    }

    return this.startPromise ??= this.startWithRollback();
  }

  readonly disconnect = (): Promise<void> => {
    this.acceptingEvents = false;

    return this.disconnectPromise ??= this.stop();
  };

  private async startWithRollback(): Promise<void> {
    this.startupTask = this.connect();

    try {
      await this.startupTask;
    } catch (err) {
      // Preserve the startup error even if rollback also fails.
      await this.disconnect().catch((cleanupError) =>
        log.fail('disconnect', cleanupError, { step: 'startup-rollback' }));
      throw err;
    }
  }

  private async connect(): Promise<void> {
    const { cfg, controls, sessions, sessionCatalog, workspaces } = this.deps;
    const { channel, executor, activeRuns } = this.runtime;

    this.services = createChannelServices({
      channel, executor, activeRuns,
      cfg, controls, sessions, sessionCatalog, workspaces,
    });
    bindRuntimeHandlers(this.deps, this.runtime, () => this.acceptingEvents);
    this.services.bind();
    this.acceptingEvents = true;

    await this.channel.connect();
    if (!this.acceptingEvents) return;

    await this.services.start();
    if (!this.acceptingEvents) return;

    announceConnection(this.deps, this.channel);
    this.services.startKeepalive();
  }

  private async stop(): Promise<void> {
    const { activeRuns, pending } = this.runtime;

    activeRuns.pauseNewRuns('bridge-disconnect');
    pending.cancelAll();

    // A connect or service start already in flight must settle before cleanup.
    // Wait for the raw startup task so rollback cannot wait on itself.
    await this.startupTask?.catch(() => undefined);

    const results = await Promise.allSettled([
      Promise.resolve().then(() => this.services?.stop()),
      Promise.resolve().then(() => this.channel.disconnect()),
      Promise.resolve().then(() => activeRuns.stopAll()),
    ]);

    // Flush after agent stop requests have settled, rather than racing them.
    await this.flushStores();

    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        log.fail('disconnect', result.reason, { step: ['services', 'channel', 'stopAll'][index] });
      }
    }

    const disconnectResult = results[1]!;
    if (disconnectResult.status === 'rejected') throw disconnectResult.reason;
  }

  private async flushStores(): Promise<void> {
    const { sessions, sessionCatalog, workspaces } = this.deps;
    const { callbackNonceStore } = this.runtime;
    const stores = { sessions, sessionCatalog, callbackNonceStore, workspaces };

    await Promise.all(Object.entries(stores).map(async ([step, store]) => {
      try {
        await store?.flush();
      } catch (err) {
        log.fail('disconnect', err, { step });
      }
    }));
  }
}

function announceConnection(deps: StartChannelDeps, channel: BridgeChannel['channel']) {
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
