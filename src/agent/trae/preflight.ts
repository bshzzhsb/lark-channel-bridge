import {
  type AgentAvailability, AgentPreflightError, checkAgentVersion,
} from '@/agent/preflight';

/** Validate the modern executable, not a legacy CoCo alias with the same name. */
export async function checkTraeAvailability(binary: string): Promise<AgentAvailability> {
  const base = { agentId: 'trae' as const, agentName: 'TRAE CLI', command: binary, binaryPath: binary };
  try {
    const version = await checkAgentVersion(base);
    if (!/^traecli\s+\d+\.\d+/i.test(version)) {
      throw new AgentPreflightError({ ...base, code: 'agent-capability-unsupported' });
    }
    for (const args of [['exec', '--help'], ['exec', 'resume', '--help']]) {
      const help = await checkAgentVersion({ ...base, args, fullOutput: true });
      if (!help.includes('--json') || !/stdin|standard input/i.test(help) || !help.includes('exec')) {
        throw new AgentPreflightError({ ...base, code: 'agent-capability-unsupported', args });
      }
    }
    return { ok: true, version };
  } catch (err) {
    if (err instanceof AgentPreflightError) return { ok: false, error: err, diagnostic: err.diagnostic };
    throw err;
  }
}
