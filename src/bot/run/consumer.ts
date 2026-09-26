import type { AgentEvent } from '@/agent/types';
import type { RunHandle } from '@/bot/active-runs';
import {
  finalizeIfRunning,
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
  type RunState,
} from '@/card/run-state';
import { log, reportMetric } from '@/core/logger';

export interface ConsumeRunInput {
  handle: RunHandle;
  events: AsyncIterable<AgentEvent>;
  scope: string;
  idleTimeoutMs?: number;
  recordSession: (event: AgentEvent) => void;
  flush: (state: RunState) => Promise<void>;
}

export async function consumeRun(input: ConsumeRunInput): Promise<RunState> {
  const { handle, events, scope, recordSession, flush } = input;

  const runStart = Date.now();

  const watchdog = createIdleWatchdog(input);
  let state: RunState = initialState;

  try {
    for await (const event of events) {
      if (handle.interrupted) break;

      watchdog.observe(event);

      if (event.type === 'system' || event.type === 'done') recordSession(event);

      if (event.type === 'system') continue;

      if (event.type === 'usage') {
        recordUsage(event);
        continue;
      }

      const next = reduce(state, event);

      if (next.footer !== state.footer || next.terminal !== state.terminal) {
        log.info('card', 'transition', { footer: next.footer, terminal: next.terminal });
      }

      state = next;
      await flush(state);

      // Some agents keep stdout open after their terminal event.
      if (state.terminal !== 'running') break;
    }
  } finally {
    watchdog.stop();
  }

  state = finalizeRunState(input, state, watchdog.fired());
  log.info('card', 'final', { scope, terminal: state.terminal, interrupted: handle.interrupted });
  reportMetric('run_e2e_ms', Date.now() - runStart, { terminal: state.terminal });
  await flush(state);

  if (handle.interrupted) await handle.run.stop();

  return state;
}

function createIdleWatchdog({ handle, scope, idleTimeoutMs }: ConsumeRunInput) {
  let fired = false;
  let timer: NodeJS.Timeout | undefined;
  const inFlightTools = new Set<string>();
  const stop = () => {
    if (timer) clearTimeout(timer);

    timer = undefined;
  };
  const arm = () => {
    stop();

    // Long tool calls (including interactive OAuth) are allowed to remain silent.
    if (!idleTimeoutMs || inFlightTools.size > 0) return;

    timer = setTimeout(() => {
      fired = true;
      handle.interrupted = true;
      log.warn('agent', 'idle-timeout', { scope, idleTimeoutMs });
      void handle.run.stop().catch(() => { });
    }, idleTimeoutMs);
  };

  arm();

  return {
    stop,
    fired: () => fired,
    observe(event: AgentEvent) {
      if (event.type === 'tool_use') {
        inFlightTools.add(event.id);
        log.info('agent', 'tool-in-flight', { tool: event.name, inFlight: inFlightTools.size });
      } else if (event.type === 'tool_result') {
        inFlightTools.delete(event.id);
        log.info('agent', 'tool-done', { inFlight: inFlightTools.size });
      }

      arm();
    },
  };
}

function finalizeRunState(input: ConsumeRunInput, state: RunState, idleFired: boolean): RunState {
  // A real terminal event wins over a timeout that fired during a slow flush.
  if (state.terminal !== 'running') return state;

  if (idleFired) return markIdleTimeout(state, Math.round(input.idleTimeoutMs! / 60_000));

  if (input.handle.interrupted) return markInterrupted(state);

  return finalizeIfRunning(state);
}

function recordUsage(event: Extract<AgentEvent, { type: 'usage'; }>) {
  const { costUsd, inputTokens, outputTokens } = event;

  if (costUsd === undefined && inputTokens === undefined && outputTokens === undefined) return;

  log.info('agent', 'usage', {
    ...(costUsd !== undefined ? { costUsd: Number(costUsd.toFixed(4)) } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  });

  if (costUsd !== undefined) reportMetric('cost_usd', costUsd);

  if (inputTokens !== undefined) reportMetric('tokens_in', inputTokens);

  if (outputTokens !== undefined) reportMetric('tokens_out', outputTokens);
}
