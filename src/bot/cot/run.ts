import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../../agent/types';
import type { CotMessagesMode } from '../../config/schema';
import { consumeCotEvents } from './events';
import { CotPublisher } from './publisher';
import type { CotClient } from './client';
import type { CotRef } from './types';

interface RunCotContext {
  scope: string;
  runId?: string;
}

/** One COT lifecycle, whether its message is reserved before or created after agent startup. */
export class RunCot {
  private readonly publisher: CotPublisher;
  private suppressed = false;

  constructor(private readonly opts: {
    client: Pick<CotClient, 'create' | 'update' | 'complete'>;
    mode: () => CotMessagesMode;
    chatId: string;
    originMessageId: string;
    replyInThread: boolean;
    scope: string;
    inputPreview: string;
    stepName?: string;
    detail?: CotMessagesMode;
  }) {
    this.publisher = new CotPublisher(opts);
  }

  get enabled(): boolean {
    return Boolean(this.publisher.ref)
      || (!this.suppressed && !this.publisher.disabled && this.opts.mode() !== 'off');
  }

  get creationFailed(): boolean {
    return this.publisher.disabled && !this.publisher.ref;
  }

  get degradedReason(): string | undefined {
    return this.publisher.degradedReason;
  }

  async reserveAnchor(): Promise<CotRef | undefined> {
    if (!this.enabled) {
      this.suppressed = true;
      return undefined;
    }
    return this.publisher.reserveAnchor();
  }

  async start(context: RunCotContext): Promise<boolean> {
    if (!await this.reserveAnchor()) return false;
    await this.publisher.start({
      scope: context.scope,
      runId: context.runId ?? randomUUID(),
    });
    return this.publisher.started && !this.publisher.disabled;
  }

  async consume(events: AsyncIterable<AgentEvent>): Promise<void> {
    if (!this.publisher.started) throw new Error('COT must start before consuming agent events');
    const mode = this.opts.mode();
    await consumeCotEvents(events, this.publisher, {
      detail: this.opts.detail ?? (mode === 'off' ? 'brief' : mode),
    });
  }

  async fail(message: string, code = 'agent-run-failed', context?: RunCotContext): Promise<void> {
    // Ordinary startup failures have no COT yet. Only close an existing message.
    if (!this.publisher.ref) return;
    await this.start(context ?? { scope: this.opts.scope });
    const publisher = this.publisher;
    if (publisher.finished) return;
    publisher.enqueue('RUN_ERROR', { message, code });
    await this.finish('error');
  }

  async finish(reason: string): Promise<void> {
    if (this.publisher.ref) await this.publisher.finish(reason);
  }
}
