// Environment for agent processes. When Agent Zoo itself is launched from inside a Claude Code
// session, it inherits that session's private markers (including a messaging token). Passed on, they
// make child agents think they are subagents, which turns off transcript saving and breaks resume.

const INHERITED = /^(CLAUDECODE|CLAUDE_CODE_[A-Z_]+|CLAUDE_PID)$/;

export function agentEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !INHERITED.test(k)) env[k] = v;
  return { ...env, ...extra };
}

/**
 * Apps started from the desktop menu don't get the PATH a terminal has (agents often install into
 * ~/.local/bin or ~/.grok/bin via .bashrc), so they couldn't find claude, codex or grok. This asks
 * the user's login shell for its PATH once at startup and adds the usual install folders.
 */
export async function loadShellPath(): Promise<void> {
  if (process.platform === "win32") return;
  const { execFile } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { delimiter, join } = await import("node:path");
  const mark = "__AGENT_ZOO_PATH__";
  const fromShell = await new Promise<string>((done) => {
    const shell = process.env.SHELL || "/bin/bash";
    // -i so .bashrc runs; markers because interactive shells may print greetings.
    execFile(shell, ["-ilc", `printf '${mark}%s${mark}' "$PATH"`], { timeout: 5000, env: agentEnv(), encoding: "utf8" },
      (_err, stdout) => done(new RegExp(`${mark}(.*?)${mark}`).exec(stdout ?? "")?.[1] ?? ""));
  });
  const home = homedir();
  const extra = [".local/bin", ".grok/bin", ".npm-global/bin", ".bun/bin", ".cargo/bin"].map((d) => join(home, d)).filter(existsSync);
  const seen = new Set<string>();
  const parts = [...(process.env.PATH ?? "").split(delimiter), ...fromShell.split(delimiter), ...extra]
    .filter((p) => p && !seen.has(p) && seen.add(p));
  process.env.PATH = parts.join(delimiter);
}
