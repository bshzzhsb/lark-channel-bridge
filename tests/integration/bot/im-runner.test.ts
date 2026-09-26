import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { join } from 'node:path';

import { ActiveRuns } from '@/bot/active-runs';
import { CotClient, RunCot } from '@/bot/cot';
import { createImRunner } from '@/bot/im/runner';
import { ProcessPool } from '@/bot/process-pool';
import type { AgentRunOptions, Controls } from '@/commands';
import { createDefaultProfileConfig } from '@/config/profile-schema';
import { MediaCache } from '@/media/cache';
import { RunExecutor } from '@/runtime/run-executor';
import { SessionStore } from '@/session/store';
import { WorkspaceStore } from '@/workspace/store';

import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createFakeChannel } from '../../helpers/fake-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
});

function message(): NormalizedMessage {
  return {
    messageId: 'message-1', chatId: 'chat-1', chatType: 'p2p', senderId: 'user-1',
    content: 'hello', resources: [], mentions: [], mentionedBot: false, mentionAll: false,
    rawContentType: 'text', createTime: 1,
  };
}

async function harness() {
  const tmp = await createTmpProfile('im-runner-');
  const config = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['user-1'] },
  });
  config.workspaces.default = tmp.workspace;

  const controls: Controls = {
    cfg: config, profileConfig: config, profile: 'test', processId: 'test-process',
    configPath: join(tmp.profile, 'config.json'), ownerRefreshState: 'ok',
    refreshOwner: async () => {}, restart: async () => {}, exit: async () => {},
  };
  const agent = new FakeAgentAdapter({ id: 'claude' });
  const activeRuns = new ActiveRuns();
  const executor = new RunExecutor({ agent, pool: new ProcessPool(() => 2), activeRuns });
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const fakeChannel = createFakeChannel();
  const channel = fakeChannel as unknown as LarkChannel;
  const media = new MediaCache(channel, join(tmp.profile, 'media'));
  const deps = { channel, executor, sessions, workspaces, media, controls };
  const runner = createImRunner(deps);
  const cotClient = new CotClient({ tenant: 'feishu', appId: 'test', appSecret: 'secret' });
  const run = async (options: AgentRunOptions = {}, target = runner, cotMode: 'off' | 'brief' = 'off') => {
    agent.setEvents([
      { type: 'system', sessionId: 'session-1' },
      { type: 'final_text', content: 'answer' },
      { type: 'done', sessionId: 'session-1', terminationReason: 'normal' },
    ]);
    const cotRun = new RunCot({
      client: cotClient, mode: () => cotMode, chatId: 'chat-1', originMessageId: 'message-1',
      replyInThread: false, scope: 'chat-1', inputPreview: 'hello',
    });
    const finish = vi.spyOn(cotRun, 'finish');
    const result = await target.run({
      batch: [message()], scope: 'chat-1', mode: 'p2p', cotRun,
      runOptions: { reply: 'silent', ...options },
    });
    return { result, finish };
  };
  cleanups.push(async () => {
    await activeRuns.stopAll();
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { run, runner, deps, agent, sessions, controls, fakeChannel, cotClient };
}

describe('IM runner lifecycle', () => {
  it.each(['markdown', 'text', 'card'] as const)('mentions the requester in the final %s result with COT off', async (mode) => {
    const h = await harness();
    h.controls.cfg.preferences = { ...h.controls.cfg.preferences, messageReply: mode };
    await h.run({ reply: 'normal', stage: 'onboard-task',
      completionMentions: ['ou_requester', 'ou_assigner', 'ou_assigner'] });
    expect(h.fakeChannel.sent).toHaveLength(1);
    const result = h.fakeChannel.sent[0]!;
    if (mode === 'card') {
      expect(JSON.stringify(result.content)).toContain('<at id=\\"ou_requester\\"></at>');
      expect(JSON.stringify(result.content).split('<at id=\\"ou_assigner\\"></at>')).toHaveLength(2);
      expect(JSON.stringify(result.content)).toContain('answer');
    } else {
      expect(result.content).toEqual({ markdown: 'answer' });
      expect(result.options).toMatchObject({ mentions: [{ openId: 'ou_requester' }, { openId: 'ou_assigner' }] });
    }
  });

  it('closes a degraded COT and mentions the requester in the final result', async () => {
    const h = await harness();
    h.controls.cfg.preferences = { ...h.controls.cfg.preferences, messageReply: 'markdown' };
    const create = vi.spyOn(h.cotClient, 'create').mockResolvedValue({ cot_id: 'cot-1', message_id: 'cot-message-1' });
    vi.spyOn(h.cotClient, 'update').mockRejectedValue(new TypeError('fetch failed'));
    const complete = vi.spyOn(h.cotClient, 'complete').mockResolvedValue(undefined);
    await h.run({ reply: 'normal', stage: 'onboard-task', completionMentions: ['ou_requester'] }, h.runner, 'brief');
    expect(create).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({ cotId: 'cot-1', messageId: 'cot-message-1' }, 'done');
    const result = h.fakeChannel.sent.at(-1)!;
    expect(result.content).toEqual({ markdown: 'answer' });
    expect(result.options).toMatchObject({ mentions: [{ openId: 'ou_requester' }] });
    expect(h.fakeChannel.sent[0]?.options).not.toHaveProperty('mentions');
  });

  it('returns silent results without persisting the session when disabled', async () => {
    const h = await harness();
    const { result, finish } = await h.run({ persistSession: false });
    expect(result).toMatchObject({ finalText: 'answer', sessionId: 'session-1' });
    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(h.fakeChannel.sent).toEqual([]);
    expect(h.fakeChannel.streams).toEqual([]);
    expect(h.runner.policyFingerprintForScope('chat-1')).toBeUndefined();
    expect(finish).toHaveBeenCalledWith('done');
  });

  it('reads replacement configuration and adds a model change note once', async () => {
    const h = await harness();
    await h.run();
    const next = { ...h.controls.profileConfig,
      preferences: { ...h.controls.profileConfig.preferences, model: 'opus' },
    };
    h.controls.cfg = next;
    h.controls.profileConfig = next;
    await h.run();
    await h.run();
    expect(h.agent.runOptions[0]?.prompt).not.toContain('用户刚把本会话使用的模型切换');
    expect(h.agent.runOptions[1]?.prompt).toContain('用户刚把本会话使用的模型切换');
    expect(h.agent.runOptions[1]?.model).toBe('opus');
    expect(h.agent.runOptions[2]?.prompt).not.toContain('用户刚把本会话使用的模型切换');
  });

  it('keeps model history separate for runners sharing the same stores', async () => {
    const h = await harness();
    await h.run();
    h.controls.profileConfig.preferences.model = 'opus';
    const otherRunner = createImRunner(h.deps);
    await h.run({}, otherRunner);
    await h.run();
    expect(h.agent.runOptions[1]?.prompt).not.toContain('用户刚把本会话使用的模型切换');
    expect(h.agent.runOptions[2]?.prompt).toContain('用户刚把本会话使用的模型切换');
  });

  it('finishes COT and clears callback state when prompt preparation fails', async () => {
    const h = await harness();
    const finish = vi.spyOn(RunCot.prototype, 'finish');
    vi.spyOn(h.deps.media, 'resolve').mockRejectedValueOnce(new Error('media failed'));
    await expect(h.run()).rejects.toThrow('media failed');
    expect(finish).toHaveBeenCalledWith('done');
    expect(h.runner.policyFingerprintForScope('chat-1')).toBeUndefined();
    expect(h.agent.runOptions).toEqual([]);
    await expect(h.run()).resolves.toMatchObject({ result: { finalText: 'answer' } });
  });
});
