// Owns every session. Each session has two views of one conversation:
//   "gui":      the agent's machine interface, drawn by Agent Zoo
//   "terminal": the agent's own terminal interface in a pseudo-terminal (nothing is ever out of reach)
// Only one view may drive a conversation at a time, so switching closes one and resumes the other.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AgentEvent, AgentId, SessionCommand, SessionInfo } from "@shared/events";
import { ClaudeSession, type AgentSession } from "./adapters/claude";
import { claudeHistory } from "./adapters/claude-mapper";
import { ReplaySession } from "./adapters/replay";
import { CodexSession } from "./adapters/codex";
import { CODEX_ACCESS } from "./adapters/codex-mapper";
import { GrokSession } from "./adapters/grok";
import { TerminalSession } from "./terminal";
import { AGENT_QUERIES } from "@shared/commands";

export type View = "gui" | "terminal";

interface Sink {
  event(sessionId: string, e: AgentEvent): void;
  termData(sessionId: string, chunk: string): void;
  limits(patch: Extract<AgentEvent, { kind: "limits" }>["limits"]): void;
}

interface Entry {
  info: SessionInfo;
  view: View;
  gen: number; // bumps on every switch, so a closing process's last events are dropped
  agent?: AgentSession;
  term?: TerminalSession;
  nativeId?: string; // the agent's own session id (Claude's is chosen by us up front)
  hadTurn: boolean;
  usedTerminal: boolean;
  running: boolean;
  model?: string;  // chosen in the picker; Claude and Grok apply it by restarting on the same conversation
  effort?: string;
  permissionMode?: string; // Claude's, kept so a restart or the Terminal view keeps the same mode
  codexAccessOverride?: string;
  pendingType?: () => void; // types a queued command once the terminal interface first draws
}

/** Where Claude saves a conversation (it appears once the conversation has a message). */
const claudeFile = (cwd: string, id: string) => join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
const claudeHasHistory = (cwd: string, id: string) => existsSync(claudeFile(cwd, id));

export class SessionManager {
  private sessions = new Map<string, Entry>();

  constructor(private sink: Sink) {}

  /** Starts a session; `resumeId` reopens a conversation the agent saved earlier. */
  create(agent: AgentId, cwd: string, resumeId?: string, permissionMode?: string, cloud?: string): SessionInfo {
    if (cloud !== undefined && (agent !== "claude" || !/^[\w:/.?=&%-]{4,300}$/.test(cloud))) throw new Error("That doesn't look like a cloud session link or ID.");
    const info: SessionInfo = { id: randomUUID(), agent, cwd, title: cloud ? "Cloud session" : basename(cwd), cloud };
    const entry: Entry = {
      info, view: "gui", gen: 0, hadTurn: Boolean(resumeId), usedTerminal: false, running: false,
      nativeId: resumeId ?? (agent === "claude" ? randomUUID() : undefined),
      permissionMode: agent === "claude" && permissionMode && permissionMode !== "default" ? permissionMode : undefined,
    };
    info.nativeId = entry.nativeId;
    this.sessions.set(info.id, entry);
    // Cloud sessions only exist in Claude's own interface: the app opens them in the Terminal view (see setView).
    if (!cloud) this.startGui(entry);
    return info;
  }

  private emitFor(entry: Entry) {
    const gen = entry.gen;
    return (e: AgentEvent) => {
      if (gen !== entry.gen) return;
      if (e.kind === "session.started" && entry.info.agent !== "claude") entry.nativeId = e.sessionId;
      if (e.kind === "user.message") entry.hadTurn = true;
      if (e.kind === "limits") this.sink.limits(e.limits);
      if (e.kind === "mode") entry.permissionMode = e.mode;
      if (e.kind === "turn.started") entry.running = true;
      if (e.kind === "turn.done" || e.kind === "exited") entry.running = false;
      this.sink.event(entry.info.id, e);
    };
  }

  private startGui(entry: Entry) {
    const { agent, cwd } = entry.info;
    const emit = this.emitFor(entry);
    const replay = process.env.AGENTS_GUI_REPLAY;
    if (replay) { entry.agent = new ReplaySession(replay, agent, emit); return; }
    const { model, effort } = entry;
    if (agent === "claude") {
      const resume = claudeHasHistory(cwd, entry.nativeId!);
      // Show the saved conversation first, so Chat matches whatever happened in the Terminal view.
      if (resume) {
        try { emit({ kind: "history", events: claudeHistory(readFileSync(claudeFile(cwd, entry.nativeId!), "utf8")) }); }
        catch (err) { emit({ kind: "error", message: `Couldn't read the saved conversation: ${(err as Error).message}` }); }
      }
      entry.agent = new ClaudeSession(cwd, emit, { sessionId: entry.nativeId!, resume, model, effort, permissionMode: entry.permissionMode });
      return;
    }
    // Codex and Grok: continue the known conversation, or the newest one if it began in the terminal.
    const resume = entry.nativeId && entry.hadTurn ? entry.nativeId : entry.usedTerminal ? "latest" : undefined;
    entry.agent = agent === "codex" ? new CodexSession(cwd, emit, resume) : new GrokSession(cwd, emit, resume, { model, effort });
    if (agent === "codex" && (model || effort)) entry.agent.setModel?.(model, effort);
    if (entry.agent instanceof CodexSession && entry.codexAccessOverride) {
      entry.agent.setAccess(entry.codexAccessOverride);
      emit({ kind: "mode", mode: entry.codexAccessOverride });
    }
  }

  private setModel(entry: Entry, model?: string, effort?: string) {
    if (model) entry.model = model;
    if (effort) entry.effort = effort;
    // Codex takes model and effort with each turn; the others restart on the same conversation.
    if (entry.agent?.setModel) { entry.agent.setModel(model, effort); return; }
    if (entry.running) throw new Error("Wait for the agent to finish, or stop it, before changing the model.");
    entry.gen++;
    entry.agent?.close();
    const label = [model && `model ${model}`, effort && `${effort} effort`].filter(Boolean).join(" and ");
    this.sink.event(entry.info.id, { kind: "notice", text: `Switched to ${label}. The conversation continues where it left off.` });
    this.startGui(entry);
  }

  private terminalCommand(entry: Entry): [string, string[]] {
    const { agent, cwd } = entry.info;
    const id = entry.nativeId;
    const { model, effort } = entry;
    if (entry.info.cloud) return ["claude", ["--cloud", entry.info.cloud]];
    if (agent === "claude") {
      const mode = entry.permissionMode && entry.permissionMode !== "default" ? ["--permission-mode", entry.permissionMode] : [];
      const flags = [...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : []), ...mode];
      return ["claude", [...(claudeHasHistory(cwd, id!) ? ["--resume", id!] : ["--session-id", id!]), ...flags]];
    }
    const known = id && entry.hadTurn;
    if (agent === "codex") {
      const flags = [...(model ? ["-m", model] : []), ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : [])];
      if (entry.codexAccessOverride) {
        const access = CODEX_ACCESS[entry.codexAccessOverride]!;
        const sandbox = entry.codexAccessOverride === "auto" ? "workspace-write" : entry.codexAccessOverride === "full" ? "danger-full-access" : "read-only";
        flags.push("--sandbox", sandbox, "--ask-for-approval", access.approvalPolicy);
        if (sandbox === "workspace-write") flags.push("-c", "sandbox_workspace_write.network_access=false", "-c", "sandbox_workspace_write.writable_roots=[]", "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=false", "-c", "sandbox_workspace_write.exclude_slash_tmp=false");
      }
      // --no-daemon: the terminal must own the conversation and release it on exit; the shared
      // background server would keep holding it and block the Chat view from resuming.
      return ["codex", known ? ["resume", "--no-daemon", ...flags, id] : ["--no-daemon", ...flags]];
    }
    const flags = [...(model ? ["-m", model] : []), ...(effort ? ["--reasoning-effort", effort] : [])];
    return ["grok", known ? [...flags, "--resume", id] : flags];
  }

  /** Types a command into the agent's terminal interface once it has drawn its first screen. */
  private typeWhenReady(entry: Entry, text: string) {
    const gen = entry.gen;
    let sent = false;
    // Type the text, then press Enter separately: sent together, terminal interfaces read them as a
    // paste and Codex, for one, turns the Enter into a new line instead of submitting.
    const body = text.replace(/\r$/, "");
    const send = () => {
      if (sent || gen !== entry.gen) return;
      sent = true;
      entry.term?.write(body);
      if (body !== text) setTimeout(() => { if (gen === entry.gen) entry.term?.write("\r"); }, 250);
    };
    entry.pendingType = () => setTimeout(send, 1200);
    setTimeout(send, 6000); // fallback if the interface stays quiet
  }

  async openCodexVoice(id: string) {
    const entry = this.sessions.get(id);
    const agent = entry?.agent;
    if (!entry || !(agent instanceof CodexSession) || entry.view !== "gui") throw new Error("Open a Codex Chat session to start live voice.");
    if (entry.running) throw new Error("Wait for Codex to finish, or stop it, to talk.");
    const threadId = await agent.prepareVoiceThread();
    if (this.sessions.get(id) !== entry || entry.agent !== agent || entry.running) throw new Error("The Codex session changed. Try opening live voice again.");
    entry.nativeId = threadId;
    entry.hadTurn = true;
    this.setView(id, "terminal");
  }

  setView(id: string, view: View, cols = 100, rows = 30, typeOnOpen?: string) {
    const entry = this.sessions.get(id);
    if (!entry) throw new Error("That session has ended. Start a new one.");
    if (entry.view === view) return;
    if (entry.info.cloud && view === "gui") throw new Error("Cloud sessions open in the Terminal view only.");
    if (process.env.AGENTS_GUI_REPLAY) throw new Error("The Terminal view isn't available while replaying a recording.");
    entry.gen++;
    entry.view = view;
    this.sink.event(id, { kind: "view", view });

    if (view === "terminal") {
      entry.agent?.close();
      entry.agent = undefined;
      entry.usedTerminal = true;
      const [cmd, args] = this.terminalCommand(entry);
      const gen = entry.gen;
      entry.term = new TerminalSession(cmd, args, entry.info.cwd, {
        data: (chunk) => {
          if (gen !== entry.gen) return;
          this.sink.termData(id, chunk);
          const typeNow = entry.pendingType;
          entry.pendingType = undefined;
          typeNow?.();
        },
        // When the agent's terminal UI quits, come back to the graphical view.
        exit: (code) => {
          if (gen !== entry.gen) return;
          if (entry.info.cloud) { entry.term = undefined; this.sink.event(id, { kind: "exited", code }); return; }
          this.setView(id, "gui");
        },
      }, cols, rows);
      if (typeOnOpen) this.typeWhenReady(entry, typeOnOpen);
    } else {
      entry.term?.close();
      entry.term = undefined;
      this.startGui(entry);
    }
  }

  termInput(id: string, data: string) { (this.sessions.get(id)?.term ?? this.utilities.get(id))?.write(data); }
  termResize(id: string, cols: number, rows: number) { (this.sessions.get(id)?.term ?? this.utilities.get(id))?.resize(cols, rows); }

  /** Small terminals for one-off commands (signing in or out), not tied to a conversation. */
  private utilities = new Map<string, TerminalSession>();
  runUtility(cmd: string, args: string[], cols = 90, rows = 20, cwd = homedir()): string {
    const id = `util-${randomUUID()}`;
    this.utilities.set(id, new TerminalSession(cmd, args, cwd, {
      data: (chunk) => this.sink.termData(id, chunk),
      exit: (code) => { this.utilities.delete(id); this.sink.event(id, { kind: "exited", code }); },
    }, cols, rows));
    return id;
  }
  closeUtility(id: string) { this.utilities.get(id)?.close(); this.utilities.delete(id); }

  /** A session's folder (for the Files pane); undefined for cloud sessions, which have none here. */
  folderOf(sessionId: string): string | undefined {
    const s = this.sessions.get(sessionId);
    return s && !s.info.cloud ? s.info.cwd : undefined;
  }

  /** Shells beside a conversation (the Terminal pane), started in its folder; they close with it. */
  private shells = new Map<string, Set<string>>();
  openShell(sessionId: string, cols?: number, rows?: number): string {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("That session has ended. Start a new one.");
    const win = process.platform === "win32";
    const shell = win ? (process.env.COMSPEC || "powershell.exe") : (process.env.SHELL || "/bin/bash");
    const id = this.runUtility(shell, win ? [] : ["-l"], cols, rows, s.info.cloud ? homedir() : s.info.cwd);
    const set = this.shells.get(sessionId) ?? new Set<string>();
    set.add(id);
    this.shells.set(sessionId, set);
    return id;
  }
  closeShell(id: string) {
    this.closeUtility(id);
    for (const set of this.shells.values()) set.delete(id);
  }

  command(id: string, cmd: SessionCommand) {
    const s = this.sessions.get(id);
    if (!s) throw new Error("That session has ended. Start a new one.");
    if (!s.agent) throw new Error("This session is in the Terminal view. Switch back to send from here.");
    if (cmd.kind === "send") s.agent.send(cmd.text);
    else if (cmd.kind === "permission") s.agent.respond(cmd.id, cmd.decision);
    else if (cmd.kind === "interrupt") s.agent.interrupt();
    else if (cmd.kind === "slash") s.agent.slash(cmd.name, cmd.args);
    else if (cmd.kind === "setModel") this.setModel(s, cmd.model, cmd.effort);
  }

  /** A panel's request to the agent (Claude's control protocol); only known, safe requests pass. */
  async query(id: string, subtype: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const s = this.sessions.get(id);
    if (!s) throw new Error("That session has ended. Start a new one.");
    if (!AGENT_QUERIES[s.info.agent].includes(subtype)) throw new Error(`Unknown request: ${subtype}`);
    if (!s.agent) throw new Error("This session is in the Terminal view. Switch back to Chat to use this panel.");
    if (!s.agent.query) throw new Error("This agent doesn't offer that panel.");
    const gen = s.gen;
    const result = await s.agent.query(subtype, payload);
    if (subtype === "set_permission_mode" && gen === s.gen) {
      const mode = String((result as { mode?: string })?.mode ?? payload.mode);
      s.permissionMode = mode;
      if (s.info.agent === "codex") s.codexAccessOverride = mode;
      this.sink.event(id, { kind: "mode", mode });
    }
    return result;
  }

  /** Asks any open Chat-view Claude session (used to refresh plan limits without starting a new one). */
  claudeQuery(subtype: string): Promise<unknown> | undefined {
    for (const s of this.sessions.values()) if (s.info.agent === "claude" && s.agent?.query) return s.agent.query(subtype);
    return undefined;
  }

  close(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.gen++;
    s.agent?.close();
    s.term?.close();
    for (const shell of this.shells.get(id) ?? []) this.closeUtility(shell);
    this.shells.delete(id);
    this.sessions.delete(id);
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
    for (const id of [...this.utilities.keys()]) this.closeUtility(id);
  }
}
