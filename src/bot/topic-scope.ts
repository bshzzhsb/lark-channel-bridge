import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';

/** Stable identity for a topic created by replying to an ordinary message. */
export function rootTopicScope(chatId: string, rootMessageId: string): string {
  return `${chatId}:root:${rootMessageId}`;
}

export function existingRootTopicScope(input: {
  chatId: string;
  rootId?: string;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
}): string | undefined {
  if (!input.rootId) return undefined;
  const scope = rootTopicScope(input.chatId, input.rootId);
  const legacy = input.sessions.getRaw(scope);
  if (legacy?.topicRoot || legacy?.sessionId) return scope;
  if (input.sessionCatalog?.entries().some((entry) => entry.scopeId === scope && entry.status === 'active')) {
    return scope;
  }
  return undefined;
}

export function policyThreadId(scope: string, chatId: string, actualThreadId?: string): string | undefined {
  const prefix = `${chatId}:root:`;
  return scope.startsWith(prefix) ? scope.slice(chatId.length + 1) : actualThreadId;
}
