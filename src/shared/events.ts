// The normalized event model every agent adapter emits. See PLAN.md §3.

import type { ModelOption, SlashCommand, UsageLimits } from "./commands";

export type AgentId = "claude" | "codex" | "grok";
export type ToolKind = "shell" | "edit" | "read" | "search" | "web" | "subagent" | "todo" | "mcp" | "other";

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: string[]; // each line starts with " ", "-" or "+"
}

export type ToolResult =
  | { kind: "shell"; stdout: string; stderr: string; interrupted?: boolean }
  | { kind: "edit"; filePath: string; hunks: DiffHunk[] }
  | { kind: "read"; filePath: string; content: string; startLine: number; numLines: number; totalLines: number }
  | { kind: "text"; text: string };

export interface PermissionOption {
  id: "allow" | "allow_always" | "deny";
  label: string;
}

export type AgentEvent =
  | { kind: "session.started"; agent: AgentId; sessionId: string; model: string; cwd: string }
  | { kind: "user.message"; id: string; text: string }
  | { kind: "message.delta"; id: string; text: string; parentToolId?: string }
  | { kind: "message.done"; id: string; text: string; parentToolId?: string }
  | { kind: "thinking.delta"; id: string; text: string; parentToolId?: string }
  | { kind: "thinking.done"; id: string; text: string; parentToolId?: string }
  | { kind: "tool.started"; id: string; tool: ToolKind; name: string; title: string; input: Record<string, unknown>; parentToolId?: string }
  | { kind: "tool.output"; id: string; chunk: string }
  | { kind: "tool.finished"; id: string; ok: boolean; result: ToolResult }
  | { kind: "permission.request"; id: string; toolId?: string; tool: ToolKind; name: string; title: string; reason?: string; input: Record<string, unknown>; options: PermissionOption[]; diff?: DiffHunk[] }
  | { kind: "permission.resolved"; id: string; decision: PermissionOption["id"] }
  | { kind: "plan.updated"; items: { text: string; status: "pending" | "active" | "done" }[] }
  | { kind: "hook"; name: string; phase: "started" | "finished"; ok?: boolean }
  | { kind: "usage"; costUsd?: number; inputTokens: number; outputTokens: number; contextWindow?: number; contextUsed?: number }
  | { kind: "turn.started" }
  | { kind: "turn.done"; ok: boolean; durationMs?: number; error?: string }
  | { kind: "error"; message: string }
  | { kind: "commands"; commands: SlashCommand[] }
  /** Partial: fields present replace the cached ones; windows replace by label. */
  | { kind: "limits"; limits: Partial<UsageLimits> & { agent: UsageLimits["agent"] } }
  | { kind: "models"; models: ModelOption[]; current?: string; effort?: string }
  | { kind: "view"; view: "gui" | "terminal" }
  /** The full saved conversation; replaces the Chat transcript so it matches the agent exactly. */
  | { kind: "history"; events: AgentEvent[] }
  | { kind: "notice"; text: string }
  /** Claude's permission mode (default, acceptEdits, plan, ...), when it starts or changes. */
  | { kind: "mode"; mode: string }
  | { kind: "exited"; code: number | null };

/** Commands the UI sends to an agent session. */
export type SessionCommand =
  | { kind: "send"; text: string }
  | { kind: "permission"; id: string; decision: PermissionOption["id"] }
  | { kind: "interrupt" }
  | { kind: "slash"; name: string; args: string }
  | { kind: "setModel"; model?: string; effort?: string };

export interface SessionInfo {
  id: string; // GUI-side id
  agent: AgentId;
  cwd: string;
  title: string;
}
