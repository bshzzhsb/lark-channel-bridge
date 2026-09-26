import type { LarkChannel } from '@larksuite/channel';

import type { ActiveRuns } from '@/bot/active-runs';
import { startKeepalive } from '@/bot/keepalive';
import { fetchKnownChats } from '@/bot/lark-info';
import type { Controls } from '@/commands';
import type { AppConfig } from '@/config/schema';
import { log } from '@/core/logger';
import type { VcRequestClient } from '@/meeting/api';
import { MeetingManager } from '@/meeting/manager';
import { attachMeetingAgent, summarizeEndedMeeting } from '@/meeting/orchestrator';
import { createOwnerRefreshController } from '@/policy/owner';
import type { RunExecutor } from '@/runtime/run-executor';
import type { SessionCatalog } from '@/session/catalog';
import type { SessionStore } from '@/session/store';
import type { WorkspaceStore } from '@/workspace/store';

interface ChannelServicesDeps {
  channel: LarkChannel;
  cfg: AppConfig;
  controls: Controls;
  executor: RunExecutor;
  activeRuns: ActiveRuns;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
}

export function createChannelServices(deps: ChannelServicesDeps) {
  const { channel, cfg, controls } = deps;

  const meetingManager = attachMeetings(deps);

  const ownerRefresh = createOwnerRefreshController({ controls, source: channel, appId: cfg.accounts.app.id });
  let knownChatsRefresh: { stop(): void; } | undefined;
  let keepalive: { stop(): void; } | undefined;

  return {
    async start() {
      await ownerRefresh.start();
      knownChatsRefresh = startKnownChatsRefreshTimer(channel, controls);
    },

    startKeepalive() {
      const domain = cfg.accounts.app.tenant === 'lark'
        ? 'https://open.larksuite.com' : 'https://open.feishu.cn';

      keepalive = startKeepalive({ channel, domain, forceReconnect: () => controls.restart() });
    },

    stop() {
      ownerRefresh.stop();
      knownChatsRefresh?.stop();
      keepalive?.stop();
      // /reconnect stops timers, but does not leave ongoing meetings.
      meetingManager?.dispose();
      controls.meeting = undefined;
    },
  };
}

function attachMeetings(deps: ChannelServicesDeps) {
  const { channel, controls, executor, activeRuns, sessions, sessionCatalog, workspaces } = deps;
  const agentDeps = { channel, controls, executor, activeRuns, sessions, sessionCatalog, workspaces };
  const config = () => controls.profileConfig.meeting;

  if (!config().enabled) return;

  const manager = new MeetingManager({
    client: channel.rawClient as unknown as VcRequestClient,
    config, botOpenId: () => channel.botIdentity?.openId, channel,
    onEnded: (session) => void summarizeEndedMeeting({ ...agentDeps, session }).catch((err) =>
      log.warn('meeting', 'summary-failed', { err: String(err) })),
    onSession: (session) => attachMeetingAgent({ ...agentDeps, session }),
  });

  manager.attachPush();
  controls.meeting = manager;

  return manager;
}

function startKnownChatsRefreshTimer(
  channel: LarkChannel,
  controls: Controls,
): { stop(): void; } {
  const intervalMs = 30 * 60 * 1000;
  const refresh = async (): Promise<void> => {
    const chats = await fetchKnownChats(channel);

    if (chats.length > 0) {
      controls.knownChats = chats;
    }
  };

  void refresh();

  const timer = setInterval(() => void refresh(), intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
