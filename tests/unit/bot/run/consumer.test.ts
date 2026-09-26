import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '@/agent/types';
import type { RunHandle } from '@/bot/active-runs';
import { consumeRun } from '@/bot/run/consumer';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(() => vi.useRealTimers());

function harness(events: AsyncIterable<AgentEvent>, idleTimeoutMs = 50) {
  const stop = vi.fn(async () => {});
  const handle: RunHandle = {
    interrupted: false,
    run: { runId: 'run-test', events, stop, waitForExit: async () => true },
  };
  const recordSession = vi.fn();
  const flush = vi.fn(async () => {});
  const consume = () => consumeRun({
    handle, events, scope: 'chat-test', idleTimeoutMs, recordSession, flush,
  });
  return { handle, stop, recordSession, flush, consume };
}

describe('run event consumption', () => {
  it('records session events and stops at the terminal event even if stdout stays open', async () => {
    let readAfterDone = false;
    async function* events(): AsyncIterable<AgentEvent> {
      yield { type: 'system', sessionId: 'session-1' };
      yield { type: 'text', delta: 'answer' };
      yield { type: 'done', sessionId: 'session-1', terminationReason: 'normal' };
      readAfterDone = true;
      await new Promise(() => {});
    }
    const h = harness(events());
    const state = await h.consume();
    expect(state.terminal).toBe('done');
    expect(h.recordSession.mock.calls.map(([event]) => event.type)).toEqual(['system', 'done']);
    expect(readAfterDone).toBe(false);
    expect(h.stop).not.toHaveBeenCalled();
  });

  it('pauses idle timeout until all concurrent tools finish', async () => {
    vi.useFakeTimers();
    async function* events(): AsyncIterable<AgentEvent> {
      yield { type: 'tool_use', id: 'tool-1', name: 'first', input: {} };
      yield { type: 'tool_use', id: 'tool-2', name: 'second', input: {} };
      await delay(100);
      yield { type: 'tool_result', id: 'tool-1', output: 'first finished', isError: false };
      await delay(100);
      yield { type: 'tool_result', id: 'tool-2', output: 'second finished', isError: false };
      await delay(49);
      yield { type: 'done', terminationReason: 'normal' };
    }
    const h = harness(events());
    const result = h.consume();
    await vi.advanceTimersByTimeAsync(250);
    expect((await result).terminal).toBe('done');
    expect(h.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rearms idle timeout after tool completion', async () => {
    vi.useFakeTimers();
    async function* events(): AsyncIterable<AgentEvent> {
      yield { type: 'tool_use', id: 'tool-1', name: 'tool', input: {} };
      await delay(100);
      yield { type: 'tool_result', id: 'tool-1', output: 'finished', isError: false };
      await delay(100);
      yield { type: 'done', terminationReason: 'normal' };
    }
    const h = harness(events());
    const result = h.consume();
    await vi.advanceTimersByTimeAsync(201);
    expect((await result).terminal).toBe('idle_timeout');
    expect(h.handle.interrupted).toBe(true);
    expect(h.stop).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a successful terminal state if the watchdog fires during the last flush', async () => {
    vi.useFakeTimers();
    async function* events(): AsyncIterable<AgentEvent> {
      yield { type: 'done', terminationReason: 'normal' };
    }
    const h = harness(events());
    h.flush.mockImplementationOnce(async () => { await delay(100); });
    const result = h.consume();
    await vi.advanceTimersByTimeAsync(101);
    expect((await result).terminal).toBe('done');
    expect(h.handle.interrupted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its watchdog when event consumption fails', async () => {
    vi.useFakeTimers();
    async function* events(): AsyncIterable<AgentEvent> {
      yield { type: 'text', delta: 'partial' };
      throw new Error('event source failed');
    }
    const h = harness(events());
    await expect(h.consume()).rejects.toThrow('event source failed');
    expect(vi.getTimerCount()).toBe(0);
  });
});
