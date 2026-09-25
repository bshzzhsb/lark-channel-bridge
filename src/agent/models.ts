import type { AgentKind } from '../config/profile-schema';

/** Legacy value kept for existing config files; new forms use an empty input. */
export const DEFAULT_MODEL = 'default';

/** True when the selection means "don't pass --model". */
export function isDefaultModel(value: string | undefined): boolean {
  const normalized = value?.trim();
  return !normalized || normalized === DEFAULT_MODEL;
}

/** Trim a user-entered model name while preserving the legacy default sentinel. */
export function normalizeModelSelection(
  _agentKind: AgentKind,
  value: string | undefined,
): string {
  const normalized = value?.trim();
  return !normalized || normalized === DEFAULT_MODEL ? DEFAULT_MODEL : normalized;
}

/** Resolve the model string to pass to the CLI, or omit the flag for default. */
export function resolveModelArg(
  agentKind: AgentKind,
  value: string | undefined,
): string | undefined {
  const normalized = normalizeModelSelection(agentKind, value);
  return normalized === DEFAULT_MODEL ? undefined : normalized;
}

/** Display a stored model name or the default-selection label. */
export function modelLabel(agentKind: AgentKind, value: string | undefined): string {
  const normalized = normalizeModelSelection(agentKind, value);
  return normalized === DEFAULT_MODEL ? '跟随 CLI 默认（不指定）' : normalized;
}
