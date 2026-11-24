import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CodexMapper, parseUnifiedDiff } from "../src/main/adapters/codex-mapper";
import type { AgentEvent } from "../src/shared/events";

function replay(path: string): AgentEvent[] {
  const mapper = new CodexMapper();
  return readFileSync(path, "utf8").split("\n").filter((l) => l.startsWith("< "))
    .map((l) => JSON.parse(l.slice(2)))
    .filter((m) => m.method) // responses to our own requests carry no events
    .flatMap((m) => mapper.feed(m));
}

// Recordings are private (they hold local setup details) and git-ignored; record your own with tools/record_*.py.
const HAS = existsSync("fixtures/codex-twoway.ndjson");

describe.skipIf(!HAS)("CodexMapper on the two-turn fixture", () => {
  const events = HAS ? replay("fixtures/codex-twoway.ndjson") : [];

  it("starts a session with the thread's model and cwd", () => {
    expect(events.find((e) => e.kind === "session.started")).toMatchObject({ agent: "codex", model: "gpt-6.2-sol", cwd: expect.stringContaining("sandbox") });
  });

  it("finishes both turns", () => {
    const done = events.filter((e) => e.kind === "turn.done");
    expect(done).toHaveLength(2);
    expect(done.every((d) => d.kind === "turn.done" && d.ok)).toBe(true);
  });

  it("turns approval requests into permission events with readable commands", () => {
    const perms = events.filter((e) => e.kind === "permission.request");
    expect(perms).toHaveLength(5);
    expect(perms[0]).toMatchObject({ tool: "shell", title: "python3 -c 'import calc; print(calc.add(2,3))'" });
    const edit = perms.find((p) => p.kind === "permission.request" && p.tool === "edit");
    expect(edit && edit.kind === "permission.request" && edit.diff?.[0]?.lines).toContain("+def mul(a, b):");
  });

  it("pairs tool starts and finishes, with command output and a diff", () => {
    const started = events.filter((e) => e.kind === "tool.started").map((e) => (e as { id: string }).id);
    const finished = new Map(events.flatMap((e) => (e.kind === "tool.finished" ? [[e.id, e] as const] : [])));
    expect(started.length).toBeGreaterThan(0);
    expect(started.every((id) => finished.has(id))).toBe(true);
    const shell = [...finished.values()].find((f) => f.result.kind === "shell");
    expect(shell?.result).toMatchObject({ kind: "shell", stdout: "5" });
    expect([...finished.values()].some((f) => f.result.kind === "edit")).toBe(true);
  });

  it("streams agent messages whose deltas add up", () => {
    const done = events.filter((e) => e.kind === "message.done") as { id: string; text: string }[];
    expect(done.length).toBeGreaterThan(0);
    for (const d of done) {
      const joined = events.filter((e) => e.kind === "message.delta" && e.id === d.id).map((e) => (e as { text: string }).text).join("");
      expect(joined).toBe(d.text);
    }
  });

  it("reports token usage against the context window", () => {
    expect(events.filter((e) => e.kind === "usage").at(-1)).toMatchObject({ contextWindow: 475000, contextUsed: expect.any(Number) });
  });

  it("raises no errors on a clean run", () => {
    expect(events.some((e) => e.kind === "error")).toBe(false);
  });
});

describe("Codex helpers", () => {
  it("parses unified diffs and skips file headers", () => {
    const hunks = parseUnifiedDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -4,3 +4,4 @@\n a\n-b\n+c\n+d\n");
    expect(hunks).toEqual([{ oldStart: 4, newStart: 4, lines: [" a", "-b", "+c", "+d"] }]);
  });

  it("answers approvals with Codex decisions and declines unknown requests", () => {
    const m = new CodexMapper();
    m.feed({ id: 7, method: "item/commandExecution/requestApproval", params: { itemId: "x", command: "ls", availableDecisions: ["accept", "acceptForSession", "decline"] } });
    expect(m.permissionResponse("codex-7", "allow_always")).toEqual({ id: 7, result: { decision: "acceptForSession" } });
    expect(m.permissionResponse("codex-7", "allow")).toBeUndefined();
    const evs = m.feed({ id: 8, method: "item/tool/requestUserInput", params: {} });
    expect(evs[0]?.kind).toBe("error");
    expect(m.unsupported).toEqual([8]);
  });

  it("surfaces failed turns with the server's message", () => {
    const m = new CodexMapper();
    const out = m.feed({ method: "turn/completed", params: { turn: { status: "failed", error: { message: "The 'gpt-5.3-codex' model is not supported" } } } });
    expect(out[0]).toMatchObject({ kind: "turn.done", ok: false, error: expect.stringContaining("not supported") });
  });
});
