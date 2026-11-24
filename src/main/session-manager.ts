// Owns every session. Each session has two views of one conversation:
//   "gui":      the agent's machine interface, drawn by Agent Zoo
//   "terminal": the agent's own terminal interface in a pseudo-terminal (nothing is ever out of reach)
// Only one view may drive a conversation at a time, so switching closes one and resumes the other.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AgentEvent, AgentId, SessionCommand, SessionInfo } from "@shared/events";
import { ClaudeSession, type AgentSession } from "./adapters/claude";
import { ReplaySession } from "./adapters/replay";
import { CodexSession } from "./adapters/codex";
import { GrokSession } from "./adapters/grok";
import { TerminalSession } from "./terminal";

export type View = "gui" | "terminal";

interface Sink {
  event(sessionId: string, e: AgentEvent): void;
  termData(sessionId: string, chunk: string): void;
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
  pendingType?: () => void; // types a queued command once the terminal interface first draws
}

/** Claude stores a conversation once it has a message; resuming an empty one fails. */
function claudeHasHistory(cwd: string, id: string) {
  return existsSync(join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`));
}

export class SessionManager {
  private sessions = new Map<string, Entry>();

  constructor(private sink: Sink) {}

  create(agent: AgentId, cwd: string): SessionInfo {
    const info: SessionInfo = { id: randomUUID(), agent, cwd, title: basename(cwd) };
    const entry: Entry = { info, view: "gui", gen: 0, hadTurn: false, usedTerminal: false, running: false, nativeId: agent === "claude" ? randomUUID() : undefined };
    this.sessions.set(info.id, entry);
    this.startGui(entry);
    return info;
  }

  private emitFor(entry: Entry) {
    const gen = entry.gen;
    return (e: AgentEvent) => {
      if (gen !== entry.gen) return;
      if (e.kind === "session.started" && entry.info.agent !== "claude") entry.nativeId = e.sessionId;
      if (e.kind === "user.message") entry.hadTurn = true;
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
      entry.agent = new ClaudeSession(cwd, emit, { sessionId: entry.nativeId!, resume: claudeHasHistory(cwd, entry.nativeId!), model, effort });
      return;
    }
    // Codex and Grok: continue the known conversation, or the newest one if it began in the terminal.
    const resume = entry.nativeId && entry.hadTurn ? entry.nativeId : entry.usedTerminal ? "latest" : undefined;
    entry.agent = agent === "codex" ? new CodexSession(cwd, emit, resume) : new GrokSession(cwd, emit, resume, { model, effort });
    if (agent === "codex" && (model || effort)) entry.agent.setModel?.(model, effort);
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
    if (agent === "claude") {
      const flags = [...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])];
      return ["claude", [...(claudeHasHistory(cwd, id!) ? ["--resume", id!] : ["--session-id", id!]), ...flags]];
    }
    const known = id && entry.hadTurn;
    if (agent === "codex") {
      const flags = [...(model ? ["-m", model] : []), ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : [])];
      return ["codex", known ? ["resume", ...flags, id] : flags];
    }
    const flags = [...(model ? ["-m", model] : []), ...(effort ? ["--reasoning-effort", effort] : [])];
    return ["grok", known ? [...flags, "--resume", id] : flags];
  }

  /** Types a command into the agent's terminal interface once it has drawn its first screen. */
  private typeWhenReady(entry: Entry, text: string) {
    const gen = entry.gen;
    let sent = false;
    const send = () => { if (!sent && gen === entry.gen) { sent = true; entry.term?.write(text); } };
    entry.pendingType = () => setTimeout(send, 1200);
    setTimeout(send, 6000); // fallback if the interface stays quiet
  }

  setView(id: string, view: View, cols = 100, rows = 30, typeOnOpen?: string) {
    const entry = this.sessions.get(id);
    if (!entry) throw new Error("That session has ended. Start a new one.");
    if (entry.view === view) return;
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
        exit: () => { if (gen === entry.gen) this.setView(id, "gui"); },
      }, cols, rows);
      if (typeOnOpen) this.typeWhenReady(entry, typeOnOpen);
    } else {
      entry.term?.close();
      entry.term = undefined;
      this.sink.event(id, { kind: "notice", text: "Back from the terminal. Anything you did there is part of this conversation, but it isn't drawn here yet." });
      this.startGui(entry);
    }
  }

  termInput(id: string, data: string) { this.sessions.get(id)?.term?.write(data); }
  termResize(id: string, cols: number, rows: number) { this.sessions.get(id)?.term?.resize(cols, rows); }

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

  close(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.gen++;
    s.agent?.close();
    s.term?.close();
    this.sessions.delete(id);
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
