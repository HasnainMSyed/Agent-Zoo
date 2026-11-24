// Drives a live `claude` process in two-way stream-json mode (docs/PROTOCOLS.md).

import { agentEnv } from "../env";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { AgentEvent, PermissionOption } from "@shared/events";
import { ClaudeMapper, controlRequest, userMessage } from "./claude-mapper";

export interface AgentSession {
  send(text: string): void;
  /** Runs a command the agent handles itself (Claude and Grok take it as a message; Codex maps it to a method). */
  slash(name: string, args: string): void;
  /** Agents that can change model between turns without a restart implement this. */
  setModel?(model?: string, effort?: string): void;
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

  /** `sessionId` is chosen by the app so the Terminal view can always resume the same conversation. */
  constructor(cwd: string, private emit: (e: AgentEvent) => void, opts: { sessionId: string; resume: boolean; model?: string; effort?: string }, bin = "claude") {
    const idArgs = opts.resume ? ["--resume", opts.sessionId] : ["--session-id", opts.sessionId];
    const modelArgs = [...(opts.model ? ["--model", opts.model] : []), ...(opts.effort ? ["--effort", opts.effort] : [])];
    this.proc = spawn(bin, [...CLAUDE_ARGS, ...idArgs, ...modelArgs], { cwd, env: agentEnv(), stdio: ["pipe", "pipe", "pipe"] });
    this.proc.on("error", (err) => this.emit({ kind: "error", message: `Couldn't start Claude Code: ${err.message}. Check that \`claude\` is on your PATH.` }));
    this.proc.stderr.on("data", (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    this.proc.on("exit", (code) => {
      if (this.closing) code = 0; // we asked it to stop; not a failure
      if (code && this.stderr.trim()) this.emit({ kind: "error", message: this.stderr.trim() });
      this.emit({ kind: "exited", code });
    });

    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line); } catch { return; } // non-JSON noise
      for (const e of this.mapper.feed(msg)) this.emit(e);
    });

    this.write(controlRequest(`init-${randomUUID()}`, "initialize"));
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
