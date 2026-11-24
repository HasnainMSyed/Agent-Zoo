// Which Claude conversations are running somewhere else right now (a terminal, an editor), and
// moving one into Agent Zoo. Claude Code keeps a record of every running session in
// ~/.claude/sessions/<pid>.json: its conversation id, folder and status (busy, idle or waiting).

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LiveClaude { pid: number; sessionId: string; cwd: string; status: string }

/** A process's parent pid and start time, from /proc (Linux); null when it isn't running. */
function procStat(pid: number): { ppid: number; start: string } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // the fields after the command name
    return { ppid: Number(f[1]), start: f[19]! };
  } catch { return null; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** True when pid is this app or one of its descendants (the app's own agents and terminals). */
function ours(pid: number): boolean {
  for (let p = pid, hops = 0; p > 1 && hops < 40; hops++) {
    if (p === process.pid) return true;
    const s = procStat(p);
    if (!s) return false;
    p = s.ppid;
  }
  return false;
}

/** Claude sessions running outside Agent Zoo, by conversation id. */
export function liveClaudeElsewhere(): Map<string, LiveClaude> {
  const out = new Map<string, LiveClaude>();
  // Telling the app's own agents apart needs /proc (Linux); elsewhere, report nothing rather than guess.
  if (process.platform !== "linux") return out;
  const dir = join(homedir(), ".claude", "sessions");
  let names: string[];
  try { names = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)); } catch { return out; }
  for (const n of names) {
    try {
      const d = JSON.parse(readFileSync(join(dir, n), "utf8"));
      const pid = Number(d.pid);
      if (!pid || typeof d.sessionId !== "string" || !alive(pid)) continue;
      // A reused pid belongs to some other program: the recorded start time must match.
      const st = process.platform === "linux" ? procStat(pid) : null;
      if (st && d.procStart && String(d.procStart) !== st.start) continue;
      if (ours(pid)) continue;
      out.set(d.sessionId, { pid, sessionId: d.sessionId, cwd: d.cwd, status: typeof d.status === "string" ? d.status : "unknown" });
    } catch { /* half-written or unreadable */ }
  }
  return out;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ends the copy of a Claude conversation running elsewhere, once it's safe: it waits for the
 * agent to finish its turn (status "idle") so no work is cut off, then asks it to quit and waits
 * for it to exit. Everything it did is already saved, so reopening it here carries on exactly.
 * onWaiting reports why it's waiting: "busy" (working) or "waiting" (asking something in its terminal).
 */
export async function takeOverClaude(sessionId: string, opts: { now?: boolean; onWaiting?: (status: string) => void; cancelled?: () => boolean } = {}): Promise<"closed" | "gone"> {
  let last = "";
  for (;;) {
    if (opts.cancelled?.()) throw new Error("Cancelled.");
    const live = liveClaudeElsewhere().get(sessionId);
    if (!live) return "gone";
    if (opts.now || live.status === "idle") {
      try { process.kill(live.pid, "SIGTERM"); } catch { return "gone"; }
      for (let i = 0; i < 60 && alive(live.pid); i++) await wait(100);
      if (alive(live.pid)) throw new Error("The other copy didn't close. Close it yourself, then try again.");
      return "closed";
    }
    if (live.status !== last) { last = live.status; opts.onWaiting?.(live.status); }
    await wait(700);
  }
}
