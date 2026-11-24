// Pure translation from Grok's ACP stream (`grok agent stdio`, docs/PROTOCOLS.md) to AgentEvents.

import type { AgentEvent, DiffHunk, PermissionOption, ToolKind, ToolResult } from "@shared/events";

type Json = Record<string, any>;

/** xAI reports cost in ticks of 1e-10 USD (checked against `grok usage`). */
export const TICKS_PER_USD = 1e10;

const basename = (p: unknown) => (typeof p === "string" ? p.split("/").pop() || p : "");

function toolKind(kind: string | undefined, name: string | undefined): ToolKind {
  switch (kind) {
    case "execute": return "shell";
    case "edit": case "delete": case "move": return "edit";
    case "read": return "read";
    case "search": return "search";
    case "fetch": return "web";
  }
  if (name?.includes("agent")) return "subagent";
  if (name?.includes("todo") || name?.includes("plan")) return "todo";
  return "other";
}

function title(kind: ToolKind, name: string, input: Json): string {
  switch (kind) {
    case "shell": return String(input.description || input.command || name);
    case "edit": return `Edit ${basename(input.file_path ?? input.path ?? input.target_file)}`;
    case "read": return `Read ${basename(input.file_path ?? input.path ?? input.target_file)}`;
    case "search": return `Search ${input.pattern ?? input.query ?? ""}`.trim();
    case "web": return String(input.url ?? input.query ?? name);
    default: return name.replace(/_/g, " ");
  }
}

/** Diff of a search/replace edit: shared leading and trailing lines become context. */
export function textDiff(oldText: string, newText: string, start = 1): DiffHunk {
  const a = oldText.split("\n"), b = newText.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let post = 0;
  while (post < a.length - pre && post < b.length - pre && a[a.length - 1 - post] === b[b.length - 1 - post]) post++;
  const lines = [
    ...a.slice(0, pre).map((l) => " " + l),
    ...a.slice(pre, a.length - post).map((l) => "-" + l),
    ...b.slice(pre, b.length - post).map((l) => "+" + l),
    ...a.slice(a.length - post).map((l) => " " + l),
  ];
  return { oldStart: start, newStart: start, lines };
}

const textContent = (content: unknown): string =>
  Array.isArray(content) ? content.filter((c) => c?.type === "content" && c.content?.type === "text").map((c) => c.content.text).join("") : "";

const diffContent = (content: unknown): DiffHunk[] =>
  Array.isArray(content) ? content.filter((c) => c?.type === "diff").map((c) => textDiff(c.oldText ?? "", c.newText ?? "", c._meta?.old_line ?? 1)) : [];

interface Tool { kind: ToolKind; name: string; input: Json; diff?: DiffHunk[]; path?: string; shown: number }

export class GrokMapper {
  private tools = new Map<string, Tool>();
  private segment: { id: string; type: "text" | "thinking"; text: string } | undefined;
  private seq = 0;
  private pending = new Map<string, { rpcId: number | string; options: Map<PermissionOption["id"], string> }>();
  private contextWindow: number | undefined;
  private contextUsed: number | undefined;
  private started = false;
  private turnOpen = false;
  private totals = { input: 0, output: 0, ticks: 0 };
  model: string | undefined;
  sessionId: string | undefined;
  /** Slash commands Grok advertises; used by the slash command menu. */
  commands: { name: string; description: string; hint?: string }[] = [];
  /** JSON-RPC request ids the session should reject; drained by the session after each feed. */
  unsupported: (number | string)[] = [];

  constructor(public cwd: string) {}

  /** Call with the id from session/new; emits session.started once the model is known too. */
  ready(sessionId: string): AgentEvent[] {
    this.sessionId = sessionId;
    return this.start(undefined);
  }

  /** Call when a prompt is sent, so the turn-end bookkeeping is armed. */
  beginTurn() { this.turnOpen = true; }

  feed(msg: Json): AgentEvent[] {
    if (msg.id !== undefined && msg.method) return this.request(msg);
    const p: Json = msg.params ?? {};
    const u: Json = p.update ?? {};
    if (p.sessionId) this.sessionId = p.sessionId;
    switch (msg.method) {
      case "_x.ai/models/update": {
        const current = (p.availableModels ?? []).find((m: Json) => m.modelId === p.currentModelId);
        this.contextWindow = current?._meta?.totalContextTokens ?? this.contextWindow;
        return this.start(p.currentModelId);
      }
      case "session/update": return this.update(u);
      case "_x.ai/session_notification": return this.notification(u);
      case "_x.ai/session/prompt_complete": return this.endTurn(p.stopReason);
      default: return [];
    }
  }

  private start(model: string | undefined): AgentEvent[] {
    if (model) this.model = model;
    if (this.started || !this.sessionId || !this.model) return [];
    this.started = true;
    return [{ kind: "session.started", agent: "grok", sessionId: this.sessionId, model: this.model, cwd: this.cwd }];
  }

  /** Ends the current text or thinking run so the next chunk starts a new block. */
  private flush(): AgentEvent[] {
    const s = this.segment;
    this.segment = undefined;
    if (!s) return [];
    return [{ kind: s.type === "text" ? "message.done" : "thinking.done", id: s.id, text: s.text }];
  }

  private chunk(type: "text" | "thinking", text: string): AgentEvent[] {
    const out: AgentEvent[] = [];
    if (this.segment && this.segment.type !== type) out.push(...this.flush());
    if (!this.segment) this.segment = { id: `grok-${type}-${++this.seq}`, type, text: "" };
    this.segment.text += text;
    out.push({ kind: type === "text" ? "message.delta" : "thinking.delta", id: this.segment.id, text });
    return out;
  }

  private update(u: Json): AgentEvent[] {
    switch (u.sessionUpdate) {
      case "agent_message_chunk": return u.content?.type === "text" ? this.chunk("text", u.content.text) : [];
      case "agent_thought_chunk": return u.content?.type === "text" ? this.chunk("thinking", u.content.text) : [];
      case "tool_call": {
        const meta = u._meta?.["x.ai/tool"] ?? {};
        const name = String(meta.name ?? u.title ?? "tool");
        const kind = toolKind(u.kind ?? meta.kind, name);
        const input: Json = u.rawInput ?? {};
        this.tools.set(u.toolCallId, { kind, name, input, shown: 0, path: u.locations?.[0]?.path });
        return [...this.flush(), { kind: "tool.started", id: u.toolCallId, tool: kind, name: meta.label ?? name, title: title(kind, name, input), input }];
      }
      case "tool_call_update": return this.toolUpdate(u);
      case "plan":
        return [{ kind: "plan.updated", items: (u.entries ?? []).map((e: Json) => ({ text: String(e.content ?? ""), status: e.status === "completed" ? "done" : e.status === "in_progress" ? "active" : "pending" })) }];
      case "available_commands_update":
        this.commands = (u.availableCommands ?? []).map((c: Json) => ({ name: c.name, description: c.description ?? "", hint: c.input?.hint }));
        return [];
      default: return [];
    }
  }

  private toolUpdate(u: Json): AgentEvent[] {
    const tool = this.tools.get(u.toolCallId);
    if (!tool) return [];
    if (u.rawInput && !Object.keys(tool.input).length) tool.input = u.rawInput;
    if (u.locations?.[0]?.path) tool.path = u.locations[0].path;
    const diff = diffContent(u.content);
    if (diff.length) tool.diff = diff;

    if (u.status === "in_progress" && tool.kind === "shell") {
      const text = textContent(u.content);
      if (text.length > tool.shown) {
        const chunk = text.slice(tool.shown);
        tool.shown = text.length;
        return [{ kind: "tool.output", id: u.toolCallId, chunk }];
      }
      return [];
    }
    if (u.status !== "completed" && u.status !== "failed") return [];

    const raw: Json = u.rawOutput ?? {};
    const text = textContent(u.content);
    let ok = u.status === "completed";
    let result: ToolResult;
    if (raw.type === "Bash" || tool.kind === "shell") {
      if (typeof raw.exit_code === "number" && raw.exit_code !== 0) ok = false;
      result = { kind: "shell", stdout: ok ? text.replace(/\n$/, "") : "", stderr: ok ? "" : text || `Exited with code ${raw.exit_code}` };
    } else if (tool.diff?.length && ok) {
      result = { kind: "edit", filePath: String(tool.path ?? tool.input.file_path ?? ""), hunks: tool.diff };
    } else if (tool.kind === "read" && ok) {
      const content = text.split("\n").map((l) => l.replace(/^\s*\d+→/, "")).join("\n").replace(/\n$/, "");
      const numLines = content ? content.split("\n").length : 0;
      result = { kind: "read", filePath: String(tool.path ?? tool.input.file_path ?? tool.input.path ?? ""), content, startLine: 1, numLines, totalLines: numLines };
    } else {
      result = { kind: "text", text: text || (ok ? "Done" : "Failed") };
    }
    return [{ kind: "tool.finished", id: u.toolCallId, ok, result }];
  }

  private notification(u: Json): AgentEvent[] {
    switch (u.sessionUpdate) {
      case "model_changed": return this.start(u.model_id);
      case "hook_run_started": return [{ kind: "hook", name: u.event_name ?? "hook", phase: "started" }];
      case "hook_execution": {
        const runs: Json[] = u.runs ?? [];
        return [{ kind: "hook", name: u.event_name ?? "hook", phase: "finished", ok: runs.every((r) => r.status?.status === "success") }];
      }
      case "response_completed": {
        const x = u.usage ?? {};
        this.contextUsed = (x.input_tokens ?? 0) + (x.cache_read_input_tokens ?? 0);
        return [];
      }
      case "turn_completed": {
        // Grok reports usage per turn; the UI shows session totals, as Claude and Codex do.
        const x = u.usage ?? {};
        this.totals.input += x.inputTokens ?? 0;
        this.totals.output += x.outputTokens ?? 0;
        if (typeof x.costUsdTicks === "number") this.totals.ticks += x.costUsdTicks;
        return [{
          kind: "usage", inputTokens: this.totals.input, outputTokens: this.totals.output,
          costUsd: this.totals.ticks ? this.totals.ticks / TICKS_PER_USD : undefined,
          contextWindow: this.contextWindow, contextUsed: this.contextUsed,
        }];
      }
      default: return [];
    }
  }

  /** Closes the turn once; safe to call from both prompt_complete and the prompt's RPC response. */
  endTurn(stopReason: string | undefined): AgentEvent[] {
    if (!this.turnOpen) return [];
    this.turnOpen = false;
    const ok = stopReason === "end_turn" || stopReason === "max_tokens";
    const error = ok ? undefined : stopReason === "cancelled" ? "Stopped" : stopReason ?? "Grok stopped";
    return [...this.flush(), { kind: "turn.done", ok, error }];
  }

  private request(msg: Json): AgentEvent[] {
    const p: Json = msg.params ?? {};
    if (msg.method !== "session/request_permission") {
      this.unsupported.push(msg.id);
      return [{ kind: "error", message: `Grok asked for "${msg.method}", which this app doesn't support yet, so it was declined.` }];
    }
    const tc: Json = p.toolCall ?? {};
    const tool = this.tools.get(tc.toolCallId);
    const kind = tool?.kind ?? toolKind(tc.kind, undefined);
    const input: Json = tc.rawInput ?? tool?.input ?? {};
    const diff = diffContent(tc.content);
    const map = new Map<PermissionOption["id"], string>();
    const options: PermissionOption[] = [];
    for (const o of p.options ?? []) {
      if (o.kind === "allow_once" && !map.has("allow")) { map.set("allow", o.optionId); options.unshift({ id: "allow", label: "Allow once" }); }
      if (o.kind === "allow_always" && !map.has("allow_always")) {
        map.set("allow_always", o.optionId);
        options.push({ id: "allow_always", label: /session/i.test(o.name ?? "") ? "Allow for this session" : "Always allow" });
      }
      if (o.kind === "reject_once" && !map.has("deny")) map.set("deny", o.optionId);
    }
    if (map.has("deny")) options.push({ id: "deny", label: "Deny" });
    const permId = `grok-${msg.id}`;
    this.pending.set(permId, { rpcId: msg.id, options: map });
    return [...this.flush(), {
      kind: "permission.request", id: permId, toolId: tc.toolCallId, tool: kind, name: "Grok",
      title: kind === "shell" ? String(input.command ?? tc.title ?? "") : tool ? title(kind, tool.name, input) : String(tc.title ?? "Tool"),
      input, options, diff: diff.length ? diff : tool?.diff,
    }];
  }

  permissionResponse(permId: string, decision: PermissionOption["id"]): Json | undefined {
    const pending = this.pending.get(permId);
    if (!pending) return undefined;
    this.pending.delete(permId);
    const optionId = pending.options.get(decision);
    const outcome = optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" };
    return { jsonrpc: "2.0", id: pending.rpcId, result: { outcome } };
  }
}
