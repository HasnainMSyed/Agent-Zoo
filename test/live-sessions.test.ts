// "Bring it here": a stand-in for a Claude session running in another terminal (a detached
// `sleep`, recorded the way Claude Code records running sessions) is closed only once it's idle.
import { afterEach, beforeEach, expect, test } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveClaudeElsewhere, takeOverClaude } from "../src/main/live-sessions";

const linux = process.platform === "linux";
let home = "", oldHome: string | undefined, pid = 0;
const ID = "0000aaaa-1111-2222-3333-444455556666";

function record(status: string) {
  const start = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[19];
  writeFileSync(join(home, ".claude", "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: ID, cwd: "/tmp", status, procStart: start }));
}

beforeEach(() => {
  oldHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "zoo-live-"));
  mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
  process.env.HOME = home;
  // Detached, so it isn't a child of this process (the app's own agents are skipped).
  pid = linux ? Number(execSync("setsid sh -c 'sleep 30 >/dev/null 2>&1 & echo $!'").toString().trim()) : 0;
});
afterEach(() => {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  process.env.HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});

test.runIf(linux)("waits for the other copy to finish its turn, then closes it", async () => {
  record("busy");
  expect(liveClaudeElsewhere().get(ID)?.status).toBe("busy");
  const seen: string[] = [];
  const job = takeOverClaude(ID, { onWaiting: (s) => seen.push(s) });
  await new Promise((r) => setTimeout(r, 900));
  expect(seen).toEqual(["busy"]);
  expect(() => process.kill(pid, 0)).not.toThrow(); // still running mid-turn
  record("idle");
  await expect(job).resolves.toBe("closed");
  expect(() => process.kill(pid, 0)).toThrow();
  expect(liveClaudeElsewhere().has(ID)).toBe(false);
});

test.runIf(linux)("ignores a record whose pid now belongs to another program", () => {
  writeFileSync(join(home, ".claude", "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: ID, status: "idle", procStart: "1" }));
  expect(liveClaudeElsewhere().has(ID)).toBe(false);
});

test.runIf(linux)("can be cancelled while it waits", async () => {
  record("waiting");
  let stop = false;
  const job = takeOverClaude(ID, { cancelled: () => stop });
  setTimeout(() => { stop = true; }, 300);
  await expect(job).rejects.toThrow("Cancelled");
  expect(() => process.kill(pid, 0)).not.toThrow();
});
