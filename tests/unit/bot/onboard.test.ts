import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import type { AgentRunRequest, CommandContext } from '../../../src/commands';
import { fetchOnboardSnapshot, handleOnboard } from '../../../src/bot/onboard';
import { rootTopicScope } from '../../../src/bot/topic-scope';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { startRunFlow } from '../../../src/bot/run-flow';
import { ProcessPool } from '../../../src/bot/process-pool';
import { codexCapability } from '../../../src/agent/capability';
import { canUseGroup } from '../../../src/policy/access';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { SessionStore } from '../../../src/session/store';
import { SessionCatalog } from '../../../src/session/catalog';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const temps: TmpProfile[] = [];
const stores: Array<{ sessions: SessionStore; workspaces: WorkspaceStore }> = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).flatMap(({ sessions, workspaces }) => [sessions.flush(), workspaces.flush()]));
  await Promise.all(temps.splice(0).map((tmp) => tmp.cleanup()));
});

describe('/onboard', () => {
  it('sends the analysis summary without COT when globally off and no task is found', async () => {
    const setup = await makeContext('off', JSON.stringify({ summary: '无待办', title: '', tasks: [] }), 'conversation');
    await handleOnboard('', setup.ctx);
    expect(setup.sent).toMatchObject([{ input: { markdown: '无待办' }, opts: { replyInThread: false } }]);
    expect(setup.agentRuns).toHaveLength(1);
    expect(setup.agentRuns[0]).toMatchObject({
      stage: 'onboard-analysis', access: 'read-only', reply: 'silent', persistSession: false,
      scopeId: 'oc_group',
      cot: { stepName: 'onboarding' },
    });
  });

  it('sends the analysis summary after the onboarding COT run when globally enabled', async () => {
    const setup = await makeContext('brief', JSON.stringify({ summary: '无待办', title: '', tasks: [] }));
    await handleOnboard('', setup.ctx);
    expect(setup.sent).toMatchObject([{ input: { markdown: '无待办' }, opts: { replyInThread: true } }]);
    expect(setup.agentRuns[0]?.scopeId).toBe(rootTopicScope('oc_group', 'om_command'));
    expect(setup.ctx.sessions.getRaw(rootTopicScope('oc_group', 'om_command'))?.topicRoot).toBe(true);
    expect(setup.agentRuns[0]?.cot?.stepName).toBe('onboarding');
  });

  it.each([
    { label: 'main chat with topic replies', placement: 'thread', topic: false,
      analysisScope: rootTopicScope('oc_group', 'om_command'), analysisInThread: true,
      taskPlacement: 'new-topic' },
    { label: 'existing topic with topic replies', placement: 'thread', topic: true,
      analysisScope: 'oc_group:omt_topic', analysisInThread: true,
      taskPlacement: 'current' },
    { label: 'main chat with conversation replies', placement: 'conversation', topic: false,
      analysisScope: 'oc_group', analysisInThread: false,
      taskPlacement: 'current' },
    { label: 'existing topic with conversation replies', placement: 'conversation', topic: true,
      analysisScope: 'oc_group:omt_topic', analysisInThread: true,
      taskPlacement: 'current' },
  ] as const)('routes $label through the expected sessions', async (scenario) => {
    const setup = await makeContext('brief', taskAnalysis(), scenario.placement);
    if (scenario.topic) {
      setup.ctx.chatMode = 'topic';
      setup.ctx.scope = 'oc_group:omt_topic';
      setup.ctx.msg.threadId = 'omt_topic';
    }
    setup.ctx.sessions.set(scenario.analysisScope, 'old-session', setup.workspace);
    await handleOnboard('', setup.ctx);

    expect(setup.sent).toMatchObject([{
      input: { markdown: '需要完成评审' },
      opts: { replyTo: 'om_command', replyInThread: scenario.analysisInThread },
    }]);
    expect(setup.ctx.sessions.getRaw(scenario.analysisScope)?.sessionId).toBe('analysis-session');
    expect(setup.agentRuns).toHaveLength(2);
    expect(setup.agentRuns[0]).toMatchObject({
      stage: 'onboard-analysis', scopeId: scenario.analysisScope,
      sendOpts: { replyInThread: scenario.analysisInThread },
      cot: { stepName: 'onboarding' },
    });
    expect(setup.agentRuns[1]).toMatchObject({
      stage: 'onboard-task', scopeId: scenario.analysisScope,
      sessionAnchor: {
        title: '完成设计评审',
        fallbackMessage: expect.stringContaining('完成设计评审'),
        placement: scenario.taskPlacement,
      },
    });
    expect(setup.agentRuns[1]?.prompt).toContain('周五前给出意见');
  });

  it('archives previous sessions for the scope before analysis', async () => {
    const setup = await makeContext('off', taskAnalysis(), 'conversation');
    const catalog = new SessionCatalog(join(setup.tmp.profile, 'catalog.json'));
    setup.ctx.sessionCatalog = catalog;
    catalog.upsertActive({ scopeId: 'oc_group', agentId: 'claude', cwdRealpath: setup.workspace,
      policyFingerprint: 'old-policy', sessionId: 'old-session' });
    setup.ctx.sessions.set('oc_group', 'old-session', setup.workspace);
    await handleOnboard('', setup.ctx);
    expect(catalog.entries().find((entry) => entry.policyFingerprint === 'old-policy')?.status).toBe('archived');
    expect(catalog.entries().some((entry) => entry.scopeId === 'oc_group'
      && entry.status === 'active' && entry.sessionId === 'analysis-session')).toBe(true);
    expect(setup.ctx.sessions.getRaw('oc_group')?.sessionId).toBe('analysis-session');
    await catalog.flush();
  });

  it.each(['conversation', 'thread'] as const)(
    'resumes the analysis thread for the next Codex run with %s replies', async (placement) => {
      const setup = await makeContext('off', JSON.stringify({ summary: '无待办', title: '', tasks: [] }),
        placement, 'codex');
      const catalog = new SessionCatalog(join(setup.tmp.profile, 'catalog.json'));
      setup.ctx.sessionCatalog = catalog;
      await handleOnboard('', setup.ctx);

      const scopeId = placement === 'thread' ? rootTopicScope('oc_group', 'om_command') : 'oc_group';
      const profileConfig = setup.ctx.controls.profileConfig;
      const run = await startRunFlow({
        scopeId,
        scope: { source: 'im', chatId: 'oc_group', actorId: 'ou_user',
          ...(placement === 'thread' ? { threadId: 'root:om_command' } : {}) },
        prompt: '继续讨论',
        attachments: [],
        access: canUseGroup(profileConfig, setup.ctx.controls, 'oc_group', 'ou_user'),
        capability: codexCapability(profileConfig),
        profileConfig,
        sessions: setup.ctx.sessions,
        sessionCatalog: catalog,
        workspaces: setup.ctx.workspaces,
        executor: setup.ctx.runExecutor!,
        now: Date.now(),
      });
      expect(run.ok).toBe(true);
      if (!run.ok) throw new Error('expected resumable Codex run');
      expect(run.resumeFrom).toBe('analysis-thread');
      for await (const _ of run.execution.subscribe()) { /* drain */ }
      await catalog.flush();
    },
  );

  it('keeps a task topic after restart and /new', async () => {
    const tmp = await createTmpProfile('onboard-anchor-');
    temps.push(tmp);
    const file = join(tmp.profile, 'sessions.json');
    const scope = rootTopicScope('oc_group', 'om_task');
    const sessions = new SessionStore(file);
    sessions.markTopicRoot(scope);
    sessions.set(scope, 'session-1', tmp.workspace);
    await sessions.flush();
    const loaded = new SessionStore(file);
    await loaded.load();
    expect(loaded.getRaw(scope)?.topicRoot).toBe(true);
    loaded.clear(scope);
    await loaded.flush();
    const reset = new SessionStore(file);
    await reset.load();
    expect(reset.getRaw(scope)?.topicRoot).toBe(true);
  });

  it('reads replies in the current topic and keeps an older pinned message', async () => {
    const setup = await makeContext('off', JSON.stringify({ summary: '', title: '', tasks: [] }));
    setup.ctx.chatMode = 'topic';
    setup.ctx.msg.threadId = 'omt_topic';
    const root = { message_id: 'om_root', thread_id: 'omt_topic', msg_type: 'text',
      body: { content: '{"text":"设计讨论"}' }, sender: { id: 'ou_peer', sender_type: 'user' }, create_time: '1000' };
    const reply = { message_id: 'om_reply', thread_id: 'omt_topic', root_id: 'om_root', msg_type: 'text',
      body: { content: '{"text":"请你完成评审"}' }, sender: { id: 'ou_peer', sender_type: 'user' },
      create_time: '3000', mentions: [{ key: '@_user_1', id: 'ou_user', name: '用户' }] };
    const pin = { message_id: 'om_pin', msg_type: 'text', body: { content: '{"text":"项目目标"}' },
      sender: { id: 'ou_peer', sender_type: 'user' }, create_time: '500' };
    setup.ctx.channel = {
      botIdentity: { openId: 'ou_bot' },
      async getChatInfo() { return { name: '设计群', description: '项目讨论' }; },
      async fetchRawMessage(id: string) { return id === 'om_pin' ? [pin] : [root]; },
      rawClient: { im: { v1: {
        pin: { async list() { return { data: { items: [{ message_id: 'om_pin' }] } }; } },
        message: { async list(input: { params: { container_id_type: string } }) {
          return { data: { items: input.params.container_id_type === 'thread' ? [reply] : [root] } };
        } },
      } } },
    } as unknown as LarkChannel;
    const snapshot = await fetchOnboardSnapshot(setup.ctx);
    expect(snapshot.messages.map((message) => message.messageId)).toEqual(['om_root', 'om_reply']);
    expect(snapshot.messages.find((message) => message.messageId === 'om_reply')?.mentionsRequester).toBe(true);
    expect(snapshot.pins.map((message) => message.messageId)).toEqual(['om_pin']);
  });
});

function taskAnalysis(): string {
  return JSON.stringify({
    summary: '需要完成评审', title: '完成设计评审',
    tasks: [{ action: '完成设计评审', background: '周五前给出意见', evidenceMessageIds: ['om_context'] }],
  });
}

async function makeContext(
  cotMessages: 'off' | 'brief',
  analysis: string,
  groupReplyPlacement: 'thread' | 'conversation' = 'thread',
  agentKind: 'claude' | 'codex' = 'claude',
) {
  const tmp = await createTmpProfile('onboard-test-');
  temps.push(tmp);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  stores.push({ sessions, workspaces });
  const agent = new FakeAgentAdapter({ id: agentKind, events: [
    [{ type: 'final_text', content: analysis }, { type: 'done', terminationReason: 'normal' }],
  ] });
  const activeRuns = new ActiveRuns();
  const executor = new RunExecutor({ agent, pool: new ProcessPool(() => 2), activeRuns });
  const sent: Array<{ input: unknown; opts: unknown }> = [];
  let nextMessage = 0;
  const channel = {
    botIdentity: { openId: 'ou_bot' },
    async getChatInfo() { return { chatId: 'oc_group', name: '设计群', description: '项目讨论', chatType: 'group' }; },
    async fetchRawMessage(id: string) {
      return [{ message_id: id, thread_id: 'omt_topic', msg_type: 'text',
        body: { content: '{"text":"周五前完成设计评审"}' },
        sender: { id: 'ou_peer', sender_type: 'user' }, create_time: '1000' }];
    },
    rawClient: { im: { v1: {
      pin: { async list() { return { data: { items: [], has_more: false } }; } },
      message: { async list() { return { data: { items: [{
        message_id: 'om_context', msg_type: 'text', body: { content: '{"text":"周五前完成设计评审"}' },
        sender: { id: 'ou_peer', sender_type: 'user' }, create_time: '1000',
        mentions: [{ key: '@_user_1', id: 'ou_user', name: '用户' }],
      }], has_more: false } }; } },
    } } },
    async send(_chatId: string, input: unknown, opts: unknown) {
      sent.push({ input, opts });
      return { messageId: nextMessage++ === 0 ? 'om_task' : 'om_answer' };
    },
  } as unknown as LarkChannel;
  const profileConfig = {
    agentKind, mode: 'team',
    preferences: {},
    access: { allowedUsers: [], allowedChats: [], admins: [], requireMentionInGroup: true },
    permissions: { defaultAccess: 'full', maxAccess: 'full' },
    workspaces: { default: tmp.workspace },
    attachments: { maxCount: 5, maxBytes: 100000, maxFileBytes: 100000, imageMaxBytes: 100000 },
  };
  const ctx = {
    channel, sessions, workspaces, agent, activeRuns, runExecutor: executor,
    scope: 'oc_group', chatMode: 'group',
    msg: { chatId: 'oc_group', chatType: 'group', messageId: 'om_command', senderId: 'ou_user',
      mentionedBot: true, content: '/onboard' },
    controls: { profile: 'test', profileConfig, ownerRefreshState: 'unknown',
      cfg: { accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
        preferences: { cotMessages, groupReplyPlacement } } },
  } as unknown as CommandContext;
  const agentRuns: AgentRunRequest[] = [];
  ctx.runAgent = async (request) => {
    agentRuns.push(request);
    if (request.stage === 'onboard-analysis') {
      return { scopeId: request.scopeId, finalText: analysis,
        ...(agentKind === 'claude' ? { sessionId: 'analysis-session' } : { threadId: 'analysis-thread' }),
        cwdRealpath: tmp.workspace };
    }
    const anchorMessageId = cotMessages === 'off' ? 'om_task' : 'om_cot_2';
    return {
      scopeId: request.sessionAnchor?.placement === 'new-topic'
        ? rootTopicScope('oc_group', anchorMessageId) : request.scopeId,
      anchorMessageId,
    };
  };
  return { ctx, sent, agent, agentRuns, workspace: tmp.workspace, tmp };
}
