// Drives a live `grok agent stdio` session over ACP (JSON-RPC 2.0 on stdio, docs/PROTOCOLS.md).

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { AgentEvent, PermissionOption } from "@shared/events";
import type { AgentSession } from "./claude";
import { GrokMapper } from "./grok-mapper";

type Json = Record<string, any>;

export class GrokSession implements AgentSession {
  private proc: ChildProcessWithoutNullStreams;
  private mapper: GrokMapper;
  private nextId = 1;
  private calls = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private ready: Promise<string>;
  private stderr = "";
  private closing = false;

  constructor(private cwd: string, private emit: (e: AgentEvent) => void, bin = "grok") {
    this.mapper = new GrokMapper(cwd);
    this.proc = spawn(bin, ["agent", "stdio"], { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.on("error", (err) => this.emit({ kind: "error", message: `Couldn't start Grok: ${err.message}. Check that \`grok\` is on your PATH.` }));
    this.proc.stderr.on("data", (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    this.proc.on("exit", (code) => {
      if (this.closing) code = 0;
      for (const c of this.calls.values()) c.reject(new Error("Grok stopped."));
      if (code && this.stderr.trim()) this.emit({ kind: "error", message: this.stderr.trim() });
      this.emit({ kind: "exited", code });
    });
    createInterface({ input: this.proc.stdout }).on("line", (line) => this.onLine(line));
    this.ready = this.handshake();
    this.ready.catch((err) => this.emit({ kind: "error", message: `Grok didn't start a session: ${err.message}` }));
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let msg: Json;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && !msg.method && ("result" in msg || "error" in msg)) {
      const call = this.calls.get(msg.id);
      this.calls.delete(msg.id);
      if (msg.error) call?.reject(new Error(msg.error.message ?? "Grok request failed"));
      else call?.resolve(msg.result ?? {});
      return;
    }
    for (const e of this.mapper.feed(msg)) this.emit(e);
    for (const id of this.mapper.unsupported.splice(0)) this.write({ id, error: { code: -32601, message: "Not supported by this client" } });
  }

  private write(obj: Json) {
    if (this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...obj }) + "\n");
  }

  private rpc(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  private async handshake(): Promise<string> {
    // No fs or terminal capabilities: Grok uses its own tools and asks us only for approvals.
    await this.rpc("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const res = await this.rpc("session/new", { cwd: this.cwd, mcpServers: [] });
    const sessionId = String(res.sessionId);
    for (const e of this.mapper.ready(sessionId)) this.emit(e);
    return sessionId;
  }

  send(text: string) {
    this.emit({ kind: "user.message", id: randomUUID(), text });
    this.emit({ kind: "turn.started" });
    this.mapper.beginTurn();
    this.ready
      .then((sessionId) => this.rpc("session/prompt", { sessionId, prompt: [{ type: "text", text }] }))
      .then((res) => { for (const e of this.mapper.endTurn(res.stopReason)) this.emit(e); })
      .catch((err) => {
        this.emit({ kind: "error", message: err.message });
        for (const e of this.mapper.endTurn("error")) this.emit(e);
      });
  }

  respond(permissionId: string, decision: PermissionOption["id"]) {
    const res = this.mapper.permissionResponse(permissionId, decision);
    if (res) this.write(res);
    this.emit({ kind: "permission.resolved", id: permissionId, decision });
  }

  interrupt() {
    if (this.mapper.sessionId) this.write({ method: "session/cancel", params: { sessionId: this.mapper.sessionId } });
  }

  close() {
    this.closing = true;
    this.proc.stdin.end();
    setTimeout(() => { if (this.proc.exitCode === null) this.proc.kill("SIGTERM"); }, 1500).unref();
  }
}
