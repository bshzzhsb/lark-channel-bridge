import type { AgentEvent } from '../../agent/types';
import type { CotMessagesMode } from '../../config/schema';
import { log } from '../../core/logger';
import { toolHeaderText } from '../../card/tool-render';
import type { CotPublisher } from './publisher';

const COT_TOOL_OUTPUT_MAX = 1200;
const COT_TEXT_MAX = 1200;

export async function consumeCotEvents(
  events: AsyncIterable<AgentEvent>,
  publisher: CotPublisher,
  opts: { detail: CotMessagesMode },
): Promise<void> {
  let reasoningOpen = false;
  let textStepOpen = false;
  let textMessageOpen = false;
  let textMessageIndex = 0;
  let textMessageId: string | undefined;
  const toolBrief = new Map<string, { name: string; input: unknown }>();
  const reasoningMessageId = `reasoning-${publisher.runId}`;
  const finalStepId = `step-process-${publisher.runId}`;

  try {
    for await (const evt of events) {
      if (evt.type === 'system' || evt.type === 'usage') continue;
      if (evt.type === 'thinking') {
        closeTextIfNeeded();
        if (!reasoningOpen) {
          reasoningOpen = true;
          publisher.enqueue('REASONING_START', { messageId: reasoningMessageId });
          publisher.enqueue('REASONING_MESSAGE_START', {
            messageId: reasoningMessageId,
            role: 'reasoning',
          });
        }
        publisher.enqueue('REASONING_MESSAGE_CONTENT', {
          messageId: reasoningMessageId,
          delta: truncateCot(evt.delta, COT_TEXT_MAX),
        });
        continue;
      }
      if (evt.type === 'tool_use') {
        closeReasoningIfNeeded();
        closeTextIfNeeded();
        const toolCallId = evt.id;
        const detailed = opts.detail === 'detailed';
        const showSummary = opts.detail === 'brief' || detailed;
        const title = showSummary ? cotBriefToolTitle(evt.name, evt.input, 'running') : '正在调用工具';
        toolBrief.set(toolCallId, { name: evt.name, input: evt.input });
        publisher.enqueue('TOOL_CALL_START', {
          toolCallId,
          icon: showSummary ? cotToolIcon(evt.name) : 'default',
          title,
          toolCallName: showSummary ? evt.name : 'tool',
        });
        if (detailed && evt.input !== undefined) {
          publisher.enqueue('TOOL_CALL_ARGS', {
            toolCallId,
            delta: JSON.stringify(evt.input),
          });
        }
        publisher.enqueue('TOOL_CALL_END', { toolCallId });
        continue;
      }
      if (evt.type === 'tool_result') {
        const detailed = opts.detail === 'detailed';
        const brief = toolBrief.get(evt.id);
        publisher.enqueue('TOOL_CALL_RESULT', {
          messageId: `tool-result-${evt.id}`,
          toolCallId: evt.id,
          role: 'tool',
          content: detailed
            ? truncateCot(evt.output ?? '', COT_TOOL_OUTPUT_MAX)
            : brief
              ? cotBriefToolTitle(brief.name, brief.input, evt.isError ? 'error' : 'done')
              : '工具调用已完成',
        });
        toolBrief.delete(evt.id);
        continue;
      }
      if (evt.type === 'text') {
        closeReasoningIfNeeded();
        if (!textStepOpen) {
          textStepOpen = true;
          publisher.enqueue('STEP_STARTED', {
            stepId: finalStepId,
            stepName: '输出过程',
          });
        }
        if (!textMessageOpen) {
          textMessageOpen = true;
          textMessageId = `text-${publisher.runId}-${++textMessageIndex}`;
          publisher.enqueue('TEXT_MESSAGE_START', { messageId: textMessageId, role: 'assistant' });
        }
        publisher.enqueue('TEXT_MESSAGE_CONTENT', {
          messageId: textMessageId,
          delta: truncateCot(evt.delta, COT_TEXT_MAX),
        });
        continue;
      }
      if (evt.type === 'final_text') continue;
      if (evt.type === 'done' || evt.type === 'error') {
        closeReasoningIfNeeded();
        closeTextIfNeeded();
        if (textStepOpen) {
          publisher.enqueue('STEP_FINISHED', {
            stepId: finalStepId,
            stepName: '输出过程',
          });
        }
        if (evt.type === 'error') {
          publisher.enqueue('RUN_ERROR', { message: evt.message, code: evt.terminationReason ?? 'error' });
          await publisher.finish('error');
        } else {
          const status = evt.terminationReason === 'normal' ? 'done' : evt.terminationReason ?? 'done';
          publisher.enqueue('RUN_FINISHED', {
            threadId: publisher.scope,
            runId: publisher.runId,
            status,
          });
          await publisher.finish(status === 'done' ? 'done' : 'error');
        }
        return;
      }
    }
    closeReasoningIfNeeded();
    closeTextIfNeeded();
    await publisher.finish('done');
  } catch (err) {
    log.warn('cot', 'consume-failed', { err: err instanceof Error ? err.message : String(err) });
    await publisher.finish('error');
  }

  function closeReasoningIfNeeded(): void {
    if (!reasoningOpen) return;
    reasoningOpen = false;
    publisher.enqueue('REASONING_MESSAGE_END', { messageId: reasoningMessageId });
    publisher.enqueue('REASONING_END', { messageId: reasoningMessageId });
  }

  function closeTextIfNeeded(): void {
    if (!textMessageOpen || !textMessageId) return;
    publisher.enqueue('TEXT_MESSAGE_END', { messageId: textMessageId });
    textMessageOpen = false;
    textMessageId = undefined;
  }
}

export function cotBriefToolTitle(
  name: string,
  input: unknown,
  status: 'running' | 'done' | 'error' = 'running',
): string {
  return toolHeaderText({ id: 'cot-tool', name, input, status }).replace(/\*\*/g, '');
}

function cotToolIcon(name: string): string {
  const lower = String(name ?? '').toLowerCase();
  if (lower.includes('search') || lower.includes('grep') || lower.includes('rg')) return 'search';
  if (lower.includes('read')) return 'read';
  if (lower.includes('write') || lower.includes('edit')) return 'write';
  if (lower.includes('doc')) return 'doc';
  if (lower.includes('calendar')) return 'calendar';
  if (lower.includes('task')) return 'task';
  if (lower.includes('command') || lower.includes('bash')) return 'bash';
  return 'default';
}

function truncateCot(value: unknown, max: number): string {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
