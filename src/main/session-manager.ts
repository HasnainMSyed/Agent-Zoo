// Owns every running agent session and routes events to the window.

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { AgentEvent, AgentId, SessionCommand, SessionInfo } from "@shared/events";
import { ClaudeSession, type AgentSession } from "./adapters/claude";
import { ReplaySession } from "./adapters/replay";
import { CodexSession } from "./adapters/codex";
import { GrokSession } from "./adapters/grok";

type Emit = (sessionId: string, event: AgentEvent) => void;

export class SessionManager {
  private sessions = new Map<string, { info: SessionInfo; agent: AgentSession }>();

  constructor(private emit: Emit) {}

  create(agent: AgentId, cwd: string): SessionInfo {
    const info: SessionInfo = { id: randomUUID(), agent, cwd, title: basename(cwd) };
    const emit = (e: AgentEvent) => this.emit(info.id, e);
    const replay = process.env.AGENTS_GUI_REPLAY;
    const session = replay ? new ReplaySession(replay, agent, emit)
      : agent === "codex" ? new CodexSession(cwd, emit)
      : agent === "grok" ? new GrokSession(cwd, emit)
      : new ClaudeSession(cwd, emit);
    this.sessions.set(info.id, { info, agent: session });
    return info;
  }

  command(id: string, cmd: SessionCommand) {
    const s = this.sessions.get(id);
    if (!s) throw new Error("That session has ended. Start a new one.");
    if (cmd.kind === "send") s.agent.send(cmd.text);
    else if (cmd.kind === "permission") s.agent.respond(cmd.id, cmd.decision);
    else if (cmd.kind === "interrupt") s.agent.interrupt();
  }

  close(id: string) {
    this.sessions.get(id)?.agent.close();
    this.sessions.delete(id);
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
