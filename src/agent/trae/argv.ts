import { buildCodexArgs, type BuildCodexArgsInput } from '@/agent/codex/argv';

export type BuildTraeArgsInput = Pick<BuildCodexArgsInput, 'cwd' | 'sandbox' | 'threadId' | 'images' | 'model'>;

/** TRAE 2.0 shares the exec layout, but must retain the user's config and rules. */
export function buildTraeArgs(input: BuildTraeArgsInput): string[] {
  return buildCodexArgs({ ...input, ignoreRules: false, ignoreUserConfig: false });
}
