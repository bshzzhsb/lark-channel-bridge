import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ActiveRuns } from '@/bot/active-runs';
import { ChatModeCache } from '@/bot/chat-mode-cache';
import { GuardManager } from '@/bot/guard';
import { GuardStore } from '@/bot/guard-store';
import { createMessageIntake } from '@/bot/im/intake';
import { PendingQueue } from '@/bot/pending-queue';
import { ProcessPool } from '@/bot/process-pool';
import type { FeishuMessageItem } from '@/bot/quote';
import type { AgentRunRequest, AgentRunResult, CommandContext, Controls } from '@/commands';
import { createDefaultProfileConfig } from '@/config/profile-schema';
import { RunExecutor } from '@/runtime/run-executor';
import { SessionStore } from '@/session/store';
import { WorkspaceStore } from '@/workspace/store';

import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((fn) => fn())); });

function message(id = 'om_question', ids = ['ou_me']): NormalizedMessage {
  return { messageId: id, chatId: 'oc_group', chatType: 'group', senderId: 'ou_sender',
    content: '请帮忙回答', createTime: 100_000, rawContentType: 'text',
    mentions: ids.map((openId) => ({ key: `@${openId}`, openId })),
    resources: [], mentionAll: false, mentionedBot: false };
}

function item(id: string, time = 100_000, sender = 'ou_sender', mentions = ['ou_me']): FeishuMessageItem {
  return { message_id: id, create_time: String(time), msg_type: 'text',
    body: { content: JSON.stringify({ text: id }) },
    sender: { id: sender, id_type: 'open_id', sender_type: 'user', tenant_key: 'tenant' },
    mentions: mentions.map((id, index) => ({ key: `@_user_${index}`, id, id_type: 'open_id', name: id, tenant_key: 'tenant' })) };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function harness(initialState?: unknown) {
  const tmp = await createTmpProfile('guard-');
  const cfg = createDefaultProfileConfig({ agentKind: 'claude',
    accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
    access: { allowedChats: ['oc_group'] } });
  cfg.workspaces.default = tmp.workspace;
  const controls: Controls = { cfg, profileConfig: cfg, profile: 'test', processId: 'test',
    configPath: join(tmp.profile, 'config.json'), ownerRefreshState: 'ok',
    refreshOwner: async () => {}, restart: async () => {}, exit: async () => {} };
  const raw = new Map<string, FeishuMessageItem>();
  raw.set('om_question', item('om_question'));
  let history: FeishuMessageItem[] = [];
  const threads = new Map<string, FeishuMessageItem[]>();
  const list = vi.fn(async ({ params }: { params: { container_id_type: string; container_id: string; page_token?: string; end_time?: string } }) => {
    const source = params.container_id_type === 'thread' ? threads.get(params.container_id) ?? [] : history;
    const sorted = source.filter((m) => !params.end_time || Number(m.create_time) < Number(params.end_time) * 1000)
      .sort((a, b) => Number(b.create_time) - Number(a.create_time));
    const offset = Number(params.page_token ?? 0);
    return { code: 0, data: { items: sorted.slice(offset, offset + 50), has_more: sorted.length > offset + 50,
      page_token: sorted.length > offset + 50 ? String(offset + 50) : undefined } };
  });
  const send = vi.fn(async (_chatId: string, _content: unknown, _options?: unknown) => ({ messageId: 'om_notice' }));
  const addReaction = vi.fn(async (_messageId: string, _emoji: string) => 'reaction-1');
  const removeReaction = vi.fn(async () => {});
  const grant = vi.fn(async () => ({ data: { app: { scopes: [{ scope: 'im:message.group_msg' }] } } }));
  const channel = { botIdentity: { openId: 'ou_bot', name: 'bot' }, send, addReaction, removeReaction,
    getChatMode: async () => 'group', fetchRawMessage: vi.fn(async (id: string) => raw.has(id) ? [raw.get(id)!] : []),
    rawClient: { im: { v1: { message: { list } } }, application: { application: { get: grant } } },
  } as unknown as LarkChannel;
  const statePath = join(tmp.profile, 'guard.json');
  if (initialState) await writeFile(statePath, JSON.stringify(initialState));
  const store = new GuardStore(statePath);
  await store.load();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd('oc_group', tmp.workspace);
  const runs: AgentRunRequest[] = [];
  const runAgent = vi.fn(async (request: AgentRunRequest): Promise<AgentRunResult> => {
    if (!await request.beforeRun!()) return { scopeId: request.scopeId };
    runs.push(request);
    return { scopeId: request.scopeId, finalText: '答复', replyMessageId: `om_answer_${request.message.messageId}` };
  });
  const guard = new GuardManager({ channel, controls, store, sessions, workspaces, runAgent });
  const agent = new FakeAgentAdapter({ id: 'claude' });
  const pool = new ProcessPool(() => 2);
  const activeRuns = new ActiveRuns();
  const executor = new RunExecutor({ agent, pool, activeRuns });
  const pending = new PendingQueue(600, vi.fn());
  const ctx: CommandContext = { channel, controls, sessions, workspaces, agent, activeRuns,
    msg: { ...message('om_guard'), senderId: 'ou_me', mentionedBot: true, content: '/guard', createTime: 200_000 },
    scope: 'oc_group', chatMode: 'group', guard, runAgent };
  const intake = createMessageIntake({ channel, controls, sessions, workspaces, agent, activeRuns,
    pool, executor, pending, chatModeCache: new ChatModeCache(), logThreadModeOverride: vi.fn(), runAgent, guard });
  cleanups.push(async () => {
    guard.stop(); pending.cancelAll(); await guard.flush();
    await Promise.all([sessions.flush(), workspaces.flush()]); await tmp.cleanup();
  });
  return { guard, store, raw, threads, list, send, grant, addReaction, removeReaction,
    runAgent, runs, ctx, intake, pending, controls, statePath,
    setHistory: (items: FeishuMessageItem[]) => { history = items; for (const m of items) raw.set(m.message_id!, m); },
    async enable(id = 'ou_me') { await store.enable('oc_group', id); } };
}

describe('group guard', () => {
  it('acknowledges enabling only with DONE after the scan finishes', async () => {
    const h = await harness();
    const gate = deferred();
    const original = h.list.getMockImplementation()!;
    h.list.mockImplementationOnce(async (args) => { await gate.promise; return original(args); });
    await h.guard.command('', h.ctx);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.addReaction).not.toHaveBeenCalled();
    expect(h.removeReaction).not.toHaveBeenCalled();
    expect(h.addReaction).not.toHaveBeenCalledWith('om_guard', 'DONE');
    gate.resolve(); await h.guard.flush();
    expect(h.removeReaction).not.toHaveBeenCalled();
    expect(h.addReaction).toHaveBeenCalledWith('om_guard', 'DONE');
    await h.guard.command('on', h.ctx); await h.guard.flush();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.removeReaction).not.toHaveBeenCalled();
    expect(h.addReaction.mock.calls.map((args) => args[1])).toEqual(['DONE', 'DONE']);
  });

  it.each([
    ['conversation', 'group', false],
    ['thread', 'group', true],
    ['conversation', 'topic', true],
  ] as const)('routes guard notices using %s placement in %s chats', async (placement, mode, inThread) => {
    const h = await harness();
    h.controls.cfg.preferences = { ...h.controls.cfg.preferences, groupReplyPlacement: placement };
    h.ctx.chatMode = mode;
    for (const action of ['status', 'invalid']) {
      await h.guard.command(action, h.ctx);
      expect(h.send.mock.calls.at(-1)?.[2]).toEqual({ replyTo: 'om_guard', replyInThread: inThread });
    }
    h.list.mockRejectedValueOnce(new Error('history failed'));
    await h.guard.command('', h.ctx); await h.guard.flush();
    expect(h.send.mock.calls.at(-1)?.[2]).toEqual({ replyTo: 'om_guard', replyInThread: inThread });
    expect(h.addReaction).not.toHaveBeenCalled();
  });

  it('does not acknowledge success after disconnect during a history scan', async () => {
    const h = await harness();
    const gate = deferred();
    const original = h.list.getMockImplementation()!;
    h.list.mockImplementationOnce(async (args) => { await gate.promise; return original(args); });
    await h.guard.command('', h.ctx);
    h.guard.stop();
    expect(h.addReaction).not.toHaveBeenCalled();
    gate.resolve(); await h.guard.flush();
    expect(h.removeReaction).not.toHaveBeenCalled();
    expect(h.addReaction).not.toHaveBeenCalled();
  });

  it('shares an ongoing scan between repeated enable commands', async () => {
    const h = await harness();
    const gate = deferred();
    const original = h.list.getMockImplementation()!;
    h.list.mockImplementationOnce(async (args) => { await gate.promise; return original(args); });
    await Promise.all([h.guard.command('', h.ctx), h.guard.command('on', {
      ...h.ctx, msg: { ...h.ctx.msg, messageId: 'om_guard_again' },
    })]);
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.addReaction).not.toHaveBeenCalled();
    gate.resolve(); await h.guard.flush();
    expect(h.addReaction).toHaveBeenCalledWith('om_guard', 'DONE');
    expect(h.addReaction).toHaveBeenCalledWith('om_guard_again', 'DONE');
  });

  it('cancels the old scan when guard is switched off and starts a fresh one on enabling', async () => {
    const h = await harness();
    h.setHistory([item('om_old')]);
    const gate = deferred();
    const original = h.list.getMockImplementation()!;
    h.list.mockImplementationOnce(async (args) => { await gate.promise; return original(args); });
    await h.guard.command('', h.ctx);
    await h.guard.command('off', { ...h.ctx, msg: { ...h.ctx.msg, messageId: 'om_off' } });
    h.setHistory([item('om_old'), item('om_new', 250_000)]);
    await h.guard.command('', { ...h.ctx, msg: { ...h.ctx.msg, messageId: 'om_on', createTime: 300_000 } });
    gate.resolve(); await h.guard.flush();
    expect(h.runs.map((r) => r.message.messageId)).toEqual(['om_old', 'om_new']);
    expect(h.addReaction).not.toHaveBeenCalledWith('om_guard', 'DONE');
    expect(h.addReaction).toHaveBeenCalledWith('om_on', 'DONE');
  });

  it('acknowledges guard off with DONE instead of a chat reply', async () => {
    const h = await harness(); await h.enable();
    await h.guard.command('off', h.ctx);
    expect(h.store.enabled('oc_group')).toEqual([]);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.addReaction).toHaveBeenCalledWith('om_guard', 'DONE');
    expect(h.removeReaction).not.toHaveBeenCalled();
  });

  it('registers /guard through the command intake and requires a bot mention', async () => {
    const h = await harness();
    await h.intake({ ...h.ctx.msg, mentionedBot: false });
    expect(h.store.enabled('oc_group')).toEqual([]);
    await h.intake(h.ctx.msg); await h.guard.flush();
    expect(h.store.get('oc_group', 'ou_me')).toMatchObject({ enabled: true });
    await h.intake({ ...h.ctx.msg, content: '/guard off' }); await h.guard.flush();
    expect(h.store.enabled('oc_group')).toEqual([]);
    expect(h.runs).toEqual([]);
  });

  it('routes a non-@bot mention once, persisting only the subscription', async () => {
    const h = await harness(); await h.enable();
    await h.intake(message()); await h.intake(message()); await h.guard.flush();
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({ pendingReaction: false, mode: 'topic',
      scopeId: 'oc_group:root:om_question', sendOpts: { replyTo: 'om_question', replyInThread: true } });
    expect(h.runs[0]?.resolveCompletionMentions?.()).toEqual(['ou_me', 'ou_sender']);
    expect(h.runs[0]?.instructions?.[0]).toContain('守护模式');
    const instructions = h.runs[0]!.instructions!.join('\n');
    expect(instructions).toContain('完成信息足够、可以独立执行的部分');
    expect(instructions).toContain('待补充信息');
    expect(instructions).toContain('明确请原消息发送者 ou_sender 补充');
    expect(instructions).toContain('被守护成员（ou_me）补充');
    expect(instructions).toContain('不得将受阻任务描述为已完成');
    expect(instructions).toContain('**待补充信息：**\n- [[at:ou_sender]]：请补充相识日期和城市。');
    expect(instructions).toContain('被守护成员的标记（[[at:ou_me]]）');
    expect(h.addReaction).toHaveBeenCalledTimes(1);
    expect(h.addReaction).toHaveBeenCalledWith('om_question', 'OnIt');
    expect(h.removeReaction).toHaveBeenCalledTimes(1);
    expect(h.removeReaction).toHaveBeenCalledWith('om_question', 'reaction-1');
    const restored = new GuardStore(join(h.ctx.controls.configPath, '..', 'guard.json'));
    await restored.load();
    expect(restored.enabled('oc_group')).toEqual(['ou_me']);
    expect(restored.completed('oc_group', 'om_question')).toBe(false);
    expect(JSON.parse(await readFile(h.statePath, 'utf8'))).toEqual({
      subscriptions: [{ chatId: 'oc_group', userId: 'ou_me', enabled: true }],
    });
    await h.intake(message()); await h.guard.flush(); expect(h.runs).toHaveLength(1);
  });

  it('rescans on off/on using the new command time and retains only runtime deduplication', async () => {
    const h = await harness();
    h.setHistory([item('om_old')]);
    await h.guard.command('', h.ctx); await h.guard.flush();
    expect(h.runs.map((r) => r.message.messageId)).toEqual(['om_old']);
    h.list.mockClear();
    await h.guard.command('', h.ctx); await h.guard.flush();
    expect(h.list).not.toHaveBeenCalled();
    await h.guard.command('off', h.ctx);
    h.setHistory([item('om_old'), item('om_while_off', 250_000)]);
    await h.guard.command('', { ...h.ctx, msg: { ...h.ctx.msg, createTime: 300_000 } });
    await h.guard.flush();
    expect(h.runs.map((r) => r.message.messageId)).toEqual(['om_old', 'om_while_off']);
  });

  it('restores listening without scanning and removes legacy persisted ledgers', async () => {
    const h = await harness({
      subscriptions: [{ chatId: 'oc_group', userId: 'ou_me', enabled: true, scanned: true, scanBefore: 1 }],
      completed: { [JSON.stringify(['oc_group', 'om_question'])]: 'om_answer' },
      progress: ['om_cot'],
    });
    h.setHistory([item('om_question')]);
    expect(h.list).not.toHaveBeenCalled();
    expect(h.store.completed('oc_group', 'om_question')).toBe(false);
    expect(h.store.isProgress('om_cot')).toBe(false);
    expect(JSON.parse(await readFile(h.statePath, 'utf8'))).toEqual({
      subscriptions: [{ chatId: 'oc_group', userId: 'ou_me', enabled: true }],
    });
    await h.guard.command('', h.ctx); await h.guard.flush();
    expect(h.list).not.toHaveBeenCalled();
    expect(h.runs).toEqual([]);
    h.raw.set('om_live', item('om_live', 210_000));
    await h.intake(message('om_live')); await h.guard.flush();
    expect(h.runs.map((r) => r.message.messageId)).toEqual(['om_live']);
    // After restart, thread history is still checked before a command-triggered reply.
    h.raw.set('om_question', { ...item('om_question'), thread_id: 'omt_question' });
    h.threads.set('omt_question', [{ ...item('om_answer', 150_000, 'ou_bot', []), parent_id: 'om_question' }]);
    await h.guard.command('off', h.ctx);
    await h.guard.command('', h.ctx); await h.guard.flush();
    expect(h.runs.map((r) => r.message.messageId)).toEqual(['om_live']);
  });

  it('does not persist completed replies or progress messages on later subscription writes', async () => {
    const h = await harness(); await h.enable();
    h.store.complete('oc_group', 'om_question');
    await h.store.progress('om_cot');
    await h.guard.command('off', h.ctx);
    const data = JSON.parse(await readFile(h.statePath, 'utf8'));
    expect(data).toEqual({ subscriptions: [{ chatId: 'oc_group', userId: 'ou_me', enabled: false }] });
    const restarted = await harness(data);
    expect(restarted.store.completed('oc_group', 'om_question')).toBe(false);
    expect(restarted.store.isProgress('om_cot')).toBe(false);
    expect(restarted.store.enabled('oc_group')).toEqual([]);
  });

  it('handles several guarded users and overlapping @bot in one run', async () => {
    const h = await harness(); await h.enable(); await h.enable('ou_other');
    await h.intake({ ...message('om_question', ['ou_me', 'ou_other']), mentionedBot: true });
    await h.guard.flush();
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]?.resolveCompletionMentions?.()).toEqual(['ou_me', 'ou_other', 'ou_sender']);
    expect(h.pending.cancel('oc_group')).toEqual([]);
  });

  it('updates final mentions and reply eligibility when protected users turn guard off', async () => {
    const h = await harness(); await h.enable(); await h.enable('ou_other');
    await h.intake(message('om_question', ['ou_me', 'ou_other'])); await h.guard.flush();
    const request = h.runs[0]!;
    expect(request.shouldSendReply?.({ finalText: 'answer' })).toBe(true);
    expect(request.shouldSendReply?.({ error: 'agent failed' })).toBe(false);

    await h.guard.command('off', h.ctx);
    expect(request.resolveCompletionMentions?.()).toEqual(['ou_other', 'ou_sender']);
    expect(request.shouldSendReply?.({ finalText: 'answer' })).toBe(true);

    await h.guard.command('off', { ...h.ctx, msg: { ...h.ctx.msg, senderId: 'ou_other' } });
    expect(request.shouldSendReply?.({ finalText: 'answer' })).toBe(false);
  });

  it('does not dispatch a slash command addressed only to the guarded human', async () => {
    const h = await harness(); await h.enable();
    await h.intake({ ...message(), content: '/stop' }); await h.guard.flush();
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]?.message.content).toBe('/stop');
  });

  it('handles self-mentions in both live traffic and the initial history scan', async () => {
    const h = await harness(); await h.enable();
    h.raw.set('om_question', item('om_question', 100_000, 'ou_me'));
    await h.intake({ ...message(), senderId: 'ou_me' }); await h.guard.flush();
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]?.resolveCompletionMentions?.()).toEqual(['ou_me']);
    const history = await harness();
    history.setHistory([item('om_self', 100_000, 'ou_me')]);
    await history.guard.command('', history.ctx); await history.guard.flush();
    expect(history.runs).toHaveLength(1);
    expect(history.runs[0]?.resolveCompletionMentions?.()).toEqual(['ou_me']);
  });

  it('retains group access gates and ignores bots, all and unrelated mentions', async () => {
    const h = await harness(); await h.enable();
    expect(h.guard.matches({ ...message(), senderType: 'bot' })).toEqual([]);
    expect(h.guard.matches({ ...message(), mentionAll: true })).toEqual([]);
    expect(h.guard.matches(message('om_question', ['ou_someone']))).toEqual([]);
    h.controls.profileConfig.access.allowedChats = [];
    await h.intake(message()); await h.guard.flush();
    expect(h.runs).toEqual([]); expect(h.addReaction).not.toHaveBeenCalled();
  });

  it('scans at most 100 historical candidates oldest first and skips direct replies by me or bot', async () => {
    const h = await harness();
    const messages = Array.from({ length: 101 }, (_, i) => item(`om_${i}`, 100_000 + i));
    const mine = { ...item('om_mine', 150_000, 'ou_me', []), parent_id: 'om_2' };
    const bot = { ...item('om_bot', 150_001, 'ou_bot', []), parent_id: 'om_3' };
    h.setHistory(messages);
    // Reply evidence comes from the thread, outside the candidate snapshot.
    h.raw.set('om_2', { ...messages[2]!, thread_id: 'omt_2' }); h.threads.set('omt_2', [mine]);
    h.raw.set('om_3', { ...messages[3]!, thread_id: 'omt_3' }); h.threads.set('omt_3', [bot]);
    await h.guard.command('', h.ctx); await h.guard.flush();
    expect(h.runs).toHaveLength(98);
    expect(h.runs[0]?.message.messageId).toBe('om_1');
    expect(h.runs.at(-1)?.message.messageId).toBe('om_100');
    expect(h.runs.some((r) => ['om_0', 'om_2', 'om_3'].includes(r.message.messageId))).toBe(false);
    h.list.mockClear();
    await h.guard.command('off', h.ctx); await h.guard.command('', h.ctx); await h.guard.flush();
    expect(h.list).toHaveBeenCalled();
    expect(h.runs).toHaveLength(98);
  });

  it('does not treat other replies, reactions or COT progress as an answer', async () => {
    const h = await harness(); await h.enable();
    h.raw.set('om_question', { ...item('om_question'), thread_id: 'omt_1' });
    await h.store.progress('om_cot');
    h.threads.set('omt_1', [
      { ...item('om_other', 110_000, 'ou_someone', []), parent_id: 'om_question' },
      { ...item('om_cot', 110_001, 'ou_bot', []), parent_id: 'om_question' },
    ]);
    h.guard.accept(message()); await h.guard.flush();
    expect(h.runs).toHaveLength(1); expect(h.runs[0]?.scopeId).toBe('oc_group:omt_1');
  });

  it('rechecks replies and off while queued and cleans up delayed reactions', async () => {
    const h = await harness(); await h.enable();
    const blocked = deferred(); const reaction = deferred();
    h.addReaction.mockImplementation(async () => { await reaction.promise; return 'delayed'; });
    h.runAgent.mockImplementationOnce(async (request) => {
      await blocked.promise;
      if (!await request.beforeRun!()) return { scopeId: request.scopeId };
      h.runs.push(request); return { scopeId: request.scopeId, replyMessageId: 'answer' };
    });
    h.guard.accept(message());
    await vi.waitFor(() => expect(h.runAgent).toHaveBeenCalled());
    h.guard.observe({ ...message('om_reply', []), senderId: 'ou_me', replyToMessageId: 'om_question' });
    blocked.resolve(); await h.guard.flush(); reaction.resolve();
    await vi.waitFor(() => expect(h.removeReaction).toHaveBeenCalledWith('om_question', 'delayed'));
    expect(h.runs).toEqual([]);
    h.raw.set('om_next', item('om_next'));
    h.guard.accept(message('om_next'));
    await h.guard.command('off', h.ctx); await h.guard.flush();
    expect(h.store.enabled('oc_group')).toEqual([]);
  });

  it('skips deleted messages and does not mark failed sends complete', async () => {
    const h = await harness(); await h.enable();
    h.runAgent.mockResolvedValueOnce({ scopeId: 'scope', error: 'send failed' });
    h.guard.accept(message()); await h.guard.flush();
    expect(h.store.completed('oc_group', 'om_question')).toBe(false);
    expect(h.removeReaction).toHaveBeenCalled();
    h.raw.set('om_question', { ...item('om_question'), deleted: true });
    h.guard.accept(message()); await h.guard.flush();
    expect(h.runAgent).toHaveBeenCalledTimes(1);
  });

  it('reports missing permission and requires off/on to retry a failed scan', async () => {
    const h = await harness(); h.grant.mockResolvedValueOnce({ data: { app: { scopes: [] } } });
    await h.guard.command('', h.ctx);
    expect(h.store.enabled('oc_group')).toEqual([]);
    expect(h.addReaction).not.toHaveBeenCalledWith('om_guard', 'DONE');
    expect(h.send.mock.calls.at(-1)?.[1]).toMatchObject({ text: expect.stringContaining('im:message.group_msg') });
    h.list.mockRejectedValueOnce(new Error('history unavailable'));
    await h.guard.command('', h.ctx); await h.guard.flush();
    expect(h.store.get('oc_group', 'ou_me')).toMatchObject({ enabled: true });
    expect(h.addReaction).not.toHaveBeenCalledWith('om_guard', 'DONE');
    h.list.mockClear();
    await h.guard.command('', h.ctx); await h.guard.flush();
    expect(h.list).not.toHaveBeenCalled();
    await h.guard.command('off', h.ctx);
    await h.guard.command('', h.ctx); await h.guard.flush();
    expect(h.list).toHaveBeenCalled();
    await h.guard.command('status', h.ctx);
    expect(h.send.mock.calls.at(-1)?.[1]).toMatchObject({ text: expect.stringContaining('已开启') });
  });

  it('holds live traffic until the history snapshot has been answered', async () => {
    const h = await harness(); h.setHistory([item('om_old')]);
    h.raw.set('om_live', item('om_live', 210_000));
    const historyGate = deferred(); const original = h.list.getMockImplementation()!;
    h.list.mockImplementationOnce(async (args) => { await historyGate.promise; return original(args); });
    await h.guard.command('', h.ctx);
    h.guard.accept(message('om_live')); historyGate.resolve();
    await h.guard.flush();
    expect(h.runs.map((r) => r.message.messageId)).toEqual(['om_old', 'om_live']);
  });

  it('keeps failed reply-evidence reads retryable and never infers an unanswered message', async () => {
    const h = await harness();
    h.setHistory([{ ...item('om_old'), thread_id: 'omt_old' }]);
    const original = h.list.getMockImplementation()!;
    h.list.mockImplementation(async (args) => {
      if (args.params.container_id_type === 'thread') throw new Error('thread unavailable');
      return original(args);
    });
    await h.guard.command('', h.ctx); await h.guard.flush();
    expect(h.runs).toEqual([]);
    expect(h.send.mock.calls.at(-1)?.[1]).toMatchObject({ text: expect.stringContaining('历史扫描未完成') });
    h.list.mockImplementation(original);
    await h.guard.command('off', h.ctx);
    await h.guard.command('', h.ctx); await h.guard.flush();
    expect(h.runs).toHaveLength(1);
    expect(h.store.get('oc_group', 'ou_me')?.enabled).toBe(true);
  });

  it('preserves resources and quotes when normalizing historical mentions', async () => {
    const h = await harness();
    const image = { ...item('om_image'), msg_type: 'image', parent_id: 'om_original',
      body: { content: JSON.stringify({ image_key: 'img_guard' }) } };
    h.setHistory([image]);
    await h.guard.command('', h.ctx); await h.guard.flush();
    expect(h.runs[0]?.message).toMatchObject({ replyToMessageId: 'om_original',
      resources: [{ type: 'image', fileKey: 'img_guard' }] });
  });

  it('cleans reactions on disconnect and tolerates reaction creation failure', async () => {
    const h = await harness(); await h.enable();
    const gate = deferred();
    h.runAgent.mockImplementationOnce(async (request) => {
      await gate.promise;
      if (!await request.beforeRun!()) return { scopeId: request.scopeId };
      throw new Error('should not run after stop');
    });
    h.guard.accept(message());
    await vi.waitFor(() => expect(h.runAgent).toHaveBeenCalled());
    h.guard.stop();
    await vi.waitFor(() => expect(h.removeReaction).toHaveBeenCalled());
    gate.resolve(); await h.guard.flush(); expect(h.runs).toEqual([]);
    const other = await harness(); await other.enable();
    other.addReaction.mockRejectedValueOnce(new Error('reaction permission denied'));
    other.guard.accept(message()); await other.guard.flush();
    expect(other.runs).toHaveLength(1);
  });
});
