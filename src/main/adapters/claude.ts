// Drives a live `claude` process in two-way stream-json mode (docs/PROTOCOLS.md).

import { agentEnv } from "../env";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { AgentEvent, PermissionOption } from "@shared/events";
import { ClaudeMapper, claudeStatusModel, claudeUsageLimits, controlRequest, userMessage } from "./claude-mapper";

export interface AgentSession {
  send(text: string): void;
  /** Runs a command the agent handles itself (Claude and Grok take it as a message; Codex maps it to a method). */
  slash(name: string, args: string): void;
  /** Agents that can change model between turns without a restart implement this. */
  setModel?(model?: string, effort?: string): void;
  /** Asks the agent for data a panel shows, or changes a setting a panel controls (Claude only). */
  query?(subtype: string, payload?: Record<string, unknown>): Promise<unknown>;
  respond(permissionId: string, decision: PermissionOption["id"]): void;
  interrupt(): void;
  close(): void;
}

export const CLAUDE_ARGS = [
  "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--include-partial-messages", "--permission-prompts", "host", "--permission-prompt-tool", "stdio",
];

export class ClaudeSession implements AgentSession {
  private proc: ChildProcessWithoutNullStreams;
  private mapper = new ClaudeMapper();
  private stderr = "";
  private closing = false;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  /** `sessionId` is chosen by the app so the Terminal view can always resume the same conversation. */
  constructor(cwd: string, private emit: (e: AgentEvent) => void, opts: { sessionId: string; resume: boolean; model?: string; effort?: string; permissionMode?: string }, bin = "claude") {
    const idArgs = opts.resume ? ["--resume", opts.sessionId] : ["--session-id", opts.sessionId];
    const modelArgs = [
      ...(opts.model ? ["--model", opts.model] : []), ...(opts.effort ? ["--effort", opts.effort] : []),
      ...(opts.permissionMode && opts.permissionMode !== "default" ? ["--permission-mode", opts.permissionMode] : []),
    ];
    this.proc = spawn(bin, [...CLAUDE_ARGS, ...idArgs, ...modelArgs], { cwd, env: agentEnv(), stdio: ["pipe", "pipe", "pipe"] });
    this.proc.on("error", (err) => this.emit({ kind: "error", message: `Couldn't start Claude Code: ${err.message}. Check that \`claude\` is on your PATH.` }));
    this.proc.stderr.on("data", (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    this.proc.on("exit", (code) => {
      if (this.closing) code = 0; // we asked it to stop; not a failure
      if (code && this.stderr.trim()) this.emit({ kind: "error", message: this.stderr.trim() });
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Claude Code has stopped.")); }
      this.pending.clear();
      this.emit({ kind: "exited", code });
    });

    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line); } catch { return; } // non-JSON noise
      // Replies to panel requests go back to whoever asked, not into the transcript.
      const r = msg.type === "control_response" ? (msg.response as Record<string, any> | undefined) : undefined;
      const waiting = r && this.pending.get(r.request_id);
      if (r && waiting) {
        this.pending.delete(r.request_id);
        clearTimeout(waiting.timer);
        if (r.subtype === "error") waiting.reject(new Error(String(r.error ?? "Claude Code couldn't do that.")));
        else waiting.resolve(r.response ?? {});
        return;
      }
      for (const e of this.mapper.feed(msg)) this.emit(e);
    });

    this.write(controlRequest(`init-${randomUUID()}`, "initialize"));
    // Plan limits straight away, rather than after the first reply. Costs no tokens.
    this.query("get_usage").then((r) => claudeUsageLimits(r as Record<string, any>).forEach(this.emit)).catch(() => {});
    this.query("get_status").then((r) => {
      const model = claudeStatusModel(r as Record<string, any>);
      if (model) this.emit({ kind: "models", models: [], current: model });
    }).catch(() => {});
  }

  query(subtype: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const id = `${subtype}-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      if (!this.proc.stdin.writable) { reject(new Error("Claude Code has stopped.")); return; }
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Claude Code didn't answer in time. Try again.")); }, 20000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.write(controlRequest(id, subtype, payload));
    });
  }

  private write(obj: unknown) {
    if (!this.proc.stdin.writable) return;
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  send(text: string) {
    this.emit({ kind: "user.message", id: randomUUID(), text });
    this.emit({ kind: "turn.started" });
    this.write(userMessage(text));
  }

  slash(name: string, args: string) { this.send(`/${name}${args ? " " + args : ""}`); }

  respond(permissionId: string, decision: PermissionOption["id"]) {
    this.write(this.mapper.permissionResponse(permissionId, decision));
    this.emit({ kind: "permission.resolved", id: permissionId, decision });
  }

  interrupt() {
    this.write(controlRequest(`int-${randomUUID()}`, "interrupt"));
  }

  close() {
    this.closing = true;
    this.proc.stdin.end();
    setTimeout(() => { if (this.proc.exitCode === null) this.proc.kill("SIGTERM"); }, 2000).unref();
  }
}
