// Drives a live `codex app-server` over JSON-RPC on stdio (docs/PROTOCOLS.md).

import { agentEnv } from "../env";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { AgentEvent, PermissionOption } from "@shared/events";
import type { AgentSession } from "./claude";
import { CodexMapper } from "./codex-mapper";
import { mergeCommands, type ModelOption } from "@shared/commands";

type Json = Record<string, any>;

export class CodexSession implements AgentSession {
  private proc: ChildProcessWithoutNullStreams;
  private mapper = new CodexMapper();
  private nextId = 1;
  private calls = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private ready: Promise<string>;
  private stderr = "";
  private closing = false;
  private model: string | undefined;
  private effort: string | undefined;

  /** `resume`: a thread id to continue, "latest" for the newest thread in this folder, or nothing for a new thread. */
  constructor(private cwd: string, private emit: (e: AgentEvent) => void, private resume?: string, bin = "codex") {
    this.proc = spawn(bin, ["app-server"], { cwd, env: agentEnv(), stdio: ["pipe", "pipe", "pipe"] });
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
    const visible = list.filter((m) => !m.hidden);
    const def = list.find((m) => m.isDefault);
    const model = def?.id ?? list[0]?.id;
    this.model = model;
    this.effort = def?.defaultReasoningEffort;
    const options: ModelOption[] = visible.map((m) => ({
      id: m.id, label: m.displayName ?? m.id, description: m.description,
      efforts: (m.supportedReasoningEfforts ?? []).map((e: Json) => e.reasoningEffort),
    }));
    this.emit({ kind: "models", models: options, current: model, effort: this.effort });
    this.emit({ kind: "commands", commands: mergeCommands("codex", [
      { name: "compact", description: "Summarize the conversation to free up context", run: "action" },
      { name: "new", description: "Start a new conversation in this session", run: "action" },
    ]) });
    const withModel = model ? { model } : {};
    let threadId = this.resume;
    if (threadId === "latest") {
      const recent = await this.rpc("thread/list", { cwd: this.cwd, limit: 1 });
      threadId = recent.data?.[0]?.id;
    }
    // thread/resume replays thread/started, so the UI learns the id and model either way.
    const res = threadId
      ? await this.rpc("thread/resume", { threadId, ...withModel })
      : await this.rpc("thread/start", { cwd: this.cwd, ...withModel });
    if (threadId && !this.mapper.threadId) {
      this.mapper.threadId = res.thread.id;
      this.emit({ kind: "session.started", agent: "codex", sessionId: res.thread.id, model: res.model ?? res.thread.model, cwd: this.cwd });
    }
    if (threadId) {
      // Show the saved conversation, so Chat matches whatever happened in the Terminal view.
      try {
        const turns = await this.rpc("thread/turns/list", { threadId: res.thread.id, itemsView: "full", sortDirection: "asc", limit: 500 });
        this.emit({ kind: "history", events: this.mapper.history(turns.data ?? []) });
      } catch (err) {
        this.emit({ kind: "error", message: `Couldn't load the earlier conversation: ${(err as Error).message}` });
      }
    }
    return res.thread.id as string;
  }

  send(text: string) {
    this.emit({ kind: "user.message", id: randomUUID(), text });
    this.emit({ kind: "turn.started" });
    this.ready
      .then((threadId) => this.rpc("turn/start", {
        threadId: this.mapper.threadId ?? threadId, input: [{ type: "text", text, text_elements: [] }],
        ...(this.model ? { model: this.model } : {}), ...(this.effort ? { effort: this.effort } : {}),
      }))
      .catch((err) => {
        this.emit({ kind: "error", message: err.message });
        this.emit({ kind: "turn.done", ok: false, error: err.message });
      });
  }

  /** Codex has no command parser over this protocol, so commands map to methods. */
  slash(name: string, _args: string) {
    this.ready.then(async () => {
      const threadId = this.mapper.threadId;
      if (name === "compact" && threadId) {
        await this.rpc("thread/compact/start", { threadId });
        this.emit({ kind: "notice", text: "Compacting the conversation to free up context." });
      } else if (name === "new") {
        const res = await this.rpc("thread/start", { cwd: this.cwd, ...(this.model ? { model: this.model } : {}) });
        this.mapper.threadId = res.thread.id;
        this.emit({ kind: "notice", text: "Started a new conversation." });
      } else {
        this.emit({ kind: "error", message: `/${name} isn't available in the chat view. Use the Terminal tab for it.` });
      }
    }).catch((err) => this.emit({ kind: "error", message: err.message }));
  }

  /** Codex takes model and effort with every turn, so a change applies from the next message. */
  setModel(model?: string, effort?: string) {
    if (model) this.model = model;
    if (effort) this.effort = effort;
    this.emit({ kind: "models", models: [], current: this.model, effort: this.effort });
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
