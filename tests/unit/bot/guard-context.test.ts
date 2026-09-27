import type { LarkChannel } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GuardMessageContext } from '@/bot/guard-context';
import type { FeishuMessageItem } from '@/bot/quote';
import * as quote from '@/bot/quote';

const channel = { botIdentity: { openId: 'ou_bot' } } as LarkChannel;
const triggerTime = 10_000_000;

function item(id: string, time = triggerTime - 1, text = id): FeishuMessageItem {
  return { message_id: id, create_time: String(time), msg_type: 'text',
    sender: { id: 'ou_sender', id_type: 'open_id', sender_type: 'user' }, body: { content: JSON.stringify({ text }) } };
}

afterEach(() => vi.restoreAllMocks());

describe('guard message background', () => {
  it('keeps the closest 20 messages in chronological order within two hours', async () => {
    const messages = Array.from({ length: 30 }, (_, i) => item(`om_${i}`, triggerTime - 1000 + i));
    const context = new GuardMessageContext(channel, vi.fn(), [...messages,
      item('om_expired', triggerTime - 7_200_001), item('om_future', triggerTime + 1),
      item('om_same_time', triggerTime),
      { ...item('om_reply'), parent_id: 'om_other' },
      { ...item('om_deleted'), deleted: true }]);
    const result = await context.before(triggerTime, new Set(['om_29']));
    expect(result.map((m) => m.messageId)).toEqual(messages.slice(9, 29).map((m) => m.message_id));
  });

  it('caps text at 6000 characters, prioritizing messages nearest the trigger', async () => {
    const context = new GuardMessageContext(channel, vi.fn(), [
      item('om_older', triggerTime - 2, 'a'.repeat(4000)), item('om_newer', triggerTime - 1, 'b'.repeat(4000)),
    ]);
    const result = await context.before(triggerTime, new Set());
    expect(result.reduce((count, m) => count + m.content.length, 0)).toBe(6000);
    expect(result[0]?.content).toBe(`${'a'.repeat(1999)}…`);
    expect(result[1]?.content).toBe('b'.repeat(4000));
  });

  it('lazily fetches beyond the oldest snapshot item and reuses fetched and normalized messages', async () => {
    const snapshot = Array.from({ length: 100 }, (_, i) => item(`om_${i}`, triggerTime + i));
    const older = Array.from({ length: 20 }, (_, i) => item(`om_old_${i}`, triggerTime - 100 + i));
    const list = vi.fn(async () => older);
    const normalize = vi.spyOn(quote, 'normalizeItemToQuoted');
    const context = new GuardMessageContext(channel, list, snapshot);
    const first = await context.before(triggerTime + 5, new Set());
    expect(first).toHaveLength(20);
    expect(list).toHaveBeenCalledWith(20, triggerTime + 5 - 7_200_000, triggerTime);
    const count = normalize.mock.calls.length;
    const second = await context.before(triggerTime + 6, new Set());
    expect(second).toHaveLength(20);
    expect(list).toHaveBeenCalledTimes(1);
    expect(normalize).toHaveBeenCalledTimes(count + 1);
  });

  it('returns snapshot context when supplementation fails and does not repeatedly retry during the scan', async () => {
    const snapshot = Array.from({ length: 100 }, (_, i) => item(`om_${i}`, triggerTime + i));
    const list = vi.fn().mockRejectedValue(new Error('history unavailable'));
    const context = new GuardMessageContext(channel, list, snapshot);
    expect(await context.before(triggerTime + 2, new Set())).toHaveLength(2);
    expect(await context.before(triggerTime + 3, new Set())).toHaveLength(3);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('does not fetch expired history or normalize attachments through the media pipeline', async () => {
    const list = vi.fn();
    const context = new GuardMessageContext(channel, list, [
      item('om_expired', triggerTime - 7_200_001),
      { ...item('om_image'), msg_type: 'image', body: { content: JSON.stringify({ image_key: 'img_background' }) } },
    ]);
    const result = await context.before(triggerTime, new Set());
    expect(list).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0]?.messageId).toBe('om_image');
    expect(result[0]?.content).toContain('img_background');
  });
});
