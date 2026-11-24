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

const PLAN_NAMES: Record<string, string> = { free: "ChatGPT Free", plus: "ChatGPT Plus", pro: "ChatGPT Pro", team: "ChatGPT Team", business: "ChatGPT Business", enterprise: "ChatGPT Enterprise", edu: "ChatGPT Edu" };

/** Codex reports a primary (5-hour) and secondary (weekly) window as percent used. */
export function codexLimits(r: Json | undefined): AgentEvent[] {
  if (!r) return [];
  const label = (mins: number | undefined) => (mins === 300 ? "5-hour" : mins === 10080 ? "Weekly" : mins ? `${Math.round(mins / 60)}-hour` : "Limit");
  const windows = [r.primary, r.secondary].filter(Boolean).map((w: Json) => ({ label: label(w.windowDurationMins), usedPct: Math.round(w.usedPercent ?? 0), resetsAt: w.resetsAt }));
  const plan = r.planType ? PLAN_NAMES[r.planType] ?? r.planType : undefined;
  return [{ kind: "limits", limits: { agent: "codex", windows, ...(plan ? { plan } : {}) } }];
}

/** authMode "chatgpt" means a ChatGPT subscription; "apikey" means an OpenAI API key. */
export function codexAccount(p: Json): AgentEvent[] {
  const billing = p.authMode === "chatgpt" ? "subscription" as const : p.authMode === "apikey" ? "api_key" as const : p.authMode ? "other" as const : undefined;
  const plan = p.planType ? PLAN_NAMES[p.planType] ?? p.planType : undefined;
  return [{ kind: "limits", limits: { agent: "codex", ...(billing ? { billing } : {}), ...(billing === "api_key" ? { keySource: "OpenAI API key" } : {}), ...(plan ? { plan } : {}) } }];
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
      case "account/rateLimits/updated": return codexLimits(p.rateLimits);
      case "account/updated": return codexAccount(p);
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

  /** Rebuilds a conversation from saved turns (thread/turns/list with itemsView "full"). */
  history(turns: Json[]): AgentEvent[] {
    const out: AgentEvent[] = [];
    for (const turn of turns) {
      for (const item of turn.items ?? []) {
        if (item.type === "userMessage") {
          const text = (item.content ?? []).filter((c: Json) => c.type === "text").map((c: Json) => c.text).join("\n");
          if (text) out.push({ kind: "user.message", id: item.id, text });
          continue;
        }
        out.push(...this.itemStarted(item), ...this.itemCompleted(item));
      }
      if (turn.status === "failed") out.push({ kind: "error", message: turn.error?.message ?? "This turn failed." });
    }
    return out;
  }

  /** Builds the JSON-RPC response for an approval. */
  permissionResponse(permId: string, decision: PermissionOption["id"]): Json | undefined {
    const rpcId = this.pending.get(permId);
    if (rpcId === undefined) return undefined;
    this.pending.delete(permId);
    return { id: rpcId, result: { decision: DECISION[decision] } };
  }
}

/** Codex's access presets (its /approvals menu): what it may do without asking, and where it may write. */
export const CODEX_ACCESS: Record<string, { approvalPolicy: string; sandboxPolicy: Record<string, unknown> }> = {
  "read-only": { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } },
  auto: { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } },
  full: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
};

/** The preset a Codex config amounts to (sandbox_mode decides; Codex's default is "auto"). */
export function codexAccessFromConfig(config: Record<string, any> | undefined): string {
  const mode = config?.sandbox_mode;
  return mode === "read-only" ? "read-only" : mode === "danger-full-access" ? "full" : "auto";
}

const MCP_STATE: Record<string, string> = {
  connected: "connected", starting: "pending", notStarted: "pending", authenticationRequired: "needs-auth", failed: "failed", cancelled: "failed", disabled: "disabled",
};

/** mcpServerStatus/list in the shape the MCP panel draws (shared with Claude's /mcp). */
export function codexMcpPanel(res: Record<string, any> | undefined) {
  const servers = (res?.data ?? []).map((s: Record<string, any>) => ({
    name: String(s.name),
    status: s.authStatus === "notLoggedIn" ? "needs-auth" : MCP_STATE[s.runtimeStatus ?? ""] ?? (s.toolsError ? "failed" : "connected"),
    tools: Object.keys(s.tools ?? {}),
    error: s.toolsError ?? undefined,
    transport: s.httpOrigin ? "http" : "stdio",
    scope: s.pluginId ? `plugin ${s.pluginId}` : "config",
  }));
  return { mcpServers: servers };
}

/** /status for Codex, as titled rows like Claude's get_status. */
export function codexStatusSections(info: { threadId?: string; cwd: string; model?: string; effort?: string; access: string; account?: Record<string, any>; limits?: AgentEvent[]; version?: string }) {
  const acc = info.account?.account ?? info.account ?? {};
  const windows = info.limits?.flatMap((e) => (e.kind === "limits" ? e.limits.windows ?? [] : [])) ?? [];
  const label = { "read-only": "Read only", auto: "Auto", full: "Full access" }[info.access] ?? info.access;
  return {
    sections: [
      { title: "Session", rows: [
        ...(info.threadId ? [{ label: "Thread ID", value: info.threadId }] : []),
        { label: "cwd", value: info.cwd },
        ...(info.model ? [{ label: "Model", value: `${info.model}${info.effort ? ` (${info.effort} effort)` : ""}` }] : []),
        { label: "Access", value: label },
      ] },
      { title: "Account", rows: [
        ...(acc.type ? [{ label: "Signed in with", value: acc.type === "chatgpt" ? "ChatGPT" : acc.type === "apiKey" ? "API key" : String(acc.type) }] : []),
        ...(acc.planType ? [{ label: "Plan", value: String(acc.planType).replace(/^./, (c) => c.toUpperCase()) }] : []),
        ...(acc.email ? [{ label: "Email", value: String(acc.email) }] : []),
      ] },
      ...(windows.length ? [{ title: "Limits", rows: windows.map((w) => ({ label: w.label, value: `${w.usedPct}% used` })) }] : []),
    ].filter((s) => s.rows.length),
  };
}
