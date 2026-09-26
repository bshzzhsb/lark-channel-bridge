import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatModeCache } from '@/bot/chat-mode-cache';
import { CotClient } from '@/bot/cot';
import { createBatchScheduler } from '@/bot/im/scheduler';
import type { ImRunner } from '@/bot/im/types';
import { createDefaultProfileConfig } from '@/config/profile-schema';

function message(messageId: string, chatId = 'chat-1'): NormalizedMessage {
  return {
    messageId, chatId, chatType: 'p2p', senderId: 'user-1', content: messageId,
    resources: [], mentions: [], mentionedBot: false, mentionAll: false,
    rawContentType: 'text', createTime: 1,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  vi.useFakeTimers();
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude', accounts: { app: { id: 'test', secret: 'secret', tenant: 'feishu' } },
  });
  const run = vi.fn<ImRunner>(async () => undefined);
  const channel = { getChatMode: async () => 'p2p' } as unknown as LarkChannel;
  const sessions = { markTopicRoot: vi.fn() };
  const controls = { cfg };
  const queue = createBatchScheduler({
    channel, controls, sessions, chatModeCache: new ChatModeCache(),
    cotClient: new CotClient({ tenant: 'feishu', appId: 'test', appSecret: 'secret' }),
    logThreadModeOverride: vi.fn(), run,
  });
  return { queue, run, sessions, controls };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('IM batch scheduling', () => {
  it('holds the next batch in the same scope while another scope can run', async () => {
    const h = harness();
    const first = deferred();
    h.run.mockImplementationOnce(async () => { await first.promise; return undefined; });
    h.queue.push('chat-1', message('first'));
    await vi.advanceTimersByTimeAsync(600);
    h.queue.push('chat-1', message('second'));
    h.queue.push('chat-1', message('third'));
    h.queue.push('chat-2', message('other', 'chat-2'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.run.mock.calls.map(([request]) => request.scope)).toEqual(['chat-1', 'chat-2']);
    first.resolve();
    await vi.advanceTimersByTimeAsync(599);
    expect(h.run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.run.mock.calls[2]?.[0].batch.map((msg) => msg.messageId)).toEqual(['second', 'third']);
    h.queue.cancelAll();
  });

  it('releases the scope after a run fails', async () => {
    const h = harness();
    const first = deferred();
    h.run.mockImplementationOnce(async () => { await first.promise; throw new Error('run failed'); });
    h.queue.push('chat-1', message('first'));
    await vi.advanceTimersByTimeAsync(600);
    h.queue.push('chat-1', message('second'));
    first.resolve();
    await vi.advanceTimersByTimeAsync(600);
    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.run.mock.calls[1]?.[0].batch[0]?.messageId).toBe('second');
    h.queue.cancelAll();
  });

  it('blocks both the source scope and the new topic scope until the run completes', async () => {
    const h = harness();
    h.controls.cfg.preferences.dmReplyPlacement = 'thread';
    const first = deferred();
    h.run.mockImplementationOnce(async () => { await first.promise; return undefined; });
    h.queue.push('chat-1', message('root'));
    await vi.advanceTimersByTimeAsync(600);
    expect(h.run.mock.calls[0]?.[0].scope).toBe('chat-1:root:root');
    expect(h.sessions.markTopicRoot).toHaveBeenCalledWith('chat-1:root:root');
    h.queue.push('chat-1:root:root', { ...message('reply'), rootId: 'root', threadId: 'thread-1' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.run).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.advanceTimersByTimeAsync(600);
    expect(h.run.mock.calls[1]?.[0]).toMatchObject({ scope: 'chat-1:root:root', mode: 'topic' });
    h.queue.cancelAll();
  });
});
