// Environment for agent processes. When Agent Zoo itself is launched from inside a Claude Code
// session, it inherits that session's private markers (including a messaging token). Passed on, they
// make child agents think they are subagents, which turns off transcript saving and breaks resume.

const INHERITED = /^(CLAUDECODE|CLAUDE_CODE_[A-Z_]+|CLAUDE_PID)$/;

export function agentEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !INHERITED.test(k)) env[k] = v;
  return { ...env, ...extra };
}
