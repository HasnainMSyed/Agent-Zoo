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
    const entry: Entry = { info, view: "gui", gen: 0, hadTurn: false, usedTerminal: false, nativeId: agent === "claude" ? randomUUID() : undefined };
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
      this.sink.event(entry.info.id, e);
    };
  }

  private startGui(entry: Entry) {
    const { agent, cwd } = entry.info;
    const emit = this.emitFor(entry);
    const replay = process.env.AGENTS_GUI_REPLAY;
    if (replay) { entry.agent = new ReplaySession(replay, agent, emit); return; }
    if (agent === "claude") {
      entry.agent = new ClaudeSession(cwd, emit, { sessionId: entry.nativeId!, resume: claudeHasHistory(cwd, entry.nativeId!) });
      return;
    }
    // Codex and Grok: continue the known conversation, or the newest one if it began in the terminal.
    const resume = entry.nativeId && entry.hadTurn ? entry.nativeId : entry.usedTerminal ? "latest" : undefined;
    entry.agent = agent === "codex" ? new CodexSession(cwd, emit, resume) : new GrokSession(cwd, emit, resume);
  }

  private terminalCommand(entry: Entry): [string, string[]] {
    const { agent, cwd } = entry.info;
    const id = entry.nativeId;
    if (agent === "claude") return ["claude", claudeHasHistory(cwd, id!) ? ["--resume", id!] : ["--session-id", id!]];
    const known = id && entry.hadTurn;
    if (agent === "codex") return ["codex", known ? ["resume", id] : []];
    return ["grok", known ? ["--resume", id] : []];
  }

  setView(id: string, view: View, cols = 100, rows = 30) {
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
        data: (chunk) => { if (gen === entry.gen) this.sink.termData(id, chunk); },
        // When the agent's terminal UI quits, come back to the graphical view.
        exit: () => { if (gen === entry.gen) this.setView(id, "gui"); },
      }, cols, rows);
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
