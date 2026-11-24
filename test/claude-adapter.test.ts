import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeMapper, claudeStatusModel, claudeUsageLimits } from "../src/main/adapters/claude-mapper";
import { mergeCommands } from "../src/shared/commands";
import type { AgentEvent } from "../src/shared/events";

/** Replays a recorded fixture; lines may carry a "< " / "> " direction prefix. */
function replay(path: string): AgentEvent[] {
  const mapper = new ClaudeMapper();
  return readFileSync(path, "utf8").split("\n").filter(Boolean)
    .filter((l) => !l.startsWith("> "))
    .flatMap((l) => mapper.feed(JSON.parse(l.replace(/^< /, ""))));
}

// Recordings are private (they hold local setup details) and git-ignored; record your own with tools/record_*.py.
const HAS_TWOWAY = existsSync("fixtures/claude-twoway.ndjson");
const HAS_EDIT = existsSync("fixtures/claude-edit.ndjson");

const kinds = (evs: AgentEvent[]) => evs.map((e) => e.kind);

describe.skipIf(!HAS_TWOWAY)("ClaudeMapper on the two-turn fixture", () => {
  const events = HAS_TWOWAY ? replay("fixtures/claude-twoway.ndjson") : [];

  it("starts a session with model and cwd", () => {
    const start = events.find((e) => e.kind === "session.started");
    expect(start).toMatchObject({ agent: "claude", model: expect.any(String), cwd: expect.stringContaining("sandbox") });
  });

  it("ends both turns successfully with cost", () => {
    const done = events.filter((e) => e.kind === "turn.done");
    expect(done).toHaveLength(2);
    expect(done.every((d) => d.kind === "turn.done" && d.ok)).toBe(true);
    const usage = events.filter((e) => e.kind === "usage");
    expect(usage.at(-1)).toMatchObject({ costUsd: expect.any(Number), contextWindow: expect.any(Number) });
  });

  it("raises permission requests with allow, always and deny", () => {
    const perms = events.filter((e) => e.kind === "permission.request");
    expect(perms.length).toBeGreaterThanOrEqual(2);
    const first = perms[0]!;
    expect(first).toMatchObject({ name: "Bash", tool: "shell" });
    if (first.kind === "permission.request") expect(first.options.map((o) => o.id)).toEqual(["allow", "allow_always", "deny"]);
  });

  it("pairs every tool start with a finish", () => {
    const started = new Set(events.flatMap((e) => (e.kind === "tool.started" ? [e.id] : [])));
    const finished = new Set(events.flatMap((e) => (e.kind === "tool.finished" ? [e.id] : [])));
    expect(started.size).toBeGreaterThan(0);
    expect([...started].every((id) => finished.has(id))).toBe(true);
  });

  it("produces a structured diff for the edit", () => {
    const edit = events.find((e) => e.kind === "tool.finished" && e.result.kind === "edit");
    expect(edit).toBeDefined();
    if (edit?.kind === "tool.finished" && edit.result.kind === "edit") {
      expect(edit.result.hunks[0]!.lines.some((l) => l.startsWith("+def sub"))).toBe(true);
    }
  });

  it("streams text deltas that add up to the finished message", () => {
    const done = events.filter((e) => e.kind === "message.done");
    expect(done.length).toBeGreaterThan(0);
    for (const d of done) {
      const joined = events.filter((e) => e.kind === "message.delta" && e.id === d.id).map((e) => (e as { text: string }).text).join("");
      expect(joined).toBe((d as { text: string }).text);
    }
  });

  it("emits events in a sane order", () => {
    const k = kinds(events);
    expect(k.indexOf("session.started")).toBeLessThan(k.indexOf("tool.started"));
    expect(k.lastIndexOf("turn.done")).toBe(k.length - 1);
  });
});

describe.skipIf(!HAS_EDIT)("ClaudeMapper on the one-shot fixture with errors", () => {
  const events = HAS_EDIT ? replay("fixtures/claude-edit.ndjson") : [];
  it("marks hook-blocked tools as failed with the reason", () => {
    const failed = events.filter((e) => e.kind === "tool.finished" && !e.ok);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.some((f) => f.kind === "tool.finished" && f.result.kind === "text" && /hook error|blocked/i.test(f.result.text))).toBe(true);
  });
  it("reads files into a read result", () => {
    expect(events.some((e) => e.kind === "tool.finished" && e.result.kind === "read")).toBe(true);
  });
});

describe("claudeHistory (rebuilding a saved conversation)", () => {
  const saved = [
    { type: "permission-mode", permissionMode: "default" },
    { type: "user", uuid: "u1", message: { role: "user", content: "Add a sub function" } },
    { type: "user", uuid: "m1", isMeta: true, message: { role: "user", content: "<system-reminder>hidden</system-reminder>" } },
    { type: "assistant", uuid: "a1", message: { id: "msg1", content: [{ type: "thinking", thinking: "Plan the edit" }] } },
    { type: "assistant", uuid: "a2", message: { id: "msg1", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/x/calc.py", old_string: "a", new_string: "b" } }] } },
    { type: "user", uuid: "u2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      toolUseResult: { filePath: "/x/calc.py", structuredPatch: [{ oldStart: 1, newStart: 1, lines: ["-a", "+b"] }] } },
    { type: "assistant", uuid: "a3", message: { id: "msg2", content: [{ type: "text", text: "Done." }] } },
    { type: "user", uuid: "u3", message: { role: "user", content: "<command-name>/compact</command-name>\n<command-args></command-args>" } },
    { type: "assistant", uuid: "s1", isSidechain: true, message: { id: "msg3", content: [{ type: "text", text: "subagent chatter" }] } },
  ].map((l) => JSON.stringify(l)).join("\n");

  it("replays messages, thinking, tools and results in order, skipping hidden entries", async () => {
    const { claudeHistory } = await import("../src/main/adapters/claude-mapper");
    const evs = claudeHistory(saved);
    expect(evs.map((e) => e.kind)).toEqual(["user.message", "thinking.done", "tool.started", "tool.finished", "message.done", "user.message"]);
    expect(evs[3]).toMatchObject({ ok: true, result: { kind: "edit", hunks: [{ lines: ["-a", "+b"] }] } });
    expect(evs[5]).toMatchObject({ text: "/compact" });
  });
});

describe("permission responses", () => {
  it("echoes input on allow and adds rules on always", () => {
    const m = new ClaudeMapper();
    m.feed({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, permission_suggestions: [{ type: "addRules" }], tool_use_id: "t1" } });
    const res = m.permissionResponse("r1", "allow_always");
    expect(res.response.response).toEqual({ behavior: "allow", updatedInput: { command: "ls" }, updatedPermissions: [{ type: "addRules" }] });
    expect(m.permissionResponse("r2", "deny").response.response.behavior).toBe("deny");
  });
});

describe("menu panels", () => {
  it("reports the permission mode at start and when it changes", () => {
    const m = new ClaudeMapper();
    const start = m.feed({ type: "system", subtype: "init", session_id: "s", model: "x", cwd: "/p", apiKeySource: "none", permissionMode: "default" });
    expect(start.find((e) => e.kind === "mode")).toEqual({ kind: "mode", mode: "default" });
    expect(m.feed({ type: "system", subtype: "status", status: null, permissionMode: "plan" })).toEqual([{ kind: "mode", mode: "plan" }]);
    expect(m.feed({ type: "system", subtype: "status", status: "requesting" })).toEqual([]);
  });

  it("reads the mode from initialize and the model from get_status", () => {
    const evs = new ClaudeMapper().feed({ type: "control_response", response: { response: { commands: [], models: [], current_permission_mode: "acceptEdits" } } });
    expect(evs).toContainEqual({ kind: "mode", mode: "acceptEdits" });
    expect(claudeStatusModel({ sections: [{ title: "Environment", rows: [{ label: "Model", value: "claude-opus-5-5" }] }] })).toBe("claude-opus-5-5");
    expect(claudeStatusModel({})).toBeUndefined();
  });

  it("turns get_usage into plan limit windows", () => {
    const evs = claudeUsageLimits({ rate_limits: {
      five_hour: { utilization: 3, resets_at: "2026-11-24T20:09:59.829352+00:00" },
      seven_day: { utilization: 62.4, resets_at: "2026-11-25T18:59:59+00:00" },
      seven_day_opus: null,
    } });
    expect(evs).toEqual([{ kind: "limits", limits: { agent: "claude", windows: [
      { label: "5-hour", usedPct: 3, resetsAt: Math.round(Date.parse("2026-11-24T20:09:59.829Z") / 1000) },
      { label: "Weekly", usedPct: 62, resetsAt: Math.round(Date.parse("2026-11-25T18:59:59Z") / 1000) },
    ] } }]);
    expect(claudeUsageLimits({ rate_limits_available: false })).toEqual([]);
  });

  it("opens /mcp, /status and /context as panels for Claude only", () => {
    const own = [{ name: "mcp", description: "Manage MCP servers", run: "send" as const }, { name: "context", description: "", run: "send" as const }];
    const claude = mergeCommands("claude", own, ["mcp", "context"]);
    for (const name of ["mcp", "status", "context"]) expect(claude.find((c) => c.name === name)?.run).toBe("panel");
    expect(claude.find((c) => c.name === "mcp")?.description).toBe("Manage MCP servers");
    expect(mergeCommands("codex", [], []).find((c) => c.name === "status")?.run).toBe("terminal");
  });
});
