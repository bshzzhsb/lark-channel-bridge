import type { NormalizedMessage } from '@larksuite/channel';

import type { ChatMode } from '@/bot/chat-mode-cache';
import type { RunCot } from '@/bot/cot';
import type { AgentRunOptions, AgentRunResult } from '@/commands';

export interface ImRunRequest {
  batch: NormalizedMessage[];
  scope: string;
  mode: ChatMode;
  cotRun: RunCot;
  runOptions?: AgentRunOptions;
}

export type ImRunResult = Omit<AgentRunResult, 'scopeId' | 'anchorMessageId'>;
export type ImRunner = (request: ImRunRequest) => Promise<ImRunResult | undefined>;
