// Drives a live `codex app-server` over JSON-RPC on stdio (docs/PROTOCOLS.md).

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { AgentEvent, PermissionOption } from "@shared/events";
import type { AgentSession } from "./claude";
import { CodexMapper } from "./codex-mapper";

type Json = Record<string, any>;

export class CodexSession implements AgentSession {
  private proc: ChildProcessWithoutNullStreams;
  private mapper = new CodexMapper();
  private nextId = 1;
  private calls = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private ready: Promise<string>;
  private stderr = "";
  private closing = false;

  constructor(private cwd: string, private emit: (e: AgentEvent) => void, bin = "codex") {
    this.proc = spawn(bin, ["app-server"], { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.on("error", (err) => this.emit({ kind: "error", message: `Couldn't start Codex: ${err.message}. Check that \`codex\` is on your PATH.` }));
    this.proc.stderr.on("data", (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    this.proc.on("exit", (code) => {
      if (this.closing) code = 0;
      for (const c of this.calls.values()) c.reject(new Error("Codex stopped."));
      if (code && this.stderr.trim()) this.emit({ kind: "error", message: this.stderr.trim() });
      this.emit({ kind: "exited", code });
    });
    createInterface({ input: this.proc.stdout }).on("line", (line) => this.onLine(line));
    this.ready = this.handshake();
    this.ready.catch((err) => this.emit({ kind: "error", message: `Codex didn't start a session: ${err.message}` }));
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let msg: Json;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && !msg.method && ("result" in msg || "error" in msg)) {
      const call = this.calls.get(msg.id);
      this.calls.delete(msg.id);
      if (msg.error) call?.reject(new Error(msg.error.message ?? "Codex request failed"));
      else call?.resolve(msg.result ?? {});
      return;
    }
    for (const e of this.mapper.feed(msg)) this.emit(e);
    for (const id of this.mapper.unsupported.splice(0)) this.write({ id, error: { code: -32601, message: "Not supported by this client" } });
  }

  private write(obj: Json) {
    if (this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  private rpc(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  private async handshake(): Promise<string> {
    await this.rpc("initialize", { clientInfo: { name: "agent-zoo", title: "Agent Zoo", version: "0.1.0" }, capabilities: null });
    this.write({ method: "initialized" });
    // The configured model can be one the account can't use, so start on the server's default.
    const models = await this.rpc("model/list", {});
    const list: Json[] = models.data ?? models.models ?? [];
    const model = list.find((m) => m.isDefault)?.id ?? list[0]?.id;
    const started = await this.rpc("thread/start", { cwd: this.cwd, ...(model ? { model } : {}) });
    return started.thread.id as string;
  }

  send(text: string) {
    this.emit({ kind: "user.message", id: randomUUID(), text });
    this.emit({ kind: "turn.started" });
    this.ready
      .then((threadId) => this.rpc("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] }))
      .catch((err) => {
        this.emit({ kind: "error", message: err.message });
        this.emit({ kind: "turn.done", ok: false, error: err.message });
      });
  }

  respond(permissionId: string, decision: PermissionOption["id"]) {
    const res = this.mapper.permissionResponse(permissionId, decision);
    if (res) this.write(res);
    this.emit({ kind: "permission.resolved", id: permissionId, decision });
  }

  interrupt() {
    const { threadId, turnId } = this.mapper;
    if (threadId && turnId) this.rpc("turn/interrupt", { threadId, turnId }).catch(() => {});
  }

  close() {
    this.closing = true;
    this.proc.stdin.end();
    setTimeout(() => { if (this.proc.exitCode === null) this.proc.kill("SIGTERM"); }, 1500).unref();
  }
}
