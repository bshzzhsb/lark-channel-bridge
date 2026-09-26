import { handleCommentMention } from '@/bot/comments';
import { createMessageIntake, type IntakeDeps } from '@/bot/im/intake';
import type { CallbackAuth } from '@/card/callback-auth';
import { handleCardAction } from '@/card/dispatcher';
import { log, withTrace } from '@/core/logger';

import { createConnectionHandlers } from './sdk';

interface ChannelEventsDeps extends IntakeDeps {
  callbackAuth?: CallbackAuth;
  policyFingerprintForScope: (scope: string) => string | undefined;
}

export function bindChannelEvents(deps: ChannelEventsDeps): void {
  const { channel, sessions, sessionCatalog, workspaces, activeRuns, agent, pool,
    executor, controls, pending, chatModeCache, callbackAuth, policyFingerprintForScope } = deps;

  const intake = createMessageIntake(deps);
  const cardDeps = {
    channel, sessions, sessionCatalog, workspaces, activeRuns, agent,
    processPool: pool, runExecutor: executor, controls, pending, chatModeCache, callbackAuth,
    callbackPolicyFingerprintForScope: policyFingerprintForScope,
  };
  const commentDeps = { channel, agent, sessions, sessionCatalog, workspaces, activeRuns, executor, controls };

  channel.on({
    message: async (msg) => {
      await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, () => intake(msg))
        .catch((err) => log.fail('intake', err));
    },
    reject: (evt) => log.info('intake', 'reject', { chatId: evt.chatId, reason: evt.reason }),
    cardAction: async (evt) => {
      await withTrace({ chatId: evt.chatId, msgId: evt.messageId }, () => handleCardAction({ ...cardDeps, evt }))
        .catch((err) => log.fail('cardAction', err));
    },
    comment: async (evt) => {
      await withTrace({ chatId: 'comment' }, () => handleCommentMention({ ...commentDeps, evt }))
        .catch((err) => log.fail('comment', err));
    },
    ...createConnectionHandlers(),
  });
}
