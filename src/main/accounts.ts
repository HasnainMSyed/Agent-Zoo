// Sign-in state and versions of each agent's CLI, for the Settings page. Each CLI is asked in
// its own way; nothing here sends a prompt. Credentials are never read: Grok's sign-in file is
// opened only for its non-secret fields (mode and name).

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentId } from "@shared/events";
import type { AccountInfo } from "@shared/commands";
import { agentEnv } from "./env";

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: agentEnv(), timeout: 15_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err && !stdout) reject(err); else resolve(String(stdout || stderr));
    });
  });
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const version = (cmd: string) => run(cmd, ["--version"]).then((v) => v.trim().split("\n")[0]!.replace(/^(codex-cli|grok)\s+/, "").replace(/\s*\(.*\)$/, "")).catch(() => undefined);

async function claude(): Promise<AccountInfo> {
  const v = await version("claude");
  if (!v) return { installed: false };
  try {
    const s = JSON.parse(await run("claude", ["auth", "status", "--json"]));
    const method = s.authMethod === "claude.ai" ? "Claude account" : s.authMethod ? String(s.authMethod) : undefined;
    return { installed: true, version: v, signedIn: Boolean(s.loggedIn), method, plan: s.subscriptionType ? `Claude ${cap(s.subscriptionType)}` : undefined, who: s.email };
  } catch { return { installed: true, version: v }; }
}

async function codex(): Promise<AccountInfo> {
  const v = await version("codex");
  if (!v) return { installed: false };
  const out = await run("codex", ["login", "status"]).catch(() => "");
  const signedIn = /logged in/i.test(out) && !/not logged in/i.test(out);
  const method = /chatgpt/i.test(out) ? "ChatGPT account" : /api key/i.test(out) ? "API key" : undefined;
  return { installed: true, version: v, signedIn, method };
}

async function grok(): Promise<AccountInfo> {
  const v = await version("grok");
  if (!v) return { installed: false };
  try {
    const entries = Object.values(JSON.parse(readFileSync(join(homedir(), ".grok", "auth.json"), "utf8")) as Record<string, any>);
    const e = entries[0];
    if (!e) return { installed: true, version: v, signedIn: false };
    const first = String(e.first_name ?? "").trim(), last = String(e.last_name ?? "").trim();
    const who = (last && !first.endsWith(last) ? `${first} ${last}`.trim() : first) || e.email;
    return { installed: true, version: v, signedIn: true, method: e.auth_mode === "api_key" ? "API key" : "xAI account", who };
  } catch { return { installed: true, version: v, signedIn: false }; }
}

export async function accounts(): Promise<Record<AgentId, AccountInfo>> {
  const [c, x, g] = await Promise.all([claude(), codex(), grok()]);
  return { claude: c, codex: x, grok: g };
}

/** The only commands the Settings page may run in its small terminal. */
export const ACCOUNT_COMMANDS: Record<AgentId, Record<"login" | "logout", string[]>> = {
  claude: { login: ["claude", "auth", "login"], logout: ["claude", "auth", "logout"] },
  codex: { login: ["codex", "login"], logout: ["codex", "logout"] },
  grok: { login: ["grok", "login"], logout: ["grok", "logout"] },
};
