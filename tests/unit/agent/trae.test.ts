import { afterEach, describe, expect, it, vi } from 'vitest';

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { capabilityForProfile, usesThreadSessions } from '@/agent/capability';
import { buildTraeArgs } from '@/agent/trae/argv';
import { TraeJsonlTranslator } from '@/agent/trae/jsonl';
import { checkTraeAvailability } from '@/agent/trae/preflight';
import type { AgentEvent } from '@/agent/types';
import { detectInstalledAgents } from '@/cli/agent-detection';
import { createBootstrapTraeConfig } from '@/cli/profile-bootstrap';
import { createDefaultProfileConfig } from '@/config/profile-schema';
import { createRootConfig, loadRootConfig, saveRootConfig } from '@/config/profile-store';
import { createRuntimeAgent } from '@/runtime/agent-runtime';

import { writeVersionExecutable } from '../../helpers/fake-executable';
import { writeFakeTrae } from '../../helpers/fake-trae';

const roots: string[] = [];
async function root() {
  const dir = await mkdtemp(join(tmpdir(), 'trae-unit-'));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('TRAE configuration and capabilities', () => {
  it('only discovers traecli and never probes the other executable name', async () => {
    const dir = await root();
    vi.stubEnv('PATH', dir);
    vi.stubEnv('LARK_CHANNEL_CLAUDE_BIN', join(dir, 'missing-claude'));
    vi.stubEnv('LARK_CHANNEL_CODEX_BIN', join(dir, 'missing-codex'));
    vi.stubEnv('LARK_CHANNEL_TRAE_BIN', 'traecli');
    await writeVersionExecutable(dir, 'traex', 'traecli 0.212.1');
    expect(await detectInstalledAgents()).toEqual([]);
    const path = await writeVersionExecutable(dir, 'traecli', 'traecli 0.212.1');
    expect(await detectInstalledAgents()).toEqual([{ kind: 'trae', binaryPath: path }]);
  });

  it('honors explicit paths before the environment and never falls back from invalid explicit paths', async () => {
    const dir = await root();
    const fake = await writeFakeTrae(dir);
    vi.stubEnv('LARK_CHANNEL_TRAE_BIN', join(dir, 'missing'));
    expect(await createBootstrapTraeConfig(fake.binary)).toEqual({ binaryPath: fake.binary });
    vi.stubEnv('LARK_CHANNEL_TRAE_BIN', fake.binary);
    expect(await createBootstrapTraeConfig(undefined)).toEqual({ binaryPath: fake.binary });
    await expect(createBootstrapTraeConfig(join(dir, 'missing'))).rejects.toMatchObject({
      diagnostic: { agentId: 'trae', code: 'agent-binary-not-found' },
    });
  });

  it.each([{ version: 'coco 1.0.0' }, { unsupportedExec: true }])('rejects a legacy or incompatible CLI: %j', async (options) => {
    const fake = await writeFakeTrae(await root(), options);
    expect(await checkTraeAvailability(fake.binary)).toMatchObject({
      ok: false, diagnostic: { agentId: 'trae', code: 'agent-capability-unsupported' },
    });
  });

  it('round-trips TRAE configuration and constructs an independent runtime adapter', async () => {
    const dir = await root();
    const profile = createDefaultProfileConfig({
      agentKind: 'trae', trae: { binaryPath: '/usr/local/bin/traecli' },
      accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
    });
    await saveRootConfig(createRootConfig('trae', profile), join(dir, 'config.json'));
    const loaded = (await loadRootConfig(join(dir, 'config.json')))!.profiles.trae!;
    expect(loaded.trae).toEqual(profile.trae);
    expect(loaded.codex).toBeUndefined();
    expect(capabilityForProfile(loaded)).toMatchObject({ agentId: 'trae', sessionKind: 'trae-thread' });
    expect(usesThreadSessions('trae')).toBe(true);
    expect(createRuntimeAgent(loaded, { profileDir: dir }).id).toBe('trae');
  });
});

describe('TRAE argv and actual JSONL contract', () => {
  it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)('sets %s before resume and retains user settings', (sandbox) => {
    const args = buildTraeArgs({ cwd: '/repo with spaces', sandbox, threadId: 'thread-id', images: ['/image one.png'], model: 'custom-model' });
    expect(args).toEqual([
      'exec', '--sandbox', sandbox, '--model', 'custom-model', '-c', 'approval_policy="never"',
      '-c', 'shell_environment_policy.inherit="all"', '--skip-git-repo-check', '-C', '/repo with spaces',
      'resume', '--json', '--image', '/image one.png', 'thread-id', '-',
    ]);
    expect(args).not.toContain('--profile');
    expect(args).not.toContain('--ignore-rules');
    expect(args).not.toContain('--ignore-user-config');
    expect(args).not.toContain('--ephemeral');
    expect(args).not.toContain('-a');
  });

  it('omits the model flag when following the CLI default', () => {
    expect(buildTraeArgs({ cwd: '/repo', sandbox: 'read-only' })).not.toContain('--model');
  });

  it('translates a sanitized capture from traecli 0.212.1, including resumed command execution', async () => {
    const capture = await readFile(new URL('../../fixtures/traecli-0.212.1.jsonl', import.meta.url), 'utf8');
    const translator = new TraeJsonlTranslator();
    const events = capture.trim().split('\n').flatMap((line) => translator.translate(JSON.parse(line)));
    expect(events).toEqual(expect.arrayContaining([
      { type: 'system', threadId: 'trae-fixture-thread' },
      { type: 'tool_use', id: 'item_1', name: 'command_execution', input: { command: 'printf BRIDGE_TRAE_TOOL_OK' } },
      { type: 'tool_result', id: 'item_1', output: 'BRIDGE_TRAE_TOOL_OK', isError: false },
      { type: 'final_text', content: 'BRIDGE_TRAE_OK BRIDGE_TRAE_TOOL_OK' },
      { type: 'done', threadId: 'trae-fixture-thread', terminationReason: 'normal' },
    ] satisfies AgentEvent[]));
    expect(events.some((e) => e.type === 'thinking')).toBe(true);
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ inputTokens: 32423, outputTokens: 186 });
    expect(translator.finish()).toEqual([]);
  });
});
