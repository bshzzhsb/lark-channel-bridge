import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { join } from 'node:path';

import type { AgentEvent } from '@/agent/types';
import { ActiveRuns } from '@/bot/active-runs';
import { CotClient, RunCot } from '@/bot/cot';
import { createImPromptPreparer } from '@/bot/im/prompt';
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
  const run = async (options: AgentRunOptions = {}, target = runner, cotMode: 'off' | 'brief' = 'off', events?: AgentEvent[]) => {
    agent.setEvents(events ?? [
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
  it.each(['markdown', 'text', 'card'] as const)('sends clarification requests once with real mentions in %s', async (mode) => {
    const h = await harness();
    h.controls.cfg.preferences = { ...h.controls.cfg.preferences, messageReply: mode };
    vi.spyOn(h.cotClient, 'create').mockResolvedValue({ cot_id: 'cot-clarify', message_id: 'om_progress' });
    vi.spyOn(h.cotClient, 'update').mockResolvedValue(undefined);
    vi.spyOn(h.cotClient, 'complete').mockResolvedValue(undefined);
    const finalText = '已完成资料整理。\n\n**待补充信息：**\n'
      + '- [[at:ou_assigner]]：请补充验收标准。\n'
      + '- [[at:ou_assigner]]：请补充相识日期和城市。\n'
      + '- [[at:user-1]]：请补充未确定派发者的任务背景。';
    for (const cotMode of ['off', 'brief'] as const) {
      for (const stage of ['onboard-task', 'guard'] as const) {
        const sentBefore = h.fakeChannel.sent.length;
        const mentions = ['user-1', 'ou_assigner', 'ou_assigner', 'ou_observer'];
        const { result } = await h.run({ reply: 'normal', stage,
          ...(stage === 'guard' ? { resolveCompletionMentions: () => mentions } : { completionMentions: mentions }),
        }, h.runner, cotMode, [
          { type: 'final_text', content: finalText }, { type: 'done', terminationReason: 'normal' },
        ]);
        expect(result).toMatchObject({ finalText, replyMessageId: expect.stringMatching(/^om_fake_/) });
        expect(h.fakeChannel.sent).toHaveLength(sentBefore + 1);
        const sent = h.fakeChannel.sent.at(-1)!;
        expect(JSON.stringify(sent.content)).toContain('待补充信息');
        expect(JSON.stringify(sent.content).split('**待补充信息：**')).toHaveLength(2);
        expect(JSON.stringify(sent.content)).not.toContain('[[at:');
        if (mode === 'card') {
          const card = JSON.stringify(sent.content);
          expect(card.split('<at id=\\"ou_assigner\\"></at>')).toHaveLength(3);
          expect(card).toContain('- <at id=\\"ou_assigner\\"></at>：请补充验收标准');
          expect(card).toContain('- <at id=\\"ou_assigner\\"></at>：请补充相识日期和城市');
          expect(card).toContain('- <at id=\\"user-1\\"></at>：请补充未确定派发者的任务背景');
          expect(card).toContain('ou_observer');
        } else {
          expect(sent.content).toEqual({ markdown: finalText
            .replaceAll('[[at:ou_assigner]]', '<at user_id="ou_assigner"></at>')
            .replaceAll('[[at:user-1]]', '<at user_id="user-1"></at>') });
          expect(sent.options).toMatchObject({ mentions: [{ openId: 'ou_observer' }] });
        }
      }
    }
  });

  it.each(['markdown', 'text', 'card'] as const)('drops inline mentions outside the current completion recipients in %s', async (mode) => {
    const h = await harness();
    h.controls.cfg.preferences = { ...h.controls.cfg.preferences, messageReply: mode };
    await h.run({ reply: 'normal', stage: 'guard', completionMentions: ['ou_removed', 'user-1'],
      resolveCompletionMentions: () => ['user-1'],
    }, h.runner, 'off', [
      { type: 'final_text', content: '**待补充信息：**\n- [[at:ou_removed]] [[at:ou_unknown]]：请补充城市。' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const sent = h.fakeChannel.sent[0]!;
    expect(JSON.stringify(sent.content)).toContain('请补充城市');
    expect(JSON.stringify(sent.content)).not.toContain('ou_removed');
    expect(JSON.stringify(sent.content)).not.toContain('ou_unknown');
    expect(JSON.stringify(sent.content)).not.toContain('[[at:');
    if (mode === 'card') expect(JSON.stringify(sent.content)).toContain('user-1');
    else expect(sent.options).toMatchObject({ mentions: [{ openId: 'user-1' }] });
  });

  it.each(['markdown', 'text', 'card'] as const)('applies lifecycle options and returns reply receipts and mentions in %s with and without COT', async (mode) => {
    const h = await harness();
    h.controls.cfg.preferences = { ...h.controls.cfg.preferences, messageReply: mode };
    const addReaction = vi.fn();
    Object.assign(h.deps.channel, { addReaction });
    vi.spyOn(h.cotClient, 'create').mockResolvedValue({ cot_id: 'cot-guard', message_id: 'om_progress' });
    vi.spyOn(h.cotClient, 'update').mockResolvedValue(undefined);
    vi.spyOn(h.cotClient, 'complete').mockResolvedValue(undefined);
    const onProgress = vi.fn(async () => {});
    for (const cotMode of ['off', 'brief'] as const) {
      const { result } = await h.run({ reply: 'normal', stage: 'task',
        completionMentions: ['ou_guarded', 'user-1'],
        instructions: ['任务说明：协助 ou_guarded 回应发送者。'], pendingReaction: false,
        beforeRun: async () => true, shouldSendReply: () => true, onProgress,
      }, h.runner, cotMode);
      expect(result).toMatchObject({ replyMessageId: expect.stringMatching(/^om_fake_/), finalText: 'answer' });
      expect(h.agent.runOptions.at(-1)?.prompt).toContain('任务说明');
      expect(h.agent.runOptions.at(-1)?.prompt).toContain('ou_guarded');
      const sent = h.fakeChannel.sent.at(-1)!;
      if (mode === 'card') {
        expect(JSON.stringify(sent.content)).toContain('ou_guarded');
        expect(JSON.stringify(sent.content)).toContain('user-1');
      } else expect(sent.options).toMatchObject({ mentions: [{ openId: 'ou_guarded' }, { openId: 'user-1' }] });
    }
    expect(onProgress).toHaveBeenCalledWith('om_progress');
    expect(addReaction).not.toHaveBeenCalled();
  });

  it('skips runs before spawn and suppresses final replies through lifecycle callbacks', async () => {
    const h = await harness();
    const skipped = await h.run({ beforeRun: async () => false, reply: 'normal' });
    expect(skipped.result).toBeUndefined(); expect(h.agent.runOptions).toHaveLength(0);
    const canceled = await h.run({ beforeRun: async () => true, shouldSendReply: () => false,
      reply: 'normal' });
    expect(canceled.result).not.toHaveProperty('replyMessageId');
    expect(h.fakeChannel.sent).toEqual([]);
  });

  it('returns send failures without a successful reply receipt', async () => {
    const h = await harness();
    vi.spyOn(h.deps.channel, 'send').mockRejectedValueOnce(new Error('send failed'));
    const { result } = await h.run({ reply: 'normal', completionMentions: ['ou_guarded'],
      beforeRun: async () => true, shouldSendReply: () => true });
    expect(result).toEqual({ error: 'send failed' });
  });

  it.each(['markdown', 'text', 'card'] as const)('checks reply outcome and resolves mentions at send time in %s', async (mode) => {
    const h = await harness();
    h.controls.cfg.preferences = { ...h.controls.cfg.preferences, messageReply: mode };
    let recipients = ['ou_removed'];
    const shouldSendReply = vi.fn((outcome) => {
      expect(outcome).toMatchObject({ finalText: 'answer' });
      expect(outcome.error).toBeUndefined();
      recipients = ['ou_current', 'ou_current', ''];
      return true;
    });
    const resolveCompletionMentions = vi.fn(() => recipients);
    await h.run({ reply: 'normal', completionMentions: ['ou_fallback'],
      shouldSendReply, resolveCompletionMentions });
    expect(shouldSendReply).toHaveBeenCalledTimes(1);
    expect(resolveCompletionMentions).toHaveBeenCalledTimes(1);
    expect(h.fakeChannel.streams).toEqual([]);
    const sent = h.fakeChannel.sent[0]!;
    if (mode === 'card') {
      expect(JSON.stringify(sent.content)).toContain('ou_current');
      expect(JSON.stringify(sent.content)).not.toContain('ou_fallback');
    } else expect(sent.options).toMatchObject({ mentions: [{ openId: 'ou_current' }] });
  });

  it.each(['markdown', 'text', 'card'] as const)('suppresses failed replies without streaming in %s', async (mode) => {
    const h = await harness();
    h.controls.cfg.preferences = { ...h.controls.cfg.preferences, messageReply: mode };
    const shouldSendReply = vi.fn((outcome) => !outcome.error);
    const resolveCompletionMentions = vi.fn(() => ['ou_user']);
    const { result } = await h.run({ reply: 'normal', shouldSendReply, resolveCompletionMentions },
      h.runner, 'off', [{ type: 'error', message: 'agent failed', terminationReason: 'failed' }]);
    expect(result).toMatchObject({ error: 'agent failed' });
    expect(result).not.toHaveProperty('replyMessageId');
    expect(shouldSendReply).toHaveBeenCalledWith(expect.objectContaining({ error: 'agent failed' }));
    expect(resolveCompletionMentions).not.toHaveBeenCalled();
    expect(h.fakeChannel.sent).toEqual([]);
    expect(h.fakeChannel.streams).toEqual([]);
  });

  it('appends caller instructions to custom prompts after beforeRun', async () => {
    const h = await harness();
    const instructions: string[] = [];
    await h.run({ prompt: 'custom task', instructions, beforeRun: async () => {
      instructions.push('additional instructions');
      return true;
    } });
    expect(h.agent.runOptions[0]?.prompt).toBe('additional instructions\n\ncustom task');
  });

  it.each([undefined, 'custom task'])('includes generic background separately from user input with prompt %s', async (prompt) => {
    const h = await harness();
    await h.run({ prompt, contextMessages: [
      { messageId: 'om_background', senderId: 'ou_author', createdAt: '2026-09-27T10:00:00.000Z', content: 'background discussion' },
      { messageId: 'om_background', senderId: 'ou_author', content: 'duplicate discussion' },
      { messageId: 'message-1', senderId: 'user-1', content: 'duplicate trigger' },
    ] });
    const built = h.agent.runOptions[0]!.prompt;
    expect(built).toContain('<message_context>');
    expect(built).toContain('background discussion');
    expect(built).not.toContain('duplicate discussion');
    expect(built).not.toContain('duplicate trigger');
    expect(built).toContain(`"text":"${prompt ?? 'hello'}"`);
  });

  it('deduplicates background against explicit quotes and topic history', async () => {
    const h = await harness();
    const raw = (id: string) => ({ message_id: id, msg_type: 'text', create_time: '1000',
      sender: { id: 'ou_author', sender_type: 'user' }, body: { content: JSON.stringify({ text: id }) } });
    vi.spyOn(h.deps.channel, 'fetchRawMessage').mockImplementation(async (id) =>
      [raw(id)] as unknown as Awaited<ReturnType<LarkChannel['fetchRawMessage']>>);
    Object.assign(h.deps.channel.rawClient.im.v1.message, {
      list: vi.fn(async () => ({ code: 0, data: { items: [raw('om_topic')], has_more: false } })),
    });
    const prepare = createImPromptPreparer(h.deps);
    const { prompt } = await prepare({
      batch: [{ ...message(), threadId: 'omt_topic', rootId: 'om_root', replyToMessageId: 'om_quote' }],
      scope: 'chat-1:omt_topic', mode: 'topic', cotRun: {} as RunCot,
      runOptions: { contextMessages: ['om_quote', 'om_root', 'om_topic', 'om_background'].map((messageId) =>
        ({ messageId, senderId: 'ou_author', content: `background ${messageId}` })) },
    });
    const context = JSON.parse(prompt.match(/<message_context>\n(.*?)\n<\/message_context>/s)![1]!) as {
      messages: Array<{ messageId: string }>;
    };
    expect(context.messages.map((m) => m.messageId)).toEqual(['om_background']);
    expect(prompt).toContain('<quoted_messages>');
    expect(prompt).toContain('<topic_context>');
  });

  it('notifies both runner and per-run progress observers', async () => {
    const h = await harness();
    const globalProgress = vi.fn(async () => {});
    const runProgress = vi.fn(async () => {});
    const runner = createImRunner({ ...h.deps, onProgress: globalProgress });
    vi.spyOn(h.cotClient, 'create').mockResolvedValue({ cot_id: 'cot-task', message_id: 'om_progress' });
    vi.spyOn(h.cotClient, 'update').mockResolvedValue(undefined);
    vi.spyOn(h.cotClient, 'complete').mockResolvedValue(undefined);
    await h.run({ onProgress: runProgress }, runner, 'brief');
    expect(globalProgress).toHaveBeenCalledWith('om_progress');
    expect(runProgress).toHaveBeenCalledWith('om_progress');
  });

  it('calls beforeRun after earlier runs finish in the same scope', async () => {
    const h = await harness();
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const resolveMedia = h.deps.media.resolve.bind(h.deps.media);
    vi.spyOn(h.deps.media, 'resolve').mockImplementationOnce(async (...args) => {
      await blocked; return resolveMedia(...args);
    });
    const first = h.run();
    const beforeRun = vi.fn(async () => true);
    const second = h.run({ beforeRun });
    await vi.waitFor(() => expect(h.deps.media.resolve).toHaveBeenCalledTimes(1));
    expect(beforeRun).not.toHaveBeenCalled();
    unblock();
    await Promise.all([first, second]);
    expect(beforeRun).toHaveBeenCalledTimes(1);
    expect(h.agent.runOptions).toHaveLength(2);
  });

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
