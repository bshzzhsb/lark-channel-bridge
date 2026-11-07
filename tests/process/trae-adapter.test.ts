import { afterEach, describe, expect, it, vi } from 'vitest';

import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TraeAdapter } from '@/agent/trae/adapter';
import type { AgentEvent } from '@/agent/types';
import { listTraeThreadHistory } from '@/session/trae-history';

import { type FakeTraeOptions, writeFakeTrae } from '../helpers/fake-trae';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(options: FakeTraeOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'trae-process-'));
  roots.push(dir);
  return { dir: await realpath(dir), ...await writeFakeTrae(dir, options) };
}
async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const e of events) result.push(e);
  return result;
}
const success = [
  { type: 'thread.started', thread_id: 'trae-test-thread' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'hello from TRAE' } },
  { type: 'turn.completed' },
];

describe('TRAE process transport', () => {
  it('inherits TRAE state and config, injects the bridge identity, and resumes via an explicit thread', async () => {
    const f = await fixture({ events: success });
    vi.stubEnv('TRAE_HOME', '/user/trae');
    vi.stubEnv('TRAECLI_HOME', '/user/trae-runtime');
    vi.stubEnv('CODEX_HOME', '/unrelated/codex');
    const adapter = new TraeAdapter({
      binary: f.binary,
      larkChannel: { profile: 'trae-work', rootDir: f.dir, larkCliConfigDir: join(f.dir, 'lark-cli') },
    });
    adapter.setBotIdentity({ openId: 'ou_trae_bot', name: 'TRAE Bot' });
    await adapter.prepareRun();
    const run = adapter.run({
      runId: 'test-run', cwd: f.dir, prompt: 'user prompt',
      threadId: 'previous-thread', model: 'custom-trae-model', images: ['/image.png'], sandbox: 'read-only',
    });
    expect(await collect(run.events)).toEqual([
      { type: 'system', threadId: 'trae-test-thread' },
      { type: 'final_text', content: 'hello from TRAE' },
      { type: 'done', threadId: 'trae-test-thread', terminationReason: 'normal' },
    ]);
    expect(await run.waitForExit(100)).toBe(true);
    const record = JSON.parse(await readFile(f.recordPath, 'utf8'));
    expect(record.env).toMatchObject({
      TRAE_HOME: '/user/trae', TRAECLI_HOME: '/user/trae-runtime', CODEX_HOME: '/unrelated/codex',
      LARK_CHANNEL_PROFILE: 'trae-work', LARKSUITE_CLI_CONFIG_DIR: join(f.dir, 'lark-cli'),
    });
    expect(record.stdin).toContain('ou_trae_bot');
    expect(record.stdin).toContain('user prompt');
    expect(record.argv).not.toContain('user prompt');
    expect(record.argv.slice(-5)).toEqual(['--json', '--image', '/image.png', 'previous-thread', '-']);
    expect(record.argv).not.toContain('--profile');
  });

  it.each([
    { events: [], exitCode: 4 },
    { events: success, exitCode: 7 },
    { events: success.slice(0, -1), exitCode: 0 },
  ])('fails abnormal or incomplete runs without a success event: %j', async (options) => {
    const f = await fixture(options);
    const run = new TraeAdapter({ binary: f.binary }).run({ runId: 'failed', cwd: f.dir, prompt: 'hi' });
    const events = await collect(run.events);
    expect(events.at(-1)).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it.each([false, true])('stops a running process, including one ignoring SIGTERM (%s)', async (ignoreTerm) => {
    const f = await fixture({ events: success.slice(0, 1), hang: true, ignoreTerm });
    const run = new TraeAdapter({ binary: f.binary, stopGraceMs: 30 }).run({ runId: 'stop', cwd: f.dir, prompt: 'hi' });
    const events: AgentEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.type === 'system') await run.stop();
    }
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'interrupted' });
    expect(await run.waitForExit(100)).toBe(true);
  });

  it('reports an executable disappearing between preflight and spawn', async () => {
    const f = await fixture();
    const run = new TraeAdapter({ binary: join(f.dir, 'missing') }).run({ runId: 'missing', cwd: f.dir, prompt: 'hi' });
    expect((await collect(run.events)).at(-1)).toMatchObject({ type: 'error', terminationReason: 'failed' });
  });

  it('directs authentication failures to terminal login without starting an interactive command', async () => {
    const f = await fixture({ exitCode: 1, stderr: 'No Trae auth token available' });
    const run = new TraeAdapter({ binary: f.binary }).run({ runId: 'auth', cwd: f.dir, prompt: 'hi' });
    const events = await collect(run.events);
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('traecli login') });
    const record = JSON.parse(await readFile(f.recordPath, 'utf8'));
    expect(record.argv[0]).toBe('exec');
    expect(record.argv).not.toContain('login');
  });
});

describe('TRAE native history', () => {
  it('waits for initialize, sends initialized, filters the cwd, and preserves TRAE env', async () => {
    const f = await fixture({ history: { data: [
      { id: 'older', cwd: '/repo', createdAt: 1, updatedAt: 10, source: 'exec', preview: 'older' },
      { id: 'outside', cwd: '/other', updatedAt: 40, preview: 'must not be exposed' },
      { id: 'newer', cwd: '/repo', createdAt: 2, updatedAt: 20, source: 'cli', preview: 'newer' },
    ] } });
    vi.stubEnv('TRAE_HOME', '/custom/trae');
    const history = await listTraeThreadHistory({ binary: f.binary, cwd: '/repo', limit: 1 });
    expect(history.map((e) => e.threadId)).toEqual(['newer']);
    const record = JSON.parse(await readFile(f.recordPath, 'utf8'));
    expect(record.argv).toEqual(['app-server', '--listen', 'stdio://']);
    expect(record.env.TRAE_HOME).toBe('/custom/trae');
    expect(record.requests.map((r: { method: string }) => r.method)).toEqual(['initialize', 'initialized', 'thread/list']);
    expect(record.requests[2].params).toMatchObject({ cwd: '/repo', archived: false, sortKey: 'updated_at' });
  });

  it.each([{ initError: true }, { historyError: true }, { history: { invalid: [] } }])('rejects failed initialization or malformed history: %j', async (options) => {
    const f = await fixture(options);
    await expect(listTraeThreadHistory({ binary: f.binary, cwd: '/repo', limit: 2 })).rejects.toThrow();
  });

  it('bounds history startup time', async () => {
    const f = await fixture();
    await expect(listTraeThreadHistory({ binary: f.binary, cwd: '/repo', limit: 2, timeoutMs: 1 }))
      .rejects.toMatchObject({ code: 'timeout' });
  });
});
