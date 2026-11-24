// Plays a recorded fixture (tools/record_*.py format) through the real UI, with no agent or tokens.
// Used for screenshots, theme work and demos:
//   AGENTS_GUI_REPLAY=fixtures/claude-twoway.ndjson npm run dev   (then start a Claude session)
//   AGENTS_GUI_REPLAY=fixtures/codex-twoway.ndjson npm run dev    (then start a Codex session)

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentId } from "@shared/events";
import { ClaudeMapper } from "./claude-mapper";
import { CodexMapper } from "./codex-mapper";
import { GrokMapper } from "./grok-mapper";
import type { AgentSession } from "./claude";

type Json = Record<string, any>;

function claudeEvents(lines: [boolean, Json][]): AgentEvent[] {
  const mapper = new ClaudeMapper();
  return lines.flatMap(([outgoing, msg]): AgentEvent[] => {
    if (!outgoing) return mapper.feed(msg);
    if (msg.type === "user") return [{ kind: "user.message", id: randomUUID(), text: String(msg.message?.content ?? "") }, { kind: "turn.started" }];
    if (msg.type === "control_response") {
      return [{ kind: "permission.resolved", id: msg.response.request_id, decision: msg.response?.response?.behavior === "deny" ? "deny" : "allow" }];
    }
    return [];
  });
}

function codexEvents(lines: [boolean, Json][]): AgentEvent[] {
  const mapper = new CodexMapper();
  return lines.flatMap(([outgoing, msg]): AgentEvent[] => {
    if (!outgoing) return msg.method ? mapper.feed(msg) : [];
    if (msg.method === "turn/start") return [{ kind: "user.message", id: randomUUID(), text: msg.params.input?.[0]?.text ?? "" }, { kind: "turn.started" }];
    if (msg.result?.decision) return [{ kind: "permission.resolved", id: `codex-${msg.id}`, decision: msg.result.decision === "decline" ? "deny" : "allow" }];
    return [];
  });
}

export function grokEvents(lines: [boolean, Json][]): AgentEvent[] {
  const mapper = new GrokMapper("");
  const promptIds = new Set<number>();
  return lines.flatMap(([outgoing, msg]): AgentEvent[] => {
    if (outgoing) {
      if (msg.method === "session/new") { mapper.cwd = msg.params.cwd; return []; }
      if (msg.method === "session/prompt") {
        promptIds.add(msg.id);
        mapper.beginTurn();
        return [{ kind: "user.message", id: randomUUID(), text: msg.params.prompt?.[0]?.text ?? "" }, { kind: "turn.started" }];
      }
      if (msg.result?.outcome) {
        return [{ kind: "permission.resolved", id: `grok-${msg.id}`, decision: String(msg.result.outcome.optionId ?? "").startsWith("reject") ? "deny" : "allow" }];
      }
      return [];
    }
    if (msg.method) return mapper.feed(msg);
    if (msg.result?.sessionId) return mapper.ready(msg.result.sessionId);
    if (promptIds.has(msg.id)) return mapper.endTurn(msg.result?.stopReason);
    return [];
  });
}

export class ReplaySession implements AgentSession {
  private timer: NodeJS.Timeout | undefined;

  constructor(path: string, agent: AgentId, private emit: (e: AgentEvent) => void, stepMs = 12) {
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim())
      .map((raw): [boolean, Json] => [raw.startsWith("> "), JSON.parse(raw.replace(/^[<>] /, ""))]);
    const queue = agent === "codex" ? codexEvents(lines) : agent === "grok" ? grokEvents(lines) : claudeEvents(lines);
    const tick = () => {
      const e = queue.shift();
      if (!e) return;
      this.emit(e);
      // Pause on approvals and turn ends so they are visible, stream text quickly.
      const wait = e.kind === "permission.request" ? 700 : e.kind === "turn.done" ? 500 : e.kind.endsWith(".delta") ? stepMs : stepMs * 4;
      this.timer = setTimeout(tick, wait);
    };
    this.timer = setTimeout(tick, 300);
  }

  send() {}
  respond() {}
  interrupt() {}
  close() { clearTimeout(this.timer); }
}
