import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';

import type { AgentRunOptions, AgentRunRequest, AgentRunResult, Controls } from '@/commands';
import { getCotMessages } from '@/config/schema';
import { withTrace } from '@/core/logger';
import type { SessionStore } from '@/session/store';
import type { WorkspaceStore } from '@/workspace/store';

import type { CotClient } from './cot';
import { RunCot } from './cot';
import type { PendingQueue } from './pending-queue';
import { replyOptions } from './reply-placement';
import { rootTopicScope } from './topic-scope';

interface OnboardExecution {
  message: NormalizedMessage;
  scope: string;
  mode: AgentRunRequest['mode'];
  runOptions: AgentRunOptions;
  cotRun: RunCot;
}

interface OnboardOrchestratorDeps {
  channel: LarkChannel;
  controls: Controls;
  cotClient: CotClient;
  pending: PendingQueue;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  execute: (input: OnboardExecution) => Promise<Omit<AgentRunResult, 'scopeId' | 'anchorMessageId'> | undefined>;
}

/** Owns the COT anchor and session routing for an /onboard agent run. */
export function createOnboardOrchestrator(deps: OnboardOrchestratorDeps):
  (request: AgentRunRequest) => Promise<AgentRunResult> {
  const { channel, controls, cotClient, pending, sessions, workspaces, execute } = deps;
  return async (request) => {
    const chatId = request.message.chatId;
    let sourceSendOpts = request.sendOpts
      ?? replyOptions(controls.cfg, request.message, request.mode === 'topic');
    const opensTaskTopic = request.sessionAnchor?.placement === 'new-topic';
    const runCot = request.sessionAnchor
      ? {
          ...request.cot,
          stepName: request.cot?.stepName ?? request.sessionAnchor.title,
          inputPreview: request.cot?.inputPreview ?? request.sessionAnchor.title,
        }
      : request.cot;
    let scope = request.scopeId;
    let anchorMessageId: string | undefined;
    let message = request.message;
    let sendOpts = sourceSendOpts;
    let cotRun: RunCot | undefined;

    try {
      if (opensTaskTopic && request.sessionAnchor) {
        // A topic must be rooted in an ordinary message. COT messages are
        // progress displays, and are not valid threaded reply targets.
        const sent = await channel.send(chatId, {
          markdown: request.sessionAnchor.fallbackMessage,
        }, { replyTo: sourceSendOpts.replyTo, replyInThread: false });
        anchorMessageId = sent.messageId;
        scope = rootTopicScope(chatId, anchorMessageId);
        sessions.markTopicRoot(scope);
        const inheritedCwd = workspaces.cwdFor(request.scopeId);
        if (inheritedCwd) workspaces.setCwd(scope, inheritedCwd);
        sourceSendOpts = { replyTo: anchorMessageId, replyInThread: true };
        sendOpts = sourceSendOpts;
      }
      cotRun = new RunCot({
        client: cotClient,
        mode: () => getCotMessages(controls.cfg),
        chatId,
        originMessageId: sourceSendOpts.replyTo,
        replyInThread: sourceSendOpts.replyInThread,
        scope,
        inputPreview: runCot?.inputPreview ?? request.prompt ?? request.message.content,
        stepName: runCot?.stepName,
        detail: runCot?.detail,
        onCreated: runCot?.onCreated,
      });
      if (request.sessionAnchor) {
        const cotRef = await cotRun.reserveAnchor();
        if (!anchorMessageId && cotRef) {
          anchorMessageId = cotRef.messageId;
        } else if (!anchorMessageId) {
          const sent = await channel.send(chatId, {
            markdown: request.sessionAnchor.fallbackMessage,
          }, sourceSendOpts);
          anchorMessageId = sent.messageId;
        }

        message = {
          ...request.message,
          messageId: anchorMessageId,
          content: request.prompt ?? request.message.content,
          rawContentType: 'text',
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          replyToMessageId: undefined,
          createTime: Date.now(),
          raw: undefined,
        };
        // Keep final replies and errors on the ordinary source message,
        // even when a separate COT display was reserved for this run.
        sendOpts = sourceSendOpts;
      }

      const executionCot = cotRun;
      return await withPendingQueueBlock(pending, scope, async () => {
        const result = await withTrace({ chatId, msgId: message.messageId }, () => execute({
          message,
          scope,
          mode: request.mode,
          cotRun: executionCot,
          runOptions: {
            ...request,
            cot: runCot,
            sendOpts,
          },
        }));
        return {
          scopeId: scope,
          ...(anchorMessageId ? { anchorMessageId } : {}),
          ...(result?.replyMessageId ? { replyMessageId: result.replyMessageId } : {}),
          ...(result?.finalText !== undefined ? { finalText: result.finalText } : {}),
          ...(result?.sessionId ? { sessionId: result.sessionId } : {}),
          ...(result?.threadId ? { threadId: result.threadId } : {}),
          ...(result?.cwdRealpath ? { cwdRealpath: result.cwdRealpath } : {}),
          ...(result?.error ? { error: result.error } : {}),
          ...(result?.errorReported ? { errorReported: true } : {}),
        };
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await cotRun?.fail(reason, 'agent-run-failed', { scope });
      return {
        scopeId: scope,
        ...(anchorMessageId ? { anchorMessageId } : {}),
        error: reason,
      };
    }
  };
}

async function withPendingQueueBlock<T>(
  pending: PendingQueue,
  scope: string,
  run: () => Promise<T>,
): Promise<T> {
  pending.block(scope);
  try {
    return await run();
  } finally {
    pending.unblock(scope);
  }
}
