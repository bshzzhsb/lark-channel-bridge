import type { LarkChannel } from '@larksuite/channel';

import type { AgentRunContextMessage } from '@/agent/prompt';
import { log } from '@/core/logger';

import { type FeishuMessageItem, fetchFeishuMessageItems, normalizeItemToQuoted } from './quote';

const MAX_MESSAGES = 20;
const MAX_CHARS = 6000;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Topic replies belong to their own conversation, rather than group background. */
export function isGroupContextItem(item: FeishuMessageItem): boolean {
  return Boolean(item.message_id && !item.deleted && !item.parent_id
    && (!item.root_id || item.root_id === item.message_id)
    && Number.isFinite(Number(item.create_time)));
}

/** A scan-local cache; a live task uses a fresh instance. Nothing is persisted. */
export class GuardMessageContext {
  private readonly items = new Map<string, FeishuMessageItem>();
  private readonly normalized = new Map<string, Promise<AgentRunContextMessage | undefined>>();
  private coveredFrom: number;
  private canFetch = true;

  constructor(
    private readonly channel: LarkChannel,
    private readonly list: (limit: number, after: number, before: number) => Promise<FeishuMessageItem[]>,
    snapshot: FeishuMessageItem[] = [],
  ) {
    for (const item of snapshot) if (item.message_id) this.items.set(item.message_id, item);

    this.coveredFrom = snapshot.length < 100 ? -Infinity
      : Math.min(...snapshot.map((item) => Number(item.create_time)).filter(Number.isFinite));
    // Without a snapshot, the first request needs to fetch its own window.
    if (!snapshot.length) this.coveredFrom = Infinity;
  }

  async before(time: number, excludeIds: Set<string>): Promise<AgentRunContextMessage[]> {
    if (!Number.isFinite(time) || time <= 0) return [];

    const after = Math.max(0, time - MAX_AGE_MS);
    const candidates = () => [...this.items.values()]
      .filter((item) => isGroupContextItem(item) && !excludeIds.has(item.message_id!)
        && Number(item.create_time) >= after && Number(item.create_time) < time)
      .sort((a, b) => Number(b.create_time) - Number(a.create_time));

    let items = candidates();
    if (items.length < MAX_MESSAGES && this.coveredFrom > after && this.canFetch) {
      try {
        // Cache a contiguous window, including task-specific quote exclusions,
        // so another task can still use those messages as background.
        const limit = MAX_MESSAGES + excludeIds.size;
        const extra = await this.list(limit, after, Math.min(time, this.coveredFrom));
        for (const item of extra) if (item.message_id) this.items.set(item.message_id, item);

        this.coveredFrom = extra.length < limit ? after
          : Math.min(this.coveredFrom, ...extra.map((item) => Number(item.create_time)));
        items = candidates();
      } catch (err) {
        this.canFetch = false;
        log.warn('guard', 'context-fetch-failed', { err: err instanceof Error ? err.message : String(err) });
      }
    }

    const messages: AgentRunContextMessage[] = [];
    let remaining = MAX_CHARS;
    for (const item of items.slice(0, MAX_MESSAGES)) {
      if (remaining <= 0) break;

      let pending = this.normalized.get(item.message_id!);
      if (!pending) {
        pending = this.normalize(item);
        this.normalized.set(item.message_id!, pending);
      }

      const message = await pending;
      if (!message?.content.trim()) continue;

      const content = message.content.length > remaining
        ? `${message.content.slice(0, remaining - 1)}…` : message.content;
      messages.push({ ...message, content });
      remaining -= content.length;
    }

    return messages.reverse();
  }

  private async normalize(item: FeishuMessageItem): Promise<AgentRunContextMessage | undefined> {
    const message = await normalizeItemToQuoted(this.channel, item, async (id) =>
      id === item.message_id ? [item] : fetchFeishuMessageItems(this.channel, id));
    if (!message) return;

    return {
      messageId: message.messageId, senderId: message.senderId,
      ...(message.senderName ? { senderName: message.senderName } : {}),
      ...(message.createdAt ? { createdAt: message.createdAt } : {}),
      content: message.content,
    };
  }
}
