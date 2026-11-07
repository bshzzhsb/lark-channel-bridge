import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { prefixBridgeSystemPrompt } from '@/agent/bridge-system-prompt';
import type { AgentBotIdentity, AgentEvent, AgentRun, AgentRunOptions } from '@/agent/types';
import { log } from '@/core/logger';
import { type SpawnedProcessByStdio, spawnProcess } from '@/platform/spawn';

type JsonlChild = SpawnedProcessByStdio<Writable, Readable, Readable>;
type JsonlFinishReason = 'failed' | 'interrupted' | 'timeout';
export interface JsonlTranslator {
  translate(raw: unknown): AgentEvent[];
  finish(reason?: JsonlFinishReason): AgentEvent[];
  fail(message: string): AgentEvent[];
  terminalEmitted(): boolean;
}

export interface JsonlProcessInput {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  agentName: string;
  opts: AgentRunOptions;
  translator: JsonlTranslator;
  botIdentity?: AgentBotIdentity;
  stopGraceMs?: number;
  verifyExitBeforeDone?: boolean;
  formatError?: (message: string) => string;
}

/** Shared transport; agent-specific argv, environment and translation stay with adapters. */
export function runJsonlProcess(input: JsonlProcessInput): AgentRun {
  const { opts } = input;
  const child = spawnProcess(input.binary, input.args, {
    cwd: opts.cwd,
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as JsonlChild;

  log.info('agent', 'spawn', {
    pid: child.pid ?? null,
    cwd: opts.cwd,
    hasThread: Boolean(opts.threadId),
    promptChars: opts.prompt.length,
    images: opts.images?.length ?? 0,
    model: opts.model,
  });

  const stderrChunks: Buffer[] = [];
  let runtimeError: Error | null = null;
  let stderrBuffer = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk);
    stderrBuffer += chunk.toString('utf8');
    let nl = stderrBuffer.indexOf('\n');
    while (nl !== -1) {
      const line = stderrBuffer.slice(0, nl);
      stderrBuffer = stderrBuffer.slice(nl + 1);
      if (line.trim()) log.warn('agent', 'stderr', { line });
      if (isWindowsCommandNotFoundLine(line)) {
        runtimeError = new Error(`failed to spawn ${input.agentName}: ${line.trim()}`);
        child.stdout.destroy();
        child.kill();
      }
      nl = stderrBuffer.indexOf('\n');
    }
  });

  let stopReason: Exclude<JsonlFinishReason, 'failed'> | undefined;
  child.on('error', (err) => {
    runtimeError = err;
  });
  child.on('exit', (code, signal) => {
    log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
  });
  child.stdin.on('error', (err) => {
    log.warn('agent', 'stdin-error', { message: err.message });
  });
  child.stdin.end(prefixBridgeSystemPrompt(opts.prompt, input.botIdentity), 'utf8');

  const stopGraceMs = opts.stopGraceMs ?? input.stopGraceMs ?? 5000;

  return {
    runId: opts.runId,
    events: createEventStream(child, stderrChunks, () => runtimeError, () => stopReason, input.translator, input.agentName, input.verifyExitBeforeDone, input.formatError),
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      stopReason = 'interrupted';
      log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            log.warn('agent', 'stop-sigkill', {
              pid: child.pid ?? null,
              graceMs: stopGraceMs,
              reason: 'grace-period-expired',
            });
            child.kill('SIGKILL');
          }
          resolve();
        }, stopGraceMs);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    waitForExit(timeoutMs: number): Promise<boolean> {
      if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        const onExit = (): void => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          child.removeListener('exit', onExit);
          resolve(false);
        }, timeoutMs);
        child.once('exit', onExit);
      });
    },
  };
}

async function* createEventStream(
  child: JsonlChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  getStopReason: () => Exclude<JsonlFinishReason, 'failed'> | undefined,
  translator: JsonlTranslator,
  agentName: string,
  verifyExitBeforeDone = false,
  formatError: (message: string) => string = (message) => message,
): AsyncGenerator<AgentEvent> {
  let pendingDone: Extract<AgentEvent, { type: 'done' }> | undefined;
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: formatError(err ? `failed to spawn ${agentName}: ${err.message}` : 'spawn returned no pid'),
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawStdout = false;
  let silentExitTimer: ReturnType<typeof setTimeout> | undefined;
  const closeSilentStdout = (): void => {
    silentExitTimer = setTimeout(() => {
      if (!sawStdout && !child.stdout.readableEnded) child.stdout.destroy();
    }, 50);
  };
  child.once('exit', closeSilentStdout);
  try {
    for await (const line of rl) {
      sawStdout = true;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      for (const event of translator.translate(parsed)) {
        if (verifyExitBeforeDone && event.type === 'done') pendingDone = event;
        else yield event;
      }
    }
  } finally {
    if (silentExitTimer) clearTimeout(silentExitTimer);
    child.removeListener('exit', closeSilentStdout);
    rl.close();
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    const message = formatError(`${agentName} runtime error: ${earlyRuntimeError.message}`);
    if (pendingDone) yield { type: 'error', message, terminationReason: 'failed' };
    else yield* translator.fail(message);
    return;
  }

  const exitCode = await waitForExitCode(child);
  const stopReason = getStopReason();
  if (stopReason) {
    if (pendingDone) yield { ...pendingDone, terminationReason: stopReason };
    else yield* translator.finish(stopReason);
    return;
  }

  const runtimeError = getError();
  if (verifyExitBeforeDone && (runtimeError || exitCode !== 0)) {
    if (pendingDone || !translator.terminalEmitted()) {
      const detail = runtimeError?.message ?? Buffer.concat(stderrChunks).toString('utf8').trim().slice(0, 500);
      yield {
        type: 'error', terminationReason: 'failed',
        message: formatError(`${agentName} exited with ${child.signalCode ?? `code ${exitCode}`}${detail ? `: ${detail}` : ''}`),
      };
    }
    return;
  }
  if (pendingDone) {
    yield pendingDone;
    return;
  }
  if (exitCode !== 0 && exitCode !== null) {
    if (!translator.terminalEmitted()) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
      yield* translator.fail(`${agentName} exited with code ${exitCode}${detail}`);
    }
    return;
  }
  if (runtimeError && !translator.terminalEmitted()) {
    yield* translator.fail(formatError(`${agentName} runtime error: ${runtimeError.message}`));
    return;
  }

  yield* translator.finish();
}

async function waitForExitCode(child: JsonlChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}
