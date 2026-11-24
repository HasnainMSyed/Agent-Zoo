// Pure translation from Claude Code stream-json (docs/PROTOCOLS.md) to AgentEvents.
// Kept free of process I/O so it can be tested by replaying fixtures.

import type { AgentEvent, DiffHunk, PermissionOption, ToolKind, ToolResult } from "@shared/events";
import { mergeCommands, type ModelOption, type SlashCommand } from "@shared/commands";

type Json = Record<string, any>;

export function toolKind(name: string): ToolKind {
  if (name === "Bash" || name === "BashOutput" || name === "PowerShell") return "shell";
  if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(name)) return "edit";
  if (name === "Read") return "read";
  if (["Grep", "Glob", "LS"].includes(name)) return "search";
  if (name === "WebFetch" || name === "WebSearch") return "web";
  if (name === "Task" || name === "Agent") return "subagent";
  if (name === "TodoWrite") return "todo";
  if (name.startsWith("mcp__")) return "mcp";
  return "other";
}

const basename = (p: unknown) => (typeof p === "string" ? p.split("/").pop() || p : "");

export function toolTitle(name: string, input: Json): string {
  switch (toolKind(name)) {
    case "shell": return String(input.description || input.command || name);
    case "edit": return `${name === "Write" ? "Write" : "Edit"} ${basename(input.file_path ?? input.notebook_path)}`;
    case "read": return `Read ${basename(input.file_path)}`;
    case "search": return `${name} ${input.pattern ?? input.path ?? ""}`.trim();
    case "web": return String(input.url ?? input.query ?? name);
    case "subagent": return String(input.description ?? "Subagent");
    case "todo": return "Update plan";
    case "mcp": return name.replace(/^mcp__/, "").replace(/__/g, " › ");
    default: return name;
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c?.type === "text" ? c.text : "")).join("");
  return "";
}

function toResult(name: string, structured: unknown, content: unknown): ToolResult {
  const s = structured as Json | undefined;
  if (s && typeof s === "object") {
    if (typeof s.stdout === "string") return { kind: "shell", stdout: s.stdout, stderr: s.stderr ?? "", interrupted: s.interrupted };
    if (Array.isArray(s.structuredPatch)) {
      return { kind: "edit", filePath: s.filePath, hunks: s.structuredPatch.map((h: Json): DiffHunk => ({ oldStart: h.oldStart, newStart: h.newStart, lines: h.lines })) };
    }
    if (s.type === "create" && typeof s.content === "string") {
      const lines = s.content.replace(/\n$/, "").split("\n").map((l: string) => "+" + l);
      return { kind: "edit", filePath: s.filePath, hunks: [{ oldStart: 0, newStart: 1, lines }] };
    }
    if (s.file && typeof s.file.content === "string") {
      const f = s.file;
      return { kind: "read", filePath: f.filePath, content: f.content, startLine: f.startLine ?? 1, numLines: f.numLines ?? 0, totalLines: f.totalLines ?? 0 };
    }
  }
  return { kind: "text", text: typeof structured === "string" ? structured : textOf(content) || `${name} finished` };
}

function todoItems(input: Json) {
  const todos = Array.isArray(input.todos) ? input.todos : [];
  return todos.map((t: Json) => ({
    text: String(t.content ?? t.activeForm ?? ""),
    status: t.status === "completed" ? "done" as const : t.status === "in_progress" ? "active" as const : "pending" as const,
  }));
}

interface PendingPermission { input: Json; suggestions: unknown[] }

export class ClaudeMapper {
  private blocks = new Map<string, { type: "text" | "thinking"; text: string; parent?: string }>();
  private currentMessage = new Map<string, string>(); // parent tool id ("" = main) -> message id
  private toolNames = new Map<string, string>();
  private permissions = new Map<string, PendingPermission>();
  private contextUsed = 0;
  private contextWindow: number | undefined;

  private ownCommands: SlashCommand[] = [];
  private terminalCommands: string[] = [];

  /** Commands as the "/" menu shows them; re-sent when Claude reports which are terminal-only. */
  private commandsEvent(): AgentEvent {
    return { kind: "commands", commands: mergeCommands("claude", this.ownCommands, this.terminalCommands) };
  }

  feed(msg: Json): AgentEvent[] {
    const parent: string | undefined = msg.parent_tool_use_id ?? undefined;
    switch (msg.type) {
      case "control_response": return this.initialized(msg.response?.response);
      case "system": return [...(msg.subtype === "init" && Array.isArray(msg.terminal_slash_commands) ? this.initTerminal(msg.terminal_slash_commands) : []), ...this.system(msg)];
      case "stream_event": return this.stream(msg.event, parent);
      case "assistant": return this.assistant(msg, parent);
      case "user": return this.user(msg);
      case "control_request": return this.controlRequest(msg);
      case "result": return this.result(msg);
      default: return [];
    }
  }

  /** The reply to our initialize request lists every command and model the session offers. */
  private initialized(r: Json | undefined): AgentEvent[] {
    if (!r || !Array.isArray(r.commands)) return [];
    this.ownCommands = r.commands.map((c: Json): SlashCommand => ({
      name: c.name, description: c.description ?? "", hint: c.argumentHint || undefined,
      run: c.name === "model" ? "model" : c.name === "effort" ? "effort" : "send",
    }));
    const models: ModelOption[] = (r.models ?? []).map((m: Json) => ({
      id: m.value, label: m.displayName ?? m.value, description: m.description, efforts: m.supportsEffort ? m.supportedEffortLevels : undefined,
    }));
    return [this.commandsEvent(), { kind: "models", models }];
  }

  private initTerminal(names: string[]): AgentEvent[] {
    this.terminalCommands = names;
    return this.ownCommands.length ? [this.commandsEvent()] : [];
  }

  private system(msg: Json): AgentEvent[] {
    if (msg.subtype === "init") {
      return [{ kind: "session.started", agent: "claude", sessionId: msg.session_id, model: msg.model, cwd: msg.cwd }];
    }
    if (msg.subtype === "hook_started") return [{ kind: "hook", name: msg.hook_name ?? msg.hook_event, phase: "started" }];
    if (msg.subtype === "hook_response") {
      return [{ kind: "hook", name: msg.hook_name ?? msg.hook_event, phase: "finished", ok: msg.outcome ? msg.outcome === "success" : msg.exit_code ? msg.exit_code === 0 : undefined }];
    }
    return [];
  }

  private stream(ev: Json, parent?: string): AgentEvent[] {
    const scope = parent ?? "";
    switch (ev.type) {
      case "message_start": {
        this.currentMessage.set(scope, ev.message.id);
        const u = ev.message.usage;
        if (u && !parent) this.contextUsed = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        return [];
      }
      case "content_block_start": {
        const type = ev.content_block?.type;
        if (type !== "text" && type !== "thinking") return [];
        this.blocks.set(this.blockId(scope, ev.index), { type, text: "", parent });
        return [];
      }
      case "content_block_delta": {
        const id = this.blockId(scope, ev.index);
        const block = this.blocks.get(id);
        const d = ev.delta;
        if (!block) return [];
        const chunk = d.type === "text_delta" ? d.text : d.type === "thinking_delta" ? d.thinking : "";
        if (!chunk) return [];
        block.text += chunk;
        return [{ kind: block.type === "text" ? "message.delta" : "thinking.delta", id, text: chunk, parentToolId: parent }];
      }
      case "content_block_stop": {
        const id = this.blockId(scope, ev.index);
        const block = this.blocks.get(id);
        if (!block) return [];
        this.blocks.delete(id);
        return [{ kind: block.type === "text" ? "message.done" : "thinking.done", id, text: block.text, parentToolId: parent }];
      }
      default: return [];
    }
  }

  private blockId(scope: string, index: number) {
    return `${this.currentMessage.get(scope) ?? "msg"}:${index}`;
  }

  private assistant(msg: Json, parent?: string): AgentEvent[] {
    const out: AgentEvent[] = [];
    for (const b of msg.message?.content ?? []) {
      if (b.type !== "tool_use") continue;
      this.toolNames.set(b.id, b.name);
      out.push({ kind: "tool.started", id: b.id, tool: toolKind(b.name), name: b.name, title: toolTitle(b.name, b.input ?? {}), input: b.input ?? {}, parentToolId: parent });
      if (b.name === "TodoWrite") out.push({ kind: "plan.updated", items: todoItems(b.input ?? {}) });
    }
    return out;
  }

  private user(msg: Json): AgentEvent[] {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return [];
    return content
      .filter((b: Json) => b.type === "tool_result")
      .map((b: Json): AgentEvent => {
        const name = this.toolNames.get(b.tool_use_id) ?? "tool";
        const ok = !b.is_error;
        const result = ok ? toResult(name, msg.tool_use_result, b.content) : { kind: "text" as const, text: textOf(b.content) || String(msg.tool_use_result ?? "Failed") };
        return { kind: "tool.finished", id: b.tool_use_id, ok, result };
      });
  }

  private controlRequest(msg: Json): AgentEvent[] {
    const req = msg.request ?? {};
    if (req.subtype !== "can_use_tool") return [];
    const input = req.input ?? {};
    const suggestions = Array.isArray(req.permission_suggestions) ? req.permission_suggestions : [];
    this.permissions.set(msg.request_id, { input, suggestions });
    const options: PermissionOption[] = [{ id: "allow", label: "Allow once" }];
    if (suggestions.length) options.push({ id: "allow_always", label: "Always allow" });
    options.push({ id: "deny", label: "Deny" });
    return [{
      kind: "permission.request", id: msg.request_id, toolId: req.tool_use_id, tool: toolKind(req.tool_name),
      name: req.tool_name, title: toolTitle(req.tool_name, input), reason: req.decision_reason, input, options,
    }];
  }

  /** Build the stdin message that answers a permission request. */
  permissionResponse(requestId: string, decision: PermissionOption["id"]): Json {
    const pending = this.permissions.get(requestId);
    this.permissions.delete(requestId);
    const response = decision === "deny"
      ? { behavior: "deny", message: "The user denied this action." }
      : { behavior: "allow", updatedInput: pending?.input ?? {}, ...(decision === "allow_always" ? { updatedPermissions: pending?.suggestions ?? [] } : {}) };
    return { type: "control_response", response: { subtype: "success", request_id: requestId, response } };
  }

  private result(msg: Json): AgentEvent[] {
    const model = msg.modelUsage ? (Object.values(msg.modelUsage)[0] as Json | undefined) : undefined;
    if (model?.contextWindow) this.contextWindow = model.contextWindow;
    const u = msg.usage ?? {};
    return [
      {
        kind: "usage", costUsd: msg.total_cost_usd,
        inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0, contextWindow: this.contextWindow, contextUsed: this.contextUsed || undefined,
      },
      { kind: "turn.done", ok: msg.subtype === "success" && !msg.is_error, durationMs: msg.duration_ms, error: msg.is_error ? String(msg.result ?? msg.subtype) : undefined },
    ];
  }
}

export const userMessage = (text: string) => ({ type: "user", message: { role: "user", content: text } });
export const controlRequest = (requestId: string, subtype: "initialize" | "interrupt") => ({ type: "control_request", request_id: requestId, request: { subtype } });
