import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GrokMapper, textDiff } from "../src/main/adapters/grok-mapper";
import { grokEvents } from "../src/main/adapters/replay";
import type { AgentEvent } from "../src/shared/events";

// Recordings are private (they hold local setup details) and git-ignored; record your own with tools/record_*.py.
const HAS = existsSync("fixtures/grok-twoway.ndjson");
const lines = (HAS ? readFileSync("fixtures/grok-twoway.ndjson", "utf8") : "").split("\n").filter((l) => l.trim())
  .map((raw): [boolean, Record<string, any>] => [raw.startsWith("> "), JSON.parse(raw.slice(2))]);

describe.skipIf(!HAS)("GrokMapper on the two-turn fixture", () => {
  const events: AgentEvent[] = grokEvents(lines);

  it("starts a session with model and cwd", () => {
    expect(events.find((e) => e.kind === "session.started")).toMatchObject({ agent: "grok", model: expect.stringContaining("grok"), cwd: expect.stringContaining("sandbox") });
  });

  it("finishes both turns exactly once each", () => {
    const done = events.filter((e) => e.kind === "turn.done");
    expect(done).toHaveLength(2);
    expect(done.every((d) => d.kind === "turn.done" && d.ok)).toBe(true);
  });

  it("raises permission requests with Grok's choices and resolves them", () => {
    const perms = events.filter((e) => e.kind === "permission.request");
    expect(perms).toHaveLength(4);
    const first = perms[0]!;
    expect(first).toMatchObject({ tool: "shell", title: "python3 -c 'import calc; print(calc.add(2,3))'" });
    if (first.kind === "permission.request") expect(first.options.map((o) => o.id)).toEqual(["allow", "allow_always", "deny"]);
    const edit = perms.find((p) => p.kind === "permission.request" && p.tool === "edit");
    expect(edit && edit.kind === "permission.request" && edit.diff?.[0]?.lines).toContain("+def div(a, b):");
    expect(events.filter((e) => e.kind === "permission.resolved")).toHaveLength(4);
  });

  it("pairs tool starts with finishes and keeps shell output, diffs and reads", () => {
    const started = events.filter((e) => e.kind === "tool.started").map((e) => (e as { id: string }).id);
    const finished = new Map(events.flatMap((e) => (e.kind === "tool.finished" ? [[e.id, e] as const] : [])));
    expect(started.length).toBeGreaterThanOrEqual(5);
    expect(started.every((id) => finished.has(id))).toBe(true);
    expect([...finished.values()].find((f) => f.result.kind === "shell" && f.result.stdout === "5")).toBeDefined();
    expect([...finished.values()].some((f) => f.result.kind === "edit")).toBe(true);
    const read = [...finished.values()].find((f) => f.result.kind === "read");
    expect(read?.result.kind === "read" && read.result.content.startsWith("def add(a, b):")).toBe(true);
  });

  it("splits text into blocks around tools, and deltas add up to each block", () => {
    const done = events.filter((e) => e.kind === "message.done") as { id: string; text: string }[];
    expect(done.length).toBeGreaterThanOrEqual(2);
    for (const d of done) {
      const joined = events.filter((e) => e.kind === "message.delta" && e.id === d.id).map((e) => (e as { text: string }).text).join("");
      expect(joined).toBe(d.text);
    }
  });

  it("reports cost from ticks as a session total, with the model's context window", () => {
    const usage = events.filter((e) => e.kind === "usage");
    expect(usage.length).toBe(2);
    expect(usage[0]).toMatchObject({ costUsd: expect.closeTo(0.165, 2), contextWindow: 256000, contextUsed: expect.any(Number) });
    // `grok usage` reports 3,386,440,000 ticks for this whole session.
    expect(usage[1]).toMatchObject({ costUsd: expect.closeTo(0.3386, 3) });
  });
});

describe("Grok helpers", () => {
  it("diffs search/replace edits with shared lines as context", () => {
    expect(textDiff("a\nb", "a\nb\nc", 9)).toEqual({ oldStart: 9, newStart: 9, lines: [" a", " b", "+c"] });
    expect(textDiff("x\ny\nz", "x\nY\nz").lines).toEqual([" x", "-y", "+Y", " z"]);
  });

  it("maps decisions to Grok option ids and cancels when there is no match", () => {
    const m = new GrokMapper("/tmp");
    m.feed({ jsonrpc: "2.0", id: 5, method: "session/request_permission", params: { toolCall: { toolCallId: "t", kind: "execute", rawInput: { command: "ls" } },
      options: [{ optionId: "allow-once", kind: "allow_once", name: "Yes" }, { optionId: "reject-once", kind: "reject_once", name: "No" }] } });
    expect(m.permissionResponse("grok-5", "deny")).toEqual({ jsonrpc: "2.0", id: 5, result: { outcome: { outcome: "selected", optionId: "reject-once" } } });
    m.feed({ jsonrpc: "2.0", id: 6, method: "session/request_permission", params: { toolCall: { toolCallId: "t" }, options: [{ optionId: "allow-once", kind: "allow_once" }] } });
    expect(m.permissionResponse("grok-6", "allow_always")?.result.outcome).toEqual({ outcome: "cancelled" });
  });

  it("ends a turn only once and reports a stop as not ok", () => {
    const m = new GrokMapper("/tmp");
    m.beginTurn();
    expect(m.endTurn("cancelled")).toEqual([{ kind: "turn.done", ok: false, error: "Stopped" }]);
    expect(m.endTurn("end_turn")).toEqual([]);
  });

  it("declines requests it doesn't support so Grok never waits", () => {
    const m = new GrokMapper("/tmp");
    expect(m.feed({ jsonrpc: "2.0", id: 9, method: "fs/read_text_file", params: {} })[0]?.kind).toBe("error");
    expect(m.unsupported).toEqual([9]);
  });
});
