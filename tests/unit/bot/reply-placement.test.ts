import { describe, expect, it } from 'vitest';
import { replyOptions } from '../../../src/bot/reply-placement';
import { getReplyPlacement, type AppConfig } from '../../../src/config/schema';

const cfg = (preferences: AppConfig['preferences'] = {}): AppConfig => ({
  accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
  preferences,
});

describe('reply placement', () => {
  it('defaults direct messages to conversation and ordinary groups to thread', () => {
    expect(getReplyPlacement(cfg(), 'p2p')).toBe('conversation');
    expect(getReplyPlacement(cfg(), 'group')).toBe('thread');
    expect(replyOptions(cfg(), { messageId: 'om_dm', chatType: 'p2p' })).toEqual({
      replyTo: 'om_dm', replyInThread: false,
    });
    expect(replyOptions(cfg(), { messageId: 'om_group', chatType: 'group' })).toEqual({
      replyTo: 'om_group', replyInThread: true,
    });
  });

  it('honors each choice independently and keeps an existing topic threaded', () => {
    const settings = cfg({ dmReplyPlacement: 'thread', groupReplyPlacement: 'conversation' });
    expect(replyOptions(settings, { messageId: 'om_dm', chatType: 'p2p' }).replyInThread).toBe(true);
    expect(replyOptions(settings, { messageId: 'om_group', chatType: 'group' }).replyInThread).toBe(false);
    expect(replyOptions(settings, { messageId: 'om_topic', chatType: 'group', threadId: 'omt_1' }).replyInThread).toBe(true);
    expect(replyOptions(settings, { messageId: 'om_topic_root', chatType: 'group' }, true).replyInThread).toBe(true);
  });
});
