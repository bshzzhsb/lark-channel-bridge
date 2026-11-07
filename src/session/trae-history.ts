import {
  CodexHistoryError,
  type CodexHistoryErrorCode,
  type CodexThreadHistoryEntry,
  listCodexThreadHistory,
  type ListCodexThreadHistoryOptions,
} from './codex-history';

export type TraeThreadHistoryEntry = CodexThreadHistoryEntry;
export type ListTraeThreadHistoryOptions = Pick<ListCodexThreadHistoryOptions, 'binary' | 'cwd' | 'limit' | 'timeoutMs'>;

export class TraeHistoryError extends Error {
  constructor(readonly code: CodexHistoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TraeHistoryError';
  }
}

/** TRAE 2.0 thread/list matches its generated app-server protocol types. */
export async function listTraeThreadHistory(options: ListTraeThreadHistoryOptions): Promise<TraeThreadHistoryEntry[]> {
  try {
    return await listCodexThreadHistory({
      ...options, agentId: 'trae', profileStateDir: '',
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'acp', 'unknown'],
    });
  } catch (err) {
    if (err instanceof CodexHistoryError) throw new TraeHistoryError(err.code, err.message, { cause: err });
    throw err;
  }
}
