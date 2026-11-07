import { runJsonlProcess } from '@/agent/exec-jsonl';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '@/agent/lark-channel-env';
import type { AgentAvailability } from '@/agent/preflight';
import type { AgentAdapter, AgentBotIdentity, AgentRun, AgentRunOptions } from '@/agent/types';
import type { SandboxMode } from '@/config/profile-schema';
import { mergeProcessEnv } from '@/platform/spawn';
import { SpawnFailed } from '@/runtime/errors';

import { buildTraeArgs } from './argv';
import { withTraeLoginHint } from './diagnostics';
import { TraeJsonlTranslator } from './jsonl';
import { checkTraeAvailability } from './preflight';

export interface TraeAdapterOptions {
  binary: string;
  sandbox?: SandboxMode;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

export class TraeAdapter implements AgentAdapter {
  readonly id = 'trae';
  readonly displayName = 'TRAE CLI';
  private botIdentity: AgentBotIdentity | undefined;

  constructor(private readonly options: TraeAdapterOptions) {}

  setBotIdentity(identity: AgentBotIdentity): void { this.botIdentity = identity; }

  async isAvailable(): Promise<boolean> { return (await this.checkAvailability()).ok; }

  checkAvailability(): Promise<AgentAvailability> { return checkTraeAvailability(this.options.binary); }

  async prepareRun(): Promise<void> {
    const result = await this.checkAvailability();
    if (!result.ok) {
      throw new SpawnFailed('traecli check failed', result.error, result.diagnostic.code, result.diagnostic);
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('cwd is required for TraeAdapter.run');
    return runJsonlProcess({
      binary: this.options.binary,
      args: buildTraeArgs({
        cwd: opts.cwd, sandbox: opts.sandbox ?? this.options.sandbox ?? 'danger-full-access',
        threadId: opts.threadId, images: opts.images, model: opts.model,
      }),
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.options.larkChannel)),
      opts, translator: new TraeJsonlTranslator(), agentName: 'traecli',
      verifyExitBeforeDone: true,
      formatError: withTraeLoginHint,
      botIdentity: this.botIdentity, stopGraceMs: this.options.stopGraceMs,
    });
  }
}
