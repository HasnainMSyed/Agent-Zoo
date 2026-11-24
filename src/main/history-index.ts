// Finds conversations each agent has saved, for the home screen's projects and "pick up where you
// left off". Claude's are read from its session files; Codex and Grok are asked through their own
// protocols (no prompt is sent, so this costs nothing). Codex's lookup also refreshes plan limits.

import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { closeSync, mkdirSync, openSync, readSync, readdirSync, statSync, watch } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { PastSession, UsageLimits } from "@shared/commands";
import type { AgentEvent } from "@shared/events";
import { agentEnv } from "./env";
import { codexAccount, codexLimits } from "./adapters/codex-mapper";

type Json = Record<string, any>;
const LIMIT = 100;

function readSlice(path: string, from: number, bytes: number): string {
  const fd = openSync(path, "r");
  try { const buf = Buffer.alloc(bytes); const n = readSync(fd, buf, 0, bytes, Math.max(0, from)); return buf.subarray(0, n).toString("utf8"); }
  finally { closeSync(fd); }
}

const LIVE_MS = 90_000;
const CLAUDE_MAX = 400;
/** Parsed Claude session files, reused until the file's size or date changes. */
const claudeCache = new Map<string, { mtime: number; size: number; s: PastSession | null }>();

/** Reads one Claude session file's folder and title from its start and end only, so big files stay cheap. */
export function parseClaudeSession(head: string, tail: string, fallbackId: string): Omit<PastSession, "updatedAt"> | null {
  let cwd = "", prompt = "", id = fallbackId, aiTitle = "", customTitle = "";
  const scan = (text: string) => {
    for (const line of text.split("\n")) {
      if (!line.startsWith("{")) continue; // a cut-off first line in the tail
      let e: Json;
      try { e = JSON.parse(line); } catch { continue; }
      if (!cwd && typeof e.cwd === "string") cwd = e.cwd;
      if (e.type === "ai-title" && typeof e.aiTitle === "string") aiTitle = e.aiTitle;
      if (e.type === "custom-title" && typeof e.customTitle === "string" && !e.customTitle.startsWith("/")) customTitle = e.customTitle;
      const c = e.message?.content;
      if (!prompt && e.type === "user" && !e.isMeta && !e.isSidechain && typeof c === "string" && !c.startsWith("<")) prompt = c;
    }
  };
  scan(head);
  if (tail) scan(tail);
  const title = customTitle || aiTitle || prompt;
  // Sessions without a real message (or subagent side files) aren't worth listing.
  if (!cwd || !title) return null;
  return { agent: "claude", id, cwd, title: title.replace(/\s+/g, " ").trim().slice(0, 80) };
}

function claudeSessions(): PastSession[] {
  const root = join(homedir(), ".claude", "projects");
  const files: { path: string; mtime: number; size: number }[] = [];
  try {
    for (const dir of readdirSync(root)) {
      let names: string[];
      try { names = readdirSync(join(root, dir)); } catch { continue; }
      for (const f of names) {
        if (!f.endsWith(".jsonl")) continue;
        const path = join(root, dir, f);
        try { const st = statSync(path); files.push({ path, mtime: st.mtimeMs, size: st.size }); } catch { /* vanished */ }
      }
    }
  } catch { return []; }
  files.sort((a, b) => b.mtime - a.mtime);
  const out: PastSession[] = [];
  const now = Date.now();
  for (const { path, mtime, size } of files.slice(0, CLAUDE_MAX)) {
    let hit = claudeCache.get(path);
    if (!hit || hit.mtime !== mtime || hit.size !== size) {
      let parsed: PastSession | null = null;
      try {
        const head = readSlice(path, 0, 96_000);
        const tail = size > 96_000 ? readSlice(path, size - 64_000, 64_000) : "";
        const p = parseClaudeSession(head, tail, path.split("/").pop()!.replace(/\.jsonl$/, ""));
        parsed = p ? { ...p, updatedAt: mtime } : null;
      } catch { /* unreadable */ }
      hit = { mtime, size, s: parsed };
      claudeCache.set(path, hit);
    }
    if (hit.s) out.push({ ...hit.s, liveElsewhere: now - mtime < LIVE_MS || undefined });
  }
  return out;
}

/** Runs a short JSON-RPC exchange with a CLI, then stops it. */
export async function rpcSession(cmd: string, args: string[], jsonrpc: boolean, run: (rpc: (m: string, p: Json) => Promise<Json>, notify: (m: string, p?: Json) => void) => Promise<void>, onNote?: (msg: Json) => void) {
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

/** Codex plan limits and plan, on request (the Refresh buttons). */
export async function codexLimitsNow(onLimits: (e: AgentEvent[]) => void): Promise<void> {
  await rpcSession("codex", ["app-server"], false, async (rpc, notify) => {
    await rpc("initialize", { clientInfo: { name: "agent-zoo", title: "Agent Zoo", version: "0.1.0" }, capabilities: null });
    notify("initialized");
    const [limits, account] = await Promise.all([rpc("account/rateLimits/read", {}).catch(() => undefined), rpc("account/read", {}).catch(() => undefined)]);
    if (limits) onLimits(codexLimits(limits.rateLimits ?? limits));
    if (account) onLimits(codexAccount({ authMode: account.account?.type ?? account.authMode, planType: account.account?.planType ?? account.planType }));
  });
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

/** Grok processes started together can block each other on Grok's own lock files, so the app
 *  runs its background Grok tasks (session list, usage read) one at a time. */
let grokQueue: Promise<unknown> = Promise.resolve();
export function withGrok<T>(task: () => Promise<T>): Promise<T> {
  const next = grokQueue.then(task, task);
  grokQueue = next.catch(() => {});
  return next;
}

async function grokSessions(): Promise<PastSession[]> {
  return withGrok(() => grokSessionsNow());
}

async function grokSessionsNow(): Promise<PastSession[]> {
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

/** Codex Cloud tasks (they run on OpenAI's servers). Empty when Codex Cloud isn't set up. */
async function codexCloudTasks(): Promise<PastSession[]> {
  const out = await new Promise<string>((resolve) => {
    // Run from a private folder: Codex Cloud writes a debug log (with account details) into its working folder.
    const cwd = join(tmpdir(), "agent-zoo-codex-cloud");
    try { mkdirSync(cwd, { recursive: true }); } catch { /* exists */ }
    execFile("codex", ["cloud", "list", "--json", "--limit", "20"], { cwd, env: agentEnv(), timeout: 15_000 }, (_err, stdout) => resolve(String(stdout ?? "")));
  });
  try {
    const tasks: Json[] = JSON.parse(out).tasks ?? [];
    return tasks.filter((t) => t.id).map((t): PastSession => ({
      agent: "codex", cloud: true, id: String(t.id),
      cwd: String(t.environment_label ?? t.environment_id ?? "Codex Cloud"),
      title: String(t.title ?? t.id).replace(/\s+/g, " ").slice(0, 80),
      updatedAt: Date.parse(t.updated_at ?? t.created_at ?? "") || 0,
      status: t.status ? String(t.status) : undefined,
    }));
  } catch { return []; }
}

// Codex and Grok are asked by starting their CLIs, so their answers are kept for a minute;
// Claude's files are re-read on every call (cheap: unchanged files come from claudeCache).
let slow: { at: number; sessions: PastSession[] } | undefined;
let slowRun: Promise<PastSession[]> | undefined;

/** All agents' saved conversations, newest first. Agents that aren't installed are skipped. */
export async function pastSessions(onLimits: (limits: (Partial<UsageLimits> & { agent: UsageLimits["agent"] })[]) => void, fresh = false): Promise<PastSession[]> {
  if (fresh || !slow || Date.now() - slow.at > 60_000) {
    slowRun ??= (async () => {
      const sink = (evs: AgentEvent[]) => onLimits(evs.flatMap((e) => (e.kind === "limits" ? [e.limits] : [])));
      const results = await Promise.allSettled([codexSessions(sink), grokSessions(), codexCloudTasks()]);
      const sessions = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
      slow = { at: Date.now(), sessions };
      return sessions;
    })().finally(() => { slowRun = undefined; });
    await slowRun;
  }
  return [...claudeSessions(), ...slow!.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Calls back (debounced) when Claude saves to any session file, including ones started in a terminal. */
export function watchClaudeSessions(onChange: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  try {
    const w = watch(join(homedir(), ".claude", "projects"), { recursive: true }, (_ev, name) => {
      if (!name || !String(name).endsWith(".jsonl")) return;
      clearTimeout(timer);
      timer = setTimeout(onChange, 2500);
    });
    return () => { clearTimeout(timer); w.close(); };
  } catch { return () => {}; }
}
