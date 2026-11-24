// Pure translation from Codex app-server JSON-RPC (docs/PROTOCOLS.md) to AgentEvents.

import type { AgentEvent, DiffHunk, PermissionOption, ToolKind } from "@shared/events";

type Json = Record<string, any>;

/** Parses a unified diff body ("@@ -6 +6,5 @@" hunks) into DiffHunks, skipping file headers. */
export function parseUnifiedDiff(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | undefined;
  for (const line of diff.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) { cur = { oldStart: Number(h[1]), newStart: Number(h[2]), lines: [] }; hunks.push(cur); continue; }
    if (!cur || /^(diff --git|index |--- |\+\+\+ )/.test(line)) continue;
    if (line === "") continue;
    if (line[0] === "+" || line[0] === "-" || line[0] === " ") cur.lines.push(line);
  }
  return hunks;
}

/** "/bin/bash -lc \"cmd\"" -> "cmd", preferring Codex's own parsed command when present. */
function displayCommand(item: Json): string {
  const parsed = item.commandActions?.[0]?.command;
  if (typeof parsed === "string" && parsed) return parsed;
  const m = /^\S*sh -l?c "(.*)"$/s.exec(String(item.command ?? ""));
  return m ? m[1]!.replace(/\\"/g, '"') : String(item.command ?? "");
}

const basename = (p: string) => p.split("/").pop() || p;

interface ToolInfo { kind: ToolKind; name: string; title: string; input: Json; diff?: DiffHunk[] }

function describe(item: Json): ToolInfo | undefined {
  switch (item.type) {
    case "commandExecution": {
      const command = displayCommand(item);
      return { kind: "shell", name: "Shell", title: command, input: { command, cwd: item.cwd } };
    }
    case "fileChange": {
      const changes: Json[] = item.changes ?? [];
      const first = changes[0];
      const title = changes.length === 1 ? `Edit ${basename(first!.path)}` : `Edit ${changes.length} files`;
      const diff = changes.flatMap((c) => parseUnifiedDiff(String(c.diff ?? "")));
      return { kind: "edit", name: "Edit", title, input: { file_path: first?.path, changes }, diff };
    }
    case "mcpToolCall": return { kind: "mcp", name: `${item.server} ${item.tool ?? ""}`.trim(), title: `${item.server} › ${item.tool ?? "tool"}`, input: item.arguments ?? {} };
    case "webSearch": return { kind: "web", name: "Web search", title: String(item.query ?? "Web search"), input: { query: item.query } };
    case "dynamicToolCall": return { kind: "other", name: String(item.tool ?? "Tool"), title: String(item.tool ?? "Tool"), input: item.arguments ?? {} };
    case "collabAgentToolCall":
    case "subAgentActivity": return { kind: "subagent", name: "Subagent", title: String(item.description ?? item.prompt ?? "Subagent"), input: {} };
    default: return undefined;
  }
}

const DECISION: Record<PermissionOption["id"], string> = { allow: "accept", allow_always: "acceptForSession", deny: "decline" };

export class CodexMapper {
  private tools = new Map<string, ToolInfo>();
  private reasoning = new Map<string, string>();
  private pending = new Map<string, number | string>(); // permission id -> JSON-RPC request id
  private contextWindow: number | undefined;
  threadId: string | undefined;
  turnId: string | undefined;
  /** JSON-RPC request ids the session should reject; drained by the session after each feed. */
  unsupported: (number | string)[] = [];

  /** Handles a server notification or server->client request. */
  feed(msg: Json): AgentEvent[] {
    if (msg.id !== undefined && msg.method) return this.request(msg);
    const p: Json = msg.params ?? {};
    switch (msg.method) {
      case "thread/started": {
        const t = p.thread ?? {};
        this.threadId = t.id;
        return [{ kind: "session.started", agent: "codex", sessionId: t.id, model: t.model, cwd: t.environments?.[0]?.cwd ?? "" }];
      }
      case "turn/started": this.turnId = p.turn?.id; return [];
      case "item/agentMessage/delta": return [{ kind: "message.delta", id: p.itemId, text: p.delta }];
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        this.reasoning.set(p.itemId, (this.reasoning.get(p.itemId) ?? "") + p.delta);
        return [{ kind: "thinking.delta", id: p.itemId, text: p.delta }];
      }
      case "item/commandExecution/outputDelta": return [{ kind: "tool.output", id: p.itemId, chunk: String(p.delta ?? "") }];
      case "item/started": return this.itemStarted(p.item);
      case "item/completed": return this.itemCompleted(p.item);
      case "turn/plan/updated":
        return [{ kind: "plan.updated", items: (p.plan ?? []).map((s: Json) => ({ text: s.step, status: s.status === "completed" ? "done" : s.status === "inProgress" ? "active" : "pending" })) }];
      case "thread/tokenUsage/updated": {
        const u = p.tokenUsage ?? {};
        this.contextWindow = u.modelContextWindow ?? this.contextWindow;
        return [{ kind: "usage", inputTokens: u.total?.inputTokens ?? 0, outputTokens: u.total?.outputTokens ?? 0, contextWindow: this.contextWindow, contextUsed: u.last?.inputTokens }];
      }
      case "hook/started": return [{ kind: "hook", name: p.run?.eventName ?? "hook", phase: "started" }];
      case "hook/completed": return [{ kind: "hook", name: p.run?.eventName ?? "hook", phase: "finished", ok: p.run?.status === "completed" }];
      case "error": return p.willRetry ? [] : [{ kind: "error", message: p.error?.message ?? "Codex reported an error." }];
      case "turn/completed": {
        const t = p.turn ?? {};
        this.turnId = undefined;
        return [{ kind: "turn.done", ok: t.status === "completed", durationMs: t.durationMs ?? undefined, error: t.status === "completed" ? undefined : t.error?.message ?? t.status }];
      }
      default: return [];
    }
  }

  private itemStarted(item: Json): AgentEvent[] {
    const info = describe(item);
    if (!info) return [];
    this.tools.set(item.id, info);
    return [{ kind: "tool.started", id: item.id, tool: info.kind, name: info.name, title: info.title, input: info.input }];
  }

  private itemCompleted(item: Json): AgentEvent[] {
    switch (item.type) {
      case "agentMessage": return [{ kind: "message.done", id: item.id, text: item.text ?? "" }];
      case "reasoning": {
        const text = [...(item.summary ?? []), ...(item.content ?? [])].join("\n\n") || this.reasoning.get(item.id) || "";
        this.reasoning.delete(item.id);
        return text ? [{ kind: "thinking.done", id: item.id, text }] : [];
      }
      case "commandExecution": {
        const ok = item.status === "completed" && (item.exitCode ?? 0) === 0;
        const out = String(item.aggregatedOutput ?? "").replace(/\n$/, "");
        const result = item.status === "declined"
          ? { kind: "text" as const, text: "You declined this command." }
          : { kind: "shell" as const, stdout: ok ? out : "", stderr: ok ? "" : out || `Exited with code ${item.exitCode}` };
        return [{ kind: "tool.finished", id: item.id, ok, result }];
      }
      case "fileChange": {
        const changes: Json[] = item.changes ?? [];
        const ok = item.status === "completed";
        if (!ok) return [{ kind: "tool.finished", id: item.id, ok, result: { kind: "text", text: item.status === "declined" ? "You declined this change." : `Change ${item.status}` } }];
        return [{ kind: "tool.finished", id: item.id, ok, result: { kind: "edit", filePath: changes[0]?.path ?? "", hunks: changes.flatMap((c) => parseUnifiedDiff(String(c.diff ?? ""))) } }];
      }
      default: {
        if (!this.tools.has(item.id)) return [];
        const ok = !["failed", "declined"].includes(item.status);
        const text = typeof item.result === "string" ? item.result : item.result ? JSON.stringify(item.result, null, 2) : item.error?.message ?? "";
        return [{ kind: "tool.finished", id: item.id, ok, result: { kind: "text", text } }];
      }
    }
  }

  private request(msg: Json): AgentEvent[] {
    const p: Json = msg.params ?? {};
    const permId = `codex-${msg.id}`;
    if (msg.method === "item/commandExecution/requestApproval" || msg.method === "item/fileChange/requestApproval") {
      this.pending.set(permId, msg.id);
      const info = this.tools.get(p.itemId);
      const isCommand = msg.method === "item/commandExecution/requestApproval";
      const decisions: unknown[] = p.availableDecisions ?? ["accept", "acceptForSession", "decline"];
      const options: PermissionOption[] = [{ id: "allow", label: "Allow once" }];
      if (decisions.includes("acceptForSession")) options.push({ id: "allow_always", label: "Allow for this session" });
      options.push({ id: "deny", label: "Deny" });
      const command = isCommand ? displayCommand(p) : undefined;
      return [{
        kind: "permission.request", id: permId, toolId: p.itemId, tool: isCommand ? "shell" : "edit",
        name: "Codex", title: command ?? info?.title ?? "Apply changes",
        reason: p.reason ?? undefined, input: isCommand ? { command } : info?.input ?? {}, options, diff: isCommand ? undefined : info?.diff,
      }];
    }
    // Requests the GUI can't answer yet are refused so the agent never hangs waiting.
    this.unsupported.push(msg.id);
    return [{ kind: "error", message: `Codex asked for "${msg.method}", which this app doesn't support yet, so it was declined.` }];
  }

  /** Builds the JSON-RPC response for an approval. */
  permissionResponse(permId: string, decision: PermissionOption["id"]): Json | undefined {
    const rpcId = this.pending.get(permId);
    if (rpcId === undefined) return undefined;
    this.pending.delete(permId);
    return { id: rpcId, result: { decision: DECISION[decision] } };
  }
}
