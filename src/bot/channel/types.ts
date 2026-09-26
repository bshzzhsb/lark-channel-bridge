import type { LarkChannel } from '@larksuite/channel';

import type { AgentAdapter } from '@/agent/types';
import type { Controls } from '@/commands';
import type { AppPaths } from '@/config/app-paths';
import type { AppConfig } from '@/config/schema';
import type { SessionCatalog } from '@/session/catalog';
import type { SessionStore } from '@/session/store';
import type { WorkspaceStore } from '@/workspace/store';

export interface BridgeChannel {
  channel: LarkChannel;
  disconnect(): Promise<void>;
}

export interface StartChannelDeps {
  cfg: AppConfig;
  agent: AgentAdapter;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  controls: Controls;
  appPaths?: Pick<AppPaths, 'secretsFile' | 'keystoreSaltFile' | 'mediaDir'>;
}
