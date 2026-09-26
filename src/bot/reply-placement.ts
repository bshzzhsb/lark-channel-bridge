import type { NormalizedMessage } from '@larksuite/channel';

import { type AppConfig,getReplyPlacement } from '@/config/schema';

export function replyOptions(
  cfg: AppConfig,
  msg: Pick<NormalizedMessage, 'messageId' | 'chatType' | 'threadId'>,
  topicGroup = false,
): { replyTo: string; replyInThread: boolean } {
  const inThread = topicGroup || Boolean(msg.threadId) || getReplyPlacement(cfg, msg.chatType) === 'thread';
  return {
    replyTo: msg.messageId,
    replyInThread: inThread,
  };
}
