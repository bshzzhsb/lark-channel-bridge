import { log } from '../../core/logger';
import type { CotClient } from './client';
import type { CotEvent, CotRef } from './types';

const COT_UPDATE_THROTTLE_MS = 600;

interface CotRunContext {
  runId: string;
  scope: string;
}

export class CotPublisher {
  private readonly client: Pick<CotClient, 'create' | 'update' | 'complete'>;
  readonly chatId: string;
  readonly originMessageId: string;
  readonly replyInThread: boolean;
  readonly inputPreview: string;
  readonly stepName: string;
  ref: CotRef | undefined;
  disabled = false;
  degradedReason: string | undefined;
  private buffer: CotEvent[] = [];
  private flushing: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private finishing: Promise<void> | undefined;
  private reservation: Promise<CotRef | undefined> | undefined;
  private starting: Promise<void> | undefined;
  private context: CotRunContext | undefined;

  get runId(): string {
    if (!this.context) throw new Error('COT must start before accessing its run ID');
    return this.context.runId;
  }

  get scope(): string {
    if (!this.context) throw new Error('COT must start before accessing its scope');
    return this.context.scope;
  }

  get started(): boolean {
    return this.context !== undefined;
  }

  get finished(): boolean {
    return this.finishing !== undefined;
  }

  constructor(opts: {
    client: Pick<CotClient, 'create' | 'update' | 'complete'>;
    chatId: string;
    originMessageId: string;
    replyInThread?: boolean;
    inputPreview: string;
    stepName?: string;
  }) {
    this.client = opts.client;
    this.chatId = opts.chatId;
    this.originMessageId = opts.originMessageId;
    this.replyInThread = opts.replyInThread === true;
    this.inputPreview = opts.inputPreview;
    this.stepName = opts.stepName ?? '理解用户问题';
  }

  reserveAnchor(): Promise<CotRef | undefined> {
    // Cache failures too: the request may have created a message upstream.
    this.reservation ??= (async () => {
      try {
        const created = await this.client.create(this.chatId, this.originMessageId, this.replyInThread);
        const cotId = stringValue(created.cot_id ?? created.cotId);
        const messageId = stringValue(created.message_id ?? created.messageId);
        if (!cotId || !messageId) throw new Error('COT create response did not include cot_id and message_id');
        this.ref = { cotId, messageId };
        log.info('cot', 'created', { cotId, messageId });
        return this.ref;
      } catch (err) {
        this.disabled = true;
        log.warn('cot', 'create-failed', { err: err instanceof Error ? err.message : String(err) });
        return undefined;
      }
    })();
    return this.reservation;
  }

  start(context: CotRunContext): Promise<void> {
    this.starting ??= this.startRun(context);
    return this.starting;
  }

  private async startRun(context: CotRunContext): Promise<void> {
    if (!await this.reserveAnchor() || this.finished) return;
    this.context = context;
    this.enqueue('RUN_STARTED', {
      threadId: this.scope,
      runId: this.runId,
      input: { query: this.inputPreview },
    });
    this.enqueue('STEP_STARTED', {
      stepId: `step-understand-${this.runId}`,
      stepName: this.stepName,
    });
  }

  enqueue(eventType: string, content: unknown): void {
    if (this.disabled || !this.ref || this.finished) return;
    this.buffer.push({
      event_type: eventType,
      content: JSON.stringify(content),
      timestamp: Date.now(),
    });
    this.scheduleFlush();
  }

  finish(reason: string): Promise<void> {
    this.finishing ??= this.complete(reason);
    return this.finishing;
  }

  private async complete(reason: string): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flush();
    if (this.disabled || !this.ref) return;
    try {
      await this.client.complete(this.ref, reason);
      log.info('cot', 'completed', { cotId: this.ref.cotId, reason });
    } catch (err) {
      log.warn('cot', 'complete-failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  private scheduleFlush(): void {
    if (this.timer || this.flushing) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, COT_UPDATE_THROTTLE_MS);
  }

  private async flush(): Promise<void> {
    if (this.disabled || !this.ref) return;
    if (this.flushing) {
      await this.flushing;
      if (this.buffer.length > 0 && !this.disabled) await this.flush();
      return;
    }
    const events = this.buffer.splice(0);
    if (events.length === 0) return;
    this.flushing = this.client.update(this.ref, events)
      .catch((err) => {
        this.disabled = true;
        this.degradedReason = err instanceof Error ? err.message : String(err);
        log.warn('cot', 'update-failed', { err: this.degradedReason });
      })
      .finally(() => {
        this.flushing = undefined;
        if (this.buffer.length > 0 && !this.disabled) this.scheduleFlush();
      });
    await this.flushing;
  }
}
