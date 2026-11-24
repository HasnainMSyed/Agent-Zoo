// Grok shows plan limits only inside its own terminal interface (`grok usage` says so, and the app
// protocol has no usage method). So this starts Grok out of sight, types /usage, reads the screen
// text, and stops it. No message is sent. Grok records each start as an empty session; the ones
// this creates live in a private folder and are deleted afterwards, so Grok's own /resume stays tidy.

import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn as spawnPty } from "node-pty";
import type { UsageLimits } from "@shared/commands";
import { agentEnv } from "./env";
import { rpcSession, withGrok } from "./history-index";

type Limits = Partial<UsageLimits> & { agent: "grok" };

const strip = (s: string) => s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\x1b[()][A-Z0-9]/g, "");

/** Reads "Weekly limit (SuperGrok) … 10% … Resets: November 28, 00:10" blocks from the /usage screen. */
export function parseGrokUsage(screen: string, now = new Date()): Limits | null {
  const text = strip(screen).replace(/[│┌┐└┘─]/g, " ");
  const windows: UsageLimits["windows"] = [];
  let plan: string | undefined;
  const re = /(\w+) limit \(([^)]+)\)[\s█░▓▒]*?(\d{1,3})%\s*(?:Resets:\s*([A-Z][a-z]+ \d{1,2}),?\s*(\d{1,2}:\d{2}))?/g;
  for (const m of text.matchAll(re)) {
    plan = m[2]!.trim();
    let resetsAt: number | undefined;
    if (m[4] && m[5]) {
      let t = Date.parse(`${m[4]}, ${now.getFullYear()} ${m[5]}`);
      if (!Number.isNaN(t) && t < now.getTime() - 86_400_000) t = Date.parse(`${m[4]}, ${now.getFullYear() + 1} ${m[5]}`);
      if (!Number.isNaN(t)) resetsAt = Math.round(t / 1000);
    }
    const label = m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase();
    if (!windows.some((w) => w.label === label)) windows.push({ label, usedPct: Number(m[3]), resetsAt });
  }
  return windows.length ? { agent: "grok", plan, windows } : null;
}

let running: Promise<Limits | null> | undefined;

export function grokUsage(dataDir: string): Promise<Limits | null> {
  running ??= withGrok(() => readUsage(dataDir)).finally(() => { running = undefined; });
  return running;
}

async function readUsage(dataDir: string): Promise<Limits | null> {
  const cwd = join(dataDir, "grok-usage");
  mkdirSync(cwd, { recursive: true });
  let result: Limits | null = null;
  try {
    result = await new Promise<Limits | null>((resolve) => {
      let out = "", tries = 0, done = false, trustAnswered = false;
      let quiet: NodeJS.Timeout | undefined, retry: NodeJS.Timeout | undefined;
      const p = spawnPty("grok", [], { name: "xterm-256color", cols: 120, rows: 40, cwd, env: agentEnv({ TERM: "xterm-256color" }) });
      const finish = (r: Limits | null) => {
        if (done) return; done = true;
        clearTimeout(giveUp); clearTimeout(quiet); clearTimeout(retry); clearTimeout(fallback);
        try { p.kill(); } catch { /* gone */ }
        resolve(r);
      };
      // Keys typed while Grok is still drawing its start screen get lost, so type once it has been
      // quiet for a moment, and try once more if the usage screen doesn't appear.
      const type = () => {
        if (done || tries >= 2) return;
        tries++;
        p.write("\x1b"); // clear anything half-typed
        setTimeout(() => p.write("/usage"), 300);
        setTimeout(() => p.write("\r"), 1000);
        retry = setTimeout(type, 6000);
      };
      const giveUp = setTimeout(() => finish(parseGrokUsage(out)), 25_000);
      const fallback = setTimeout(() => { if (!tries) type(); }, 12_000);
      p.onData((d) => {
        out += d;
        // Grok asks what terminal it's in and waits for the answer; reply as xterm would.
        if (d.includes("\x1b[c") || d.includes("\x1b[0c")) p.write("\x1b[?62;22c");
        if (d.includes("\x1b[>0q")) p.write("\x1bP>|xterm(370)\x1b\\");
        if (d.includes("\x1b[6n")) p.write("\x1b[1;1R");
        if (tries) clearTimeout(fallback);
        // A new folder gets Grok's "Do you trust the contents of this directory?" question once.
        // This folder is the app's own and empty, so it's safe to answer yes; Grok remembers it.
        if (!trustAnswered && !tries && /trust the contents of this directory/.test(strip(out.slice(-6000)))) {
          trustAnswered = true; clearTimeout(quiet);
          setTimeout(() => p.write("y"), 600);
        }
        if (!tries && /❯/.test(d + out.slice(-2000)) && !/trust the contents/.test(strip(out.slice(-6000)))) { clearTimeout(quiet); quiet = setTimeout(type, 1500); }
        if (tries) { const r = parseGrokUsage(out); if (r && r.windows!.every((w) => w.resetsAt)) finish(r); }
      });
      p.onExit(() => finish(parseGrokUsage(out)));
    });
  } catch { /* grok not installed */ }
  await removeOwnSessions(cwd).catch(() => {});
  return result;
}

/** Deletes the empty sessions Grok recorded for these hidden runs (only untitled ones in our private folder). */
async function removeOwnSessions(cwd: string) {
  const ids: string[] = [];
  await rpcSession("grok", ["agent", "stdio"], true, async (rpc) => {
    await rpc("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const res = await rpc("session/list", {});
    const norm = (p: unknown) => String(p ?? "").replace(/\/+$/, "");
    for (const s of res.sessions ?? []) if (norm(s.cwd) === norm(cwd) && !s.title && s.sessionId) ids.push(String(s.sessionId));
  });
  for (const id of ids) {
    await new Promise<void>((resolve) => execFile("grok", ["sessions", "delete", id], { env: agentEnv(), timeout: 10_000 }, () => resolve()));
  }
}
