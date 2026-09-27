import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';

import type { AgentRunRequest, AgentRunResult, CommandContext, Controls } from '@/commands';
import { log } from '@/core/logger';
import { canUseGroup } from '@/policy/access';
import type { SessionStore } from '@/session/store';
import type { WorkspaceStore } from '@/workspace/store';

import { hasGroupMsgScope } from './app-scope';
import { GuardStore } from './guard-store';
import { type FeishuMessageItem, fetchFeishuMessageItems, normalizeHistoryMessage } from './quote';
import { addWorkingReaction, startPendingReaction } from './reaction';
import { replyOptions } from './reply-placement';
import { existingRootTopicScope, rootTopicScope } from './topic-scope';

interface GuardDeps {
  channel: LarkChannel;
  controls: Controls;
  store: GuardStore;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  runAgent: (request: AgentRunRequest) => Promise<AgentRunResult>;
}

interface GuardTask {
  message: NormalizedMessage;
  recipients: string[];
  cleanup: () => void;
  isActive?: () => boolean;
}

export class GuardManager {
  private stopped = false;
  private readonly tasks = new Map<string, GuardTask>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly scans = new Map<string, Promise<boolean>>();
  private readonly activations = new Map<string, object>();
  private readonly observedReplies = new Map<string, Set<string>>();

  constructor(private readonly deps: GuardDeps) {}

  matches(msg: NormalizedMessage): string[] {
    if (msg.chatType === 'p2p' || msg.mentionAll || msg.senderId === this.deps.channel.botIdentity?.openId) return [];

    const raw = msg.raw as { sender?: { sender_type?: string } } | undefined;
    if (msg.senderType === 'bot' || raw?.sender?.sender_type === 'app' || raw?.sender?.sender_type === 'bot') return [];

    const enabled = this.deps.store.enabled(msg.chatId);
    return enabled.filter((id) => msg.mentions.some((m) => m.openId === id));
  }

  observe(msg: NormalizedMessage): void {
    if (!msg.replyToMessageId) return;

    const key = this.key(msg.chatId, msg.replyToMessageId);
    const senders = this.observedReplies.get(key) ?? new Set<string>();
    senders.add(msg.senderId);
    this.observedReplies.set(key, senders);

    if (this.observedReplies.size > 1000) this.observedReplies.delete(this.observedReplies.keys().next().value!);
  }

  async command(args: string, ctx: CommandContext): Promise<void> {
    const { channel, controls, store } = this.deps;
    const send = (text: string) => channel.send(ctx.msg.chatId, { text },
      replyOptions(controls.cfg, ctx.msg, ctx.chatMode === 'topic'));

    if (ctx.msg.chatType === 'p2p') {
      await send('请在群聊中 @bot 使用 /guard。');
      return;
    }

    if (!ctx.msg.mentionedBot || this.stopped) return;

    const chatId = ctx.msg.chatId;
    const userId = ctx.msg.senderId;
    const action = args.trim().toLowerCase();

    if (action === 'status') {
      const entry = store.get(chatId, userId);
      const scanStatus = entry?.enabled && this.scans.has(this.key(chatId, userId))
        ? '历史扫描进行中。' : '';
      await send(`你的守护模式：${entry?.enabled ? '已开启' : '已关闭'}。${scanStatus}`);
      return;
    }

    if (action === 'off') {
      this.activations.delete(this.key(chatId, userId));
      await store.disable(chatId, userId);

      for (const task of this.tasks.values()) {
        if (task.message.chatId !== chatId) continue;

        task.recipients = task.recipients.filter((id) => id !== userId);
        if (this.activeRecipients(task).length === 0) task.cleanup();
      }

      await addWorkingReaction(channel, ctx.msg.messageId, 'DONE');
      return;
    }

    if (action && action !== 'on') {
      await send('用法：/guard [on|off|status]');
      return;
    }

    const key = this.key(chatId, userId);
    const finish = async () => {
      const entry = store.get(chatId, userId);
      if (!this.stopped && entry?.enabled) {
        await addWorkingReaction(channel, ctx.msg.messageId, 'DONE');
      }
    };

    const granted = await hasGroupMsgScope(channel, controls.cfg.accounts.app.id);
    if (this.stopped) return;

    if (granted === false) {
      await send('无法开启守护：应用缺少 im:message.group_msg 权限。请在飞书开放平台开启「获取群组中所有消息」，发布新版本并等待审批生效后重试 /guard。');
      return;
    }

    const changed = await store.enable(chatId, userId);
    if (this.stopped) return;

    const existing = this.scans.get(key);
    if (!changed) {
      if (existing) {
        void existing.then(async (ok) => { if (ok) await finish(); })
          .catch((err) => log.fail('guard', err, { stage: 'scan-notice' }));
      } else await finish();
      return;
    }

    const activation = {};
    const before = ctx.msg.createTime || Date.now();
    this.activations.set(key, activation);
    const isActive = () => !this.stopped && store.get(chatId, userId)?.enabled === true
      && this.activations.get(key) === activation;

    // A new activation waits for a cancelled scan to release any running task.
    const scan = (existing ?? Promise.resolve()).then(async () => {
      if (!isActive()) return false;

      await this.scan(chatId, userId, before, isActive);
      if (!isActive()) return false;

      await finish();
      return true;
    }).catch(async (err) => {
      log.fail('guard', err, { chatId, stage: 'history' });
      if (isActive()) await send(`守护已开启，但历史扫描未完成：${errorText(err)}。请 /guard off 后再次 /guard 重试。`);
      return false;
    }).finally(() => {
      if (this.scans.get(key) === scan) this.scans.delete(key);
    });

    this.scans.set(key, scan);

    // Commands remain responsive while the scan and subsequent runs complete.
    void scan.catch((err) => log.fail('guard', err, { stage: 'scan-notice' }));
  }

  accept(msg: NormalizedMessage): boolean {
    const recipients = this.matches(msg);
    if (!recipients.length || this.stopped) return false;

    this.enqueue(msg, recipients);
    return true;
  }

  private enqueue(message: NormalizedMessage, recipients: string[]): void {
    const key = this.key(message.chatId, message.messageId);
    if (this.deps.store.completed(message.chatId, message.messageId)) return;

    const existing = this.tasks.get(key);
    if (existing) {
      existing.recipients = [...new Set([...existing.recipients, ...recipients])];
      return;
    }

    const task = { message, recipients, cleanup: startPendingReaction(this.deps.channel, message.messageId, 'OnIt') };
    this.tasks.set(key, task);

    const previous = this.queues.get(message.chatId) ?? Promise.resolve();
    const queued = previous.then(async () => {
      // History tasks are added before this gate releases live traffic.
      await Promise.all([...this.scans.entries()].filter(([id]) => JSON.parse(id)[0] === message.chatId).map(([, scan]) => scan));
      await this.execute(task);
    }).catch((err) => log.fail('guard', err, { messageId: message.messageId })).finally(() => {
      task.cleanup();
      this.tasks.delete(key);
      if (this.queues.get(message.chatId) === queued) this.queues.delete(message.chatId);
    });

    this.queues.set(message.chatId, queued);
  }

  private activeRecipients(task: GuardTask): string[] {
    return this.stopped || task.isActive?.() === false ? [] : task.recipients.filter((id) => this.deps.store.get(task.message.chatId, id)?.enabled);
  }

  private async execute(task: GuardTask): Promise<void> {
    const { channel, controls, store, sessions, workspaces, runAgent } = this.deps;
    const msg = task.message;
    if (!this.activeRecipients(task).length || store.completed(msg.chatId, msg.messageId)) return;
    if (!canUseGroup(controls.profileConfig, controls, msg.chatId, msg.senderId).ok) return;

    const [item] = await fetchFeishuMessageItems(channel, msg.messageId);
    if (!item?.message_id) throw new Error('无法确认原消息状态');
    if (item.deleted) return;

    const message = { ...msg, threadId: item.thread_id ?? msg.threadId, rootId: item.root_id ?? msg.rootId };
    const knownScope = existingRootTopicScope({ chatId: msg.chatId, rootId: message.rootId, sessions });
    const scope = knownScope ?? (message.threadId ? `${message.chatId}:${message.threadId}` : rootTopicScope(message.chatId, message.messageId));
    if (!message.threadId) sessions.markTopicRoot(scope);

    if (!workspaces.cwdFor(scope)) {
      const cwd = workspaces.cwdFor(msg.threadId ? `${msg.chatId}:${msg.threadId}` : msg.chatId) ?? workspaces.cwdFor(msg.chatId);
      if (cwd) workspaces.setCwd(scope, cwd);
    }

    const instructions: string[] = [];
    let started = false;
    const result = await runAgent({
      message, scopeId: scope, mode: 'topic', stage: 'guard',
      sendOpts: { replyTo: msg.messageId, replyInThread: true },
      instructions,
      pendingReaction: false,
      beforeRun: async () => {
        const recipients = this.activeRecipients(task);
        if (!recipients.length || store.completed(msg.chatId, msg.messageId)) return false;

        started = !await this.answered(message, recipients);
        const active = this.activeRecipients(task);
        if (!started || !active.length) return false;

        instructions.push(`守护模式：你正在协助群成员 ${active.join('、')} 回应原消息发送者。请结合消息、引用和附件给出实质性答复；以 Bot 身份发言，不假称本人。最终答复由 bridge 发送并添加 @，无需另行发送聊天消息。`);
        instructions.push(`上下文信息不足时，先结合现有资料和可用工具查找信息，完成信息足够、可以独立执行的部分；不要猜测关键事实。本轮执行结束时，在最终回复中汇报已完成内容，将受阻部分标为“待补充信息”，列出具体缺少的信息及其影响，并明确请原消息发送者 ${msg.senderId} 补充；无法确定派发者时，直接请该任务对应的被守护成员（${active.join('、')}）补充。不得将受阻任务描述为已完成。`);
        instructions.push(`将所有信息补充请求集中在一个段落，标题独占一行，固定为“**待补充信息：**”，使用 Markdown 加粗。标题下每个待补充信息项独占一行，格式为“- [[at:OPEN_ID]]：需要补充的内容”。例如：\n**待补充信息：**\n- [[at:${msg.senderId}]]：请补充相识日期和城市。\n无法确定派发者时，用该任务对应被守护成员的标记（${active.map((id) => `[[at:${id}]]`).join(' ')}）。同一个人对应多项问题时，每项前都要写标记；不要在每项重复标题，不要仅写姓名或“原消息发送者”。bridge 会将标记转换为真实 @。`);
        return true;
      },
      shouldSendReply: (outcome) => !outcome.error && this.activeRecipients(task).length > 0,
      resolveCompletionMentions: () => [...new Set([...this.activeRecipients(task), msg.senderId])],
      onProgress: (id) => store.progress(id),
    });

    if (result.replyMessageId && !result.error) store.complete(msg.chatId, msg.messageId);
    if (this.activeRecipients(task).length && (result.error || (started && !result.replyMessageId))) {
      throw new Error(result.error ?? 'Agent 未发送正式答复');
    }
  }

  private async answered(msg: NormalizedMessage, recipients: string[]): Promise<boolean> {
    const observed = this.observedReplies.get(this.key(msg.chatId, msg.messageId));
    if (recipients.some((id) => observed?.has(id))) return true;

    const [item] = await fetchFeishuMessageItems(this.deps.channel, msg.messageId);
    if (!item?.message_id) throw new Error('无法确认原消息状态');
    if (item.deleted) return true;

    const threadId = item.thread_id ?? msg.threadId;
    const replies = threadId
      ? await this.list('thread', threadId, undefined, Number(item.create_time))
      : await this.list('chat', msg.chatId, undefined, Number(item.create_time));

    const botIds = [this.deps.channel.botIdentity?.openId, this.deps.channel.botIdentity?.userId,
      this.deps.controls.cfg.accounts.app.id].filter(Boolean);
    return replies.some((reply) => {
      if (reply.deleted || reply.message_id === msg.messageId || !reply.message_id) return false;
      if (reply.parent_id !== msg.messageId && !(reply.root_id === msg.messageId && !reply.parent_id)) return false;
      if (recipients.includes(reply.sender?.id ?? '')) return true;

      // COT has its own message type; also remember progress IDs issued by this bridge.
      return botIds.includes(reply.sender?.id) && !this.deps.store.isProgress(reply.message_id)
        && ['text', 'post', 'interactive'].includes(reply.msg_type ?? '')
        && !/"(?:streaming_mode|cot_id)"\s*:\s*(?:true|")/.test(reply.body?.content ?? '');
    });
  }

  private async scan(chatId: string, userId: string, before: number, isActive: () => boolean): Promise<void> {
    const items = await this.list('chat', chatId, 100, undefined, before);
    const candidates: NormalizedMessage[] = [];
    let incomplete = false;

    for (const item of items.reverse()) {
      if (!isActive()) return;
      if (item.deleted || !item.message_id) continue;

      try {
        const msg = await normalizeHistoryMessage(this.deps.channel, item, chatId);
        if (msg.mentionedBot && msg.content.trim().startsWith('/')) continue;
        if (!this.matches(msg).includes(userId) || this.deps.store.completed(chatId, msg.messageId)) continue;

        candidates.push(msg);
      } catch (err) {
        incomplete = true;
        log.fail('guard', err, { messageId: item.message_id, stage: 'history-candidate' });
      }
    }

    // Execute the historical snapshot before releasing live messages waiting on this scan.
    for (const msg of candidates) {
      if (!isActive()) return;

      const key = this.key(chatId, msg.messageId);
      if (this.tasks.has(key)) continue;

      const task = { message: msg, recipients: this.matches(msg), isActive, cleanup: startPendingReaction(this.deps.channel, msg.messageId, 'OnIt') };
      this.tasks.set(key, task);

      try { await this.execute(task); }
      catch (err) { incomplete = true; log.fail('guard', err, { messageId: msg.messageId }); }
      finally { task.cleanup(); this.tasks.delete(key); }
    }

    if (incomplete) throw new Error('部分消息或回复证据读取失败');
  }

  private async list(type: 'chat' | 'thread', id: string, limit = Infinity, after?: number, before?: number): Promise<FeishuMessageItem[]> {
    const items: FeishuMessageItem[] = [];
    const tokens = new Set<string>();
    let token: string | undefined;

    do {
      const res = await this.deps.channel.rawClient.im.v1.message.list({ params: {
        container_id_type: type, container_id: id, sort_type: 'ByCreateTimeDesc', page_size: 50,
        ...(token ? { page_token: token } : {}),
        ...(after ? { start_time: String(Math.floor(after / 1000)) } : {}),
        ...(before ? { end_time: String(Math.ceil(before / 1000)) } : {}),
      } });

      if (res.code !== undefined && res.code !== 0) throw new Error(res.msg ?? `飞书错误 ${res.code}`);
      if (!res.data || (!Array.isArray(res.data.items) && res.data.has_more !== false)) {
        throw new Error('历史消息接口未返回有效数据');
      }

      items.push(...(res.data.items ?? []).filter((item) => !before || Number(item.create_time) < before));
      token = res.data.has_more ? res.data.page_token : undefined;
      if (res.data.has_more && !token) throw new Error('历史消息缺少分页标记');
      if (token && tokens.has(token)) throw new Error('历史消息分页标记重复');
      if (token) tokens.add(token);
    } while (token && items.length < limit && !this.stopped);

    return items.slice(0, limit);
  }

  stop(): void {
    this.stopped = true;

    for (const task of this.tasks.values()) task.cleanup();
  }

  async flush(): Promise<void> {
    await Promise.all([...this.scans.values(), ...this.queues.values()]);
    await this.deps.store.flush();
  }

  private key(chatId: string, id: string): string { return JSON.stringify([chatId, id]); }
}

export async function handleGuard(args: string, ctx: CommandContext): Promise<void> {
  if (!ctx.guard) throw new Error('guard manager is unavailable');
  await ctx.guard.command(args, ctx);
}

function errorText(err: unknown): string { return err instanceof Error ? err.message : String(err); }
