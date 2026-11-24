// Finds conversations each agent has saved, for the home screen's projects and "pick up where you
// left off". Claude's are read from its session files; Codex and Grok are asked through their own
// protocols (no prompt is sent, so this costs nothing). Codex's lookup also refreshes plan limits.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PastSession, UsageLimits } from "@shared/commands";
import type { AgentEvent } from "@shared/events";
import { agentEnv } from "./env";
import { codexAccount, codexLimits } from "./adapters/codex-mapper";

type Json = Record<string, any>;
const LIMIT = 40;

function readHead(path: string, bytes = 96_000): string {
  const fd = openSync(path, "r");
  try { const buf = Buffer.alloc(bytes); const n = readSync(fd, buf, 0, bytes, 0); return buf.subarray(0, n).toString("utf8"); }
  finally { closeSync(fd); }
}

function claudeSessions(): PastSession[] {
  const root = join(homedir(), ".claude", "projects");
  const files: { path: string; mtime: number }[] = [];
  try {
    for (const dir of readdirSync(root)) {
      for (const f of readdirSync(join(root, dir))) {
        if (!f.endsWith(".jsonl")) continue;
        const path = join(root, dir, f);
        try { files.push({ path, mtime: statSync(path).mtimeMs }); } catch { /* vanished */ }
      }
    }
  } catch { return []; }
  files.sort((a, b) => b.mtime - a.mtime);
  const out: PastSession[] = [];
  for (const { path, mtime } of files.slice(0, LIMIT * 2)) {
    let cwd = "", title = "", id = path.split("/").pop()!.replace(/\.jsonl$/, "");
    for (const line of readHead(path).split("\n")) {
      let e: Json;
      try { e = JSON.parse(line); } catch { continue; }
      if (!cwd && typeof e.cwd === "string") cwd = e.cwd;
      if (e.sessionId) id = e.sessionId;
      const c = e.message?.content;
      if (!title && e.type === "user" && !e.isMeta && !e.isSidechain && typeof c === "string" && !c.startsWith("<")) title = c;
      if (cwd && title) break;
    }
    // Sessions without a real message (or subagent side files) aren't worth listing.
    if (cwd && title) out.push({ agent: "claude", id, cwd, title: title.replace(/\s+/g, " ").slice(0, 80), updatedAt: mtime });
    if (out.length >= LIMIT) break;
  }
  return out;
}

/** Runs a short JSON-RPC exchange with a CLI, then stops it. */
async function rpcSession(cmd: string, args: string[], jsonrpc: boolean, run: (rpc: (m: string, p: Json) => Promise<Json>, notify: (m: string, p?: Json) => void) => Promise<void>, onNote?: (msg: Json) => void) {
  const proc = spawn(cmd, args, { cwd: homedir(), env: agentEnv(), stdio: ["pipe", "pipe", "ignore"] });
  const calls = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  let next = 1;
  const write = (o: Json) => { if (proc.stdin.writable) proc.stdin.write(JSON.stringify(jsonrpc ? { jsonrpc: "2.0", ...o } : o) + "\n"); };
  createInterface({ input: proc.stdout }).on("line", (line) => {
    let m: Json; try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && !m.method) { const c = calls.get(m.id); calls.delete(m.id); m.error ? c?.reject(new Error(m.error.message)) : c?.resolve(m.result ?? {}); }
    else if (m.method) onNote?.(m);
  });
  const rpc = (method: string, params: Json) => new Promise<Json>((resolve, reject) => { const id = next++; calls.set(id, { resolve, reject }); write({ id, method, params }); });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), 10_000); });
  try { await Promise.race([run(rpc, (m, p) => write({ method: m, ...(p ? { params: p } : {}) })), timeout]); }
  finally { clearTimeout(timer); proc.stdin.end(); setTimeout(() => proc.kill("SIGTERM"), 300).unref(); }
}

async function codexSessions(onLimits: (e: AgentEvent[]) => void): Promise<PastSession[]> {
  const out: PastSession[] = [];
  await rpcSession("codex", ["app-server"], false, async (rpc, notify) => {
    await rpc("initialize", { clientInfo: { name: "agent-zoo", title: "Agent Zoo", version: "0.1.0" }, capabilities: null });
    notify("initialized");
    const [list, limits, account] = await Promise.all([
      rpc("thread/list", { limit: LIMIT }),
      rpc("account/rateLimits/read", {}).catch(() => undefined),
      rpc("account/read", {}).catch(() => undefined),
    ]);
    if (limits) onLimits(codexLimits(limits.rateLimits ?? limits));
    if (account) onLimits(codexAccount({ authMode: account.account?.type ?? account.authMode, planType: account.account?.planType ?? account.planType }));
    for (const t of list.data ?? []) {
      const cwd = t.environments?.[0]?.cwd ?? t.cwd;
      const title = t.name || t.preview;
      if (cwd && title) out.push({ agent: "codex", id: t.id, cwd, title: String(title).replace(/\s+/g, " ").slice(0, 80), updatedAt: (t.updatedAt ?? t.createdAt ?? 0) * 1000 });
    }
  });
  return out;
}

async function grokSessions(): Promise<PastSession[]> {
  const out: PastSession[] = [];
  await rpcSession("grok", ["agent", "stdio"], true, async (rpc) => {
    await rpc("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const res = await rpc("session/list", {});
    for (const s of res.sessions ?? []) {
      const title = s.title ?? s._meta?.summary;
      if (s.cwd && title) out.push({ agent: "grok", id: s.sessionId, cwd: s.cwd, title: String(title).slice(0, 80), updatedAt: Date.parse(s.updatedAt ?? "") || 0 });
    }
  });
  return out;
}

let cache: { at: number; sessions: PastSession[] } | undefined;

/** All agents' saved conversations, newest first. Agents that aren't installed are skipped. */
export async function pastSessions(onLimits: (limits: (Partial<UsageLimits> & { agent: UsageLimits["agent"] })[]) => void, fresh = false): Promise<PastSession[]> {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.sessions;
  const sink = (evs: AgentEvent[]) => onLimits(evs.flatMap((e) => (e.kind === "limits" ? [e.limits] : [])));
  const results = await Promise.allSettled([Promise.resolve(claudeSessions()), codexSessions(sink), grokSessions()]);
  const sessions = results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).sort((a, b) => b.updatedAt - a.updatedAt);
  cache = { at: Date.now(), sessions };
  return sessions;
}
