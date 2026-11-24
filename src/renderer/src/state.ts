// Turns the AgentEvent stream into transcript items and session status.

import type { AgentEvent, DiffHunk, PermissionOption, SessionInfo, ToolKind, ToolResult } from "@shared/events";

export type MascotState = "idle" | "thinking" | "working" | "waiting" | "done" | "error";

export type Item =
  | { type: "user"; id: string; text: string }
  | { type: "assistant"; id: string; text: string; streaming: boolean }
  | { type: "thinking"; id: string; text: string; streaming: boolean }
  | { type: "tool"; id: string; tool: ToolKind; name: string; title: string; input: Record<string, unknown>; result?: ToolResult; ok?: boolean; children: Item[]; approval?: PermissionOption["id"]; live?: string }
  | { type: "permission"; id: string; toolId?: string; tool: ToolKind; name: string; title: string; reason?: string; input: Record<string, unknown>; options: PermissionOption[]; decision?: PermissionOption["id"]; diff?: DiffHunk[] }
  | { type: "turn"; id: string; ok: boolean; durationMs?: number; error?: string }
  | { type: "error"; id: string; message: string }
  | { type: "notice"; id: string; text: string };

export interface Session {
  info: SessionInfo;
  model?: string;
  items: Item[];
  status: MascotState;
  running: boolean;
  plan: { text: string; status: "pending" | "active" | "done" }[];
  usage?: Extract<AgentEvent, { kind: "usage" }>;
  hooks: number;
  exited: boolean;
  view: "gui" | "terminal";
}

export const newSession = (info: SessionInfo): Session => ({ info, items: [], status: "idle", running: false, plan: [], hooks: 0, exited: false, view: "gui" });

/** Finds the list an item belongs in: top level, or inside its parent subagent card. */
function container(items: Item[], parentToolId?: string): Item[] {
  if (!parentToolId) return items;
  const stack = [...items];
  while (stack.length) {
    const it = stack.pop()!;
    if (it.type === "tool") {
      if (it.id === parentToolId) return it.children;
      stack.push(...it.children);
    }
  }
  return items;
}

function find(items: Item[], id: string): Item | undefined {
  for (const it of items) {
    if (it.id === id) return it;
    if (it.type === "tool") { const hit = find(it.children, id); if (hit) return hit; }
  }
  return undefined;
}

let turnSeq = 0;

/** Mutates the session's item list in place and returns a new top-level object so React re-renders. */
export function apply(s: Session, e: AgentEvent): Session {
  const items = s.items;
  switch (e.kind) {
    case "session.started": return { ...s, model: e.model };
    case "user.message": items.push({ type: "user", id: e.id, text: e.text }); return { ...s, items };
    case "turn.started": return { ...s, running: true, status: "thinking" };
    case "thinking.delta":
    case "message.delta": {
      const type = e.kind === "thinking.delta" ? "thinking" : "assistant";
      const existing = find(items, e.id);
      if (existing && (existing.type === "assistant" || existing.type === "thinking")) existing.text += e.text;
      else container(items, e.parentToolId).push({ type, id: e.id, text: e.text, streaming: true });
      return { ...s, items, status: s.status === "waiting" ? s.status : type === "thinking" ? "thinking" : "working" };
    }
    case "thinking.done":
    case "message.done": {
      const existing = find(items, e.id);
      if (existing && (existing.type === "assistant" || existing.type === "thinking")) { existing.text = e.text; existing.streaming = false; }
      else if (e.text) container(items, e.parentToolId).push({ type: e.kind === "thinking.done" ? "thinking" : "assistant", id: e.id, text: e.text, streaming: false });
      return { ...s, items };
    }
    case "tool.started": {
      if (!find(items, e.id)) container(items, e.parentToolId).push({ type: "tool", id: e.id, tool: e.tool, name: e.name, title: e.title, input: e.input, children: [] });
      return { ...s, items, status: s.status === "waiting" ? s.status : "working" };
    }
    case "tool.output": {
      const t = find(items, e.id);
      if (t?.type === "tool") t.live = ((t.live ?? "") + e.chunk).slice(-20000);
      return { ...s, items };
    }
    case "tool.finished": {
      const t = find(items, e.id);
      if (t?.type === "tool") { t.result = e.result; t.ok = e.ok; }
      return { ...s, items };
    }
    case "permission.request":
      items.push({ type: "permission", id: e.id, toolId: e.toolId, tool: e.tool, name: e.name, title: e.title, reason: e.reason, input: e.input, options: e.options, diff: e.diff });
      return { ...s, items, status: "waiting" };
    case "permission.resolved": {
      const p = find(items, e.id);
      if (p?.type === "permission") {
        p.decision = e.decision;
        // Once answered, the decision becomes a badge on its tool card instead of a separate line.
        const tool = p.toolId ? find(items, p.toolId) : undefined;
        if (tool?.type === "tool") {
          tool.approval = e.decision;
          const at = items.indexOf(p);
          if (at >= 0) items.splice(at, 1);
        }
      }
      const stillWaiting = items.some((it) => it.type === "permission" && !it.decision);
      return { ...s, items, status: stillWaiting ? "waiting" : "working" };
    }
    case "plan.updated": return { ...s, plan: e.items };
    case "hook": return e.phase === "started" ? { ...s, hooks: s.hooks + 1 } : s;
    case "usage": return { ...s, usage: e };
    case "turn.done":
      items.push({ type: "turn", id: `turn-${++turnSeq}`, ok: e.ok, durationMs: e.durationMs, error: e.error });
      return { ...s, items, running: false, status: e.ok ? "done" : "error" };
    case "error":
      items.push({ type: "error", id: `err-${++turnSeq}`, message: e.message });
      return { ...s, items, status: "error" };
    case "exited":
      return { ...s, exited: true, running: false, status: e.code ? "error" : s.status };
    case "view":
      // A fresh process takes over in either direction, so the old one's end state is cleared.
      return { ...s, view: e.view, exited: false, running: false, status: "idle" };
    case "notice":
      items.push({ type: "notice", id: `notice-${++turnSeq}`, text: e.text });
      return { ...s, items };
  }
}
