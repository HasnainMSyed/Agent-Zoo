import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentId, PermissionOption } from "@shared/events";
import { apply, newSession, type Session } from "./state";
import { packFor } from "./mascots";
import { Mascot, mascotLabel } from "./components/Mascot";
import { Transcript } from "./components/Transcript";
import { Composer } from "./components/Composer";

const AGENT_NAMES: Record<AgentId, string> = { claude: "Claude Code", codex: "Codex", grok: "Grok" };

function fmtTokens(n: number) { return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n); }

function ContextRing({ used, total }: { used?: number; total?: number }) {
  if (!used || !total) return null;
  const pct = Math.min(used / total, 1);
  const r = 9, c = 2 * Math.PI * r;
  return (
    <span className="ctx" title={`${fmtTokens(used)} of ${fmtTokens(total)} tokens of context used`}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r={r} className="ctx-track" /><circle cx="12" cy="12" r={r} className="ctx-fill" strokeDasharray={`${c * pct} ${c}`} transform="rotate(-90 12 12)" /></svg>
      {Math.round(pct * 100)}%
    </span>
  );
}

export function App() {
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [startError, setStartError] = useState("");
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const [autoStart, setAutoStart] = useState<AgentId | null>(null);
  useEffect(() => { window.agents.info().then((i) => { setCwd(i.cwd); setAutoStart(i.autoStart); }); }, []);
  useEffect(() => window.agents.onEvent((id, e) => {
    setSessions((prev) => (prev[id] ? { ...prev, [id]: apply(prev[id]!, e) } : prev));
  }), []);

  const start = useCallback(async (agent: AgentId) => {
    setStartError("");
    try {
      const info = await window.agents.createSession(agent, cwd);
      setSessions((prev) => ({ ...prev, [info.id]: newSession(info) }));
      setActiveId(info.id);
    } catch (err) { setStartError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err)); }
  }, [cwd]);

  useEffect(() => { if (autoStart && cwd) { const a = autoStart; setAutoStart(null); start(a); } }, [autoStart, cwd, start]);

  const active = activeId ? sessions[activeId] : undefined;
  const agent: AgentId = active?.info.agent ?? "claude";
  const pack = packFor(agent);

  const decide = (permId: string, d: PermissionOption["id"]) => { if (activeId) window.agents.command(activeId, { kind: "permission", id: permId, decision: d }); };
  const send = (text: string) => { if (activeId) window.agents.command(activeId, { kind: "send", text }); };
  const stop = () => { if (activeId) window.agents.command(activeId, { kind: "interrupt" }); };
  const closeSession = (id: string) => {
    window.agents.closeSession(id);
    setSessions((prev) => { const next = { ...prev }; delete next[id]; return next; });
    if (activeId === id) setActiveId(null);
  };

  const list = Object.values(sessions);
  const empty = (
    <div className="empty-state">
      {active && <Mascot pack={pack} state="idle" size={120} />}
      <h1>{active ? "What should we work on?" : "Start a session"}</h1>
      {!active && <>
        <div className="folder"><span className="muted">Folder</span><code>{cwd || "…"}</code><button className="btn-secondary" onClick={async () => { const p = await window.agents.pickFolder(); if (p) setCwd(p); }}>Change</button></div>
        <div className="agent-picker">
          {(["claude", "codex", "grok"] as const).map((a) => {
            const ready = true;
            return (
              <button key={a} className="agent-card" data-skin={a} disabled={!ready || !cwd} onClick={() => start(a)}>
                <Mascot pack={packFor(a)} state="idle" size={72} />
                <strong>{AGENT_NAMES[a]}</strong>
                <span>{ready ? "Start session" : "Coming in Phase 3"}</span>
              </button>
            );
          })}
        </div>
        {startError && <div className="error-banner" role="alert">{startError}</div>}
      </>}
    </div>
  );

  return (
    <div className="app" data-skin={agent}>
      <aside className="sidebar">
        <div className="brand">Agent Zoo</div>
        <button className="new-session" onClick={() => setActiveId(null)}>+ New session</button>
        <nav className="session-list" aria-label="Sessions">
          {list.map((s) => (
            <div key={s.info.id} className={`session-row ${s.info.id === activeId ? "active" : ""}`}>
              <button onClick={() => setActiveId(s.info.id)}>
                <span className={`dot ${s.status}`} aria-hidden="true" />
                <span className="session-name">{s.info.title}</span>
                <span className="session-agent">{AGENT_NAMES[s.info.agent]}</span>
              </button>
              <button className="close" onClick={() => closeSession(s.info.id)} aria-label={`Close ${s.info.title}`}>×</button>
            </div>
          ))}
          {!list.length && <p className="muted small pad">No sessions yet</p>}
        </nav>
      </aside>

      <main className="main">
        {active && (
          <header className="topbar">
            <div className="title"><strong>{active.info.title}</strong><span className="muted">{active.info.cwd}</span></div>
            <div className="chips">
              {active.model && <span className="chip">{active.model}</span>}
              <ContextRing used={active.usage?.contextUsed} total={active.usage?.contextWindow} />
              {active.usage?.costUsd !== undefined && <span className="chip">${active.usage.costUsd.toFixed(2)}</span>}
            </div>
          </header>
        )}
        <Transcript items={active?.items ?? []} onDecide={decide} empty={empty} />
        {active && (
          <Composer running={active.running} disabled={active.exited} onSend={send} onStop={stop}
            mascot={<Mascot pack={pack} state={active.status} size={56} />}
            status={active.exited ? "Session ended" : mascotLabel(active.status)} />
        )}
      </main>

      {active && (
        <aside className="rail">
          <section>
            <h2>Plan</h2>
            {active.plan.length
              ? <ul className="plan">{active.plan.map((p, i) => <li key={i} data-status={p.status}>{p.text}</li>)}</ul>
              : <p className="muted small">The agent's to-do list shows up here when it makes one.</p>}
          </section>
          <section>
            <h2>Session</h2>
            <dl>
              <dt>Agent</dt><dd>{AGENT_NAMES[active.info.agent]}</dd>
              {active.model && <><dt>Model</dt><dd>{active.model}</dd></>}
              {active.usage && <><dt>Tokens</dt><dd>{fmtTokens(active.usage.inputTokens)} in · {fmtTokens(active.usage.outputTokens)} out</dd></>}
              {active.usage?.costUsd !== undefined && <><dt>Cost</dt><dd>${active.usage.costUsd.toFixed(2)}</dd></>}
              <dt>Hooks run</dt><dd>{active.hooks}</dd>
            </dl>
          </section>
        </aside>
      )}
    </div>
  );
}
