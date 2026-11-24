import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentId, PermissionOption, SessionCommand } from "@shared/events";
import { apply, newSession, type Session } from "./state";
import type React from "react";
import { packFor } from "./mascots";
import { Mascot, mascotLabel } from "./components/Mascot";
import { Transcript } from "./components/Transcript";
import { Composer } from "./components/Composer";
import { HomeScreen } from "./components/HomeScreen";
import { UsageDetails } from "./components/Usage";
import { CommandPanel, modeLabel } from "./components/Panels";
import type { PanelKind, PastSession, UsageLimits } from "@shared/commands";
import { TerminalView, clearTerminalBuffer } from "./components/TerminalView";

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

/** State that survives restarts (panel layout, folded sections). */
function usePersisted<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : initial; } catch { return initial; }
  });
  const set = (v: T) => { setValue(v); try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ } };
  return [value, set];
}

function RailSection({ title, id, folded, setFolded, summary, children }: {
  title: string; id: string; folded: string[]; setFolded: (v: string[]) => void; summary?: string; children: React.ReactNode;
}) {
  const key = `rail:${id}`;
  const isFolded = folded.includes(key);
  return (
    <section>
      <button className="rail-head" aria-expanded={!isFolded} onClick={() => setFolded(isFolded ? folded.filter((f) => f !== key) : [...folded, key])}>
        <span className={`chev-small ${isFolded ? "" : "open"}`} aria-hidden="true">›</span>
        <h2>{title}</h2>{summary && <span className="rail-summary">{summary}</span>}
      </button>
      <div className="fold" data-open={!isFolded}><div className="fold-inner">{children}</div></div>
    </section>
  );
}

export function App() {
  const [layoutState, setLayoutState] = usePersisted("zoo.layout", { left: true, right: true });
  const layout = layoutState;
  const setLayout = (patch: Partial<typeof layoutState>) => setLayoutState({ ...layoutState, ...patch });
  const [folded, setFolded] = usePersisted<string[]>("zoo.folded", []);
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [home, setHome] = useState("");
  const [startError, setStartError] = useState("");
  const [past, setPast] = useState<PastSession[]>([]);
  const [pastLoading, setPastLoading] = useState(true);
  const [usage, setUsage] = useState<Partial<Record<AgentId, UsageLimits>>>({});
  const [panel, setPanel] = useState<{ sessionId: string; kind: PanelKind } | null>(null);
  const [lastAgent, setLastAgent] = usePersisted<AgentId>("zoo.lastAgent", "claude");
  const refreshPast = useCallback((fresh = false) => {
    setPastLoading(true);
    window.agents.pastSessions(fresh).then(setPast).catch(() => {}).finally(() => setPastLoading(false));
  }, []);
  useEffect(() => {
    refreshPast();
    window.agents.usage().then(setUsage).catch(() => {});
    return window.agents.onUsage(setUsage);
  }, [refreshPast]);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const [autoStart, setAutoStart] = useState<AgentId | null>(null);
  // Screenshot automation only: optionally send one prompt, then open the Terminal view.
  const autoView = useRef<"terminal" | null>(null);
  const autoPrompt = useRef<string | null>(null);
  const autoType = useRef<string | null>(null);
  useEffect(() => { window.agents.info().then((i) => { setCwd(i.cwd); setHome(i.home); setAutoStart(i.autoStart); autoView.current = i.autoView; autoPrompt.current = i.autoPrompt; autoType.current = i.autoType; }); }, []);
  useEffect(() => window.agents.onEvent((id, e) => {
    setSessions((prev) => (prev[id] ? { ...prev, [id]: apply(prev[id]!, e) } : prev));
  }), []);

  const start = useCallback(async (agent: AgentId, opts: { cwd?: string; prompt?: string; resumeId?: string } = {}) => {
    setStartError("");
    try {
      const info = await window.agents.createSession(agent, opts.cwd ?? cwd, opts.resumeId);
      setSessions((prev) => ({ ...prev, [info.id]: newSession(info) }));
      setActiveId(info.id);
      setLastAgent(agent);
      if (opts.prompt) setTimeout(() => window.agents.command(info.id, { kind: "send", text: opts.prompt! }), 300);
      const prompt = autoPrompt.current;
      if (prompt) { autoPrompt.current = null; setTimeout(() => window.agents.command(info.id, { kind: "send", text: prompt }), 800); }
      else if (autoView.current) { autoView.current = null; setTimeout(() => window.agents.setView(info.id, "terminal"), 1500); }
    } catch (err) { setStartError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err)); }
  }, [cwd, setLastAgent]);

  useEffect(() => { if (autoStart && cwd) { const a = autoStart; setAutoStart(null); start(a); } }, [autoStart, cwd, start]);

  const active = activeId ? sessions[activeId] : undefined;
  useEffect(() => {
    if (autoView.current && active && !autoPrompt.current && active.items.some((i) => i.type === "turn")) {
      autoView.current = null;
      window.agents.setView(active.info.id, "terminal", undefined, undefined, autoType.current ?? undefined);
    }
  }, [active]);
  const agent: AgentId = active?.info.agent ?? "claude";
  const pack = packFor(agent);

  const decide = (permId: string, d: PermissionOption["id"]) => { if (activeId) window.agents.command(activeId, { kind: "permission", id: permId, decision: d }); };
  const send = (text: string) => { if (activeId) window.agents.command(activeId, { kind: "send", text }); };
  const stop = () => { if (activeId) window.agents.command(activeId, { kind: "interrupt" }); };
  const showError = (id: string, err: unknown) => {
    const message = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);
    setSessions((prev) => (prev[id] ? { ...prev, [id]: apply(prev[id]!, { kind: "error", message }) } : prev));
  };
  const switchView = async (id: string, view: "gui" | "terminal", typeOnOpen?: string) => {
    if (view === "gui") clearTerminalBuffer(id);
    try {
      // An app window left open across an update can run a newer page against an older bridge.
      if (typeof window.agents.setView !== "function") throw new Error("Agent Zoo was updated while it was open. Quit it and start it again to finish updating.");
      await window.agents.setView(id, view, undefined, undefined, typeOnOpen);
    } catch (err) { showError(id, err); }
  };
  const runCommand = (id: string, cmd: SessionCommand) => { window.agents.command(id, cmd).catch((err) => showError(id, err)); };
  const closeSession = (id: string) => {
    window.agents.closeSession(id);
    setSessions((prev) => { const next = { ...prev }; delete next[id]; return next; });
    if (activeId === id) setActiveId(null);
  };

  const list = Object.values(sessions);
  const empty = active ? (
    <div className="empty-state">
      <Mascot pack={pack} state="idle" size={120} />
      <h1>What should we work on?</h1>
    </div>
  ) : (
    <>
      <HomeScreen home={home} past={past} loading={pastLoading} usage={usage} lastAgent={lastAgent}
        onOpenFolder={() => window.agents.pickFolder()}
        onStart={(a, folder, prompt) => { start(a, { cwd: folder, prompt: prompt || undefined }); }}
        onResume={(ps) => {
          // Already open? Just switch to it.
          const open = list.find((x) => x.info.agent === ps.agent && x.title && x.info.cwd === ps.cwd && x.title === ps.title);
          if (open) setActiveId(open.info.id); else start(ps.agent, { cwd: ps.cwd, resumeId: ps.id });
        }} />
      {startError && <div className="error-banner home-error" role="alert">{startError}</div>}
    </>
  );

  // Sessions grouped by project folder, in the order the folders were first used.
  const folders = new Map<string, Session[]>();
  for (const s of list) folders.set(s.info.cwd, [...(folders.get(s.info.cwd) ?? []), s]);
  const sessionLabel = (s: Session) => s.title ?? `${AGENT_NAMES[s.info.agent]} session`;

  return (
    <div className={`app ${layout.left ? "" : "no-left"} ${!active ? "no-rail" : layout.right ? "" : "slim-right"}`} data-skin={agent}>
      {layout.left ? (
        <aside className="sidebar">
          <div className="sidebar-head">
            <div className="brand">Agent Zoo</div>
            <button className="icon-btn" onClick={() => setLayout({ left: false })} aria-label="Hide the sessions panel" title="Hide the sessions panel">«</button>
          </div>
          <button className="new-session" onClick={() => setActiveId(null)}>+ New session</button>
          <nav className="session-list" aria-label="Sessions by folder">
            {[...folders.entries()].map(([folder, items]) => {
              const isFolded = folded.includes(folder);
              return (
                <div key={folder} className="folder-group">
                  <button className="folder-head" aria-expanded={!isFolded} title={folder}
                    onClick={() => setFolded(isFolded ? folded.filter((f) => f !== folder) : [...folded, folder])}>
                    <span className={`chev-small ${isFolded ? "" : "open"}`} aria-hidden="true">›</span>
                    <span className="folder-name">{folder.split("/").pop() || folder}</span>
                    <span className="folder-count">{items.length}</span>
                  </button>
                  <div className="fold" data-open={!isFolded}><div className="fold-inner">
                  {items.map((s) => (
                    <div key={s.info.id} className={`session-row ${s.info.id === activeId ? "active" : ""}`}>
                      <button onClick={() => setActiveId(s.info.id)}>
                        <span className={`dot agent-${s.info.agent} ${s.status}`} aria-hidden="true" />
                        <span className="session-name">{sessionLabel(s)}</span>
                        <span className="session-agent">{AGENT_NAMES[s.info.agent]}{s.view === "terminal" ? " · Terminal" : ""}</span>
                      </button>
                      <button className="close" onClick={() => closeSession(s.info.id)} aria-label={`Close ${sessionLabel(s)}`}>×</button>
                    </div>
                  ))}
                  </div></div>
                </div>
              );
            })}
            {!list.length && <p className="muted small pad">No sessions yet</p>}
          </nav>
        </aside>
      ) : (
        <aside className="sidebar-slim">
          <button className="icon-btn" onClick={() => setLayout({ left: true })} aria-label="Show the sessions panel" title="Show the sessions panel">»</button>
          <button className="icon-btn" onClick={() => setActiveId(null)} aria-label="New session" title="New session">+</button>
          {list.map((s) => (
            <button key={s.info.id} className={`slim-session ${s.info.id === activeId ? "active" : ""}`} onClick={() => setActiveId(s.info.id)} title={`${sessionLabel(s)} · ${s.info.cwd}`}>
              <span className={`dot agent-${s.info.agent} ${s.status}`} aria-hidden="true" />
            </button>
          ))}
        </aside>
      )}

      <main className="main">
        {active && (
          <header className="topbar">
            <div className="title"><strong>{active.info.title}</strong><span className="muted">{active.info.cwd}</span></div>
            <div className="chips">
              <div className="view-toggle" role="tablist" aria-label="View">
                {(["gui", "terminal"] as const).map((v) => (
                  <button key={v} role="tab" aria-selected={active.view === v} disabled={active.view !== v && active.running}
                    title={active.running && active.view !== v ? "Wait for the agent to finish, or stop it, before switching" : v === "terminal" ? "Open this conversation in the agent's own terminal interface" : "Back to the chat view"}
                    onClick={() => switchView(active.info.id, v)}>{v === "gui" ? "Chat" : "Terminal"}</button>
                ))}
              </div>
              {active.model && <span className="chip">{active.model}</span>}
              <ContextRing used={active.usage?.contextUsed} total={active.usage?.contextWindow} />
              {active.usage?.costUsd !== undefined && <span className="chip">${active.usage.costUsd.toFixed(2)}</span>}
            </div>
          </header>
        )}
        {active?.view === "terminal" ? <TerminalView key={active.info.id} sessionId={active.info.id} /> : <>
        {active ? <Transcript items={active.items} onDecide={decide} empty={empty} /> : <div className="home-scroll">{empty}</div>}
        {active && (
          <Composer running={active.running} disabled={active.exited} onSend={send} onStop={stop}
            commands={active.commands} models={active.models} model={active.model} effort={active.effort}
            onCommand={(cmd, args) => {
              const typed = `/${cmd.name}${args ? " " + args : ""}`;
              if (cmd.run === "terminal") switchView(active.info.id, "terminal", typed + "\r");
              else if (cmd.run === "panel") setPanel({ sessionId: active.info.id, kind: cmd.name as PanelKind });
              else runCommand(active.info.id, { kind: "slash", name: cmd.name, args });
            }}
            onPickModel={(model, effort) => runCommand(active.info.id, { kind: "setModel", model, effort })}
            panel={panel?.sessionId === active.info.id
              ? <CommandPanel key={panel.kind} kind={panel.kind} sessionId={active.info.id} mode={active.permissionMode} onClose={() => setPanel(null)}
                  onTerminal={(typed) => { setPanel(null); switchView(active.info.id, "terminal", typed); }} />
              : undefined}
            modeLabel={active.info.agent === "claude" ? modeLabel(active.permissionMode ?? "default") : undefined}
            onMode={() => setPanel(panel?.kind === "mode" && panel.sessionId === active.info.id ? null : { sessionId: active.info.id, kind: "mode" })}
            mascot={<Mascot pack={pack} state={active.status} size={56} />}
            status={active.exited ? "Session ended" : mascotLabel(active.status)} />
        )}
        </>}
      </main>

      {active && layout.right && (
        <aside className="rail">
          <div className="rail-top"><button className="icon-btn" onClick={() => setLayout({ right: false })} aria-label="Hide the details panel" title="Hide the details panel">»</button></div>
          <RailSection title="Usage" id="usage" folded={folded} setFolded={setFolded}
            summary={usage[active.info.agent]?.windows[0] ? `${usage[active.info.agent]!.windows[0]!.usedPct}%` : undefined}>
            <UsageDetails agent={active.info.agent} usage={usage[active.info.agent]} sessionCost={active.usage?.costUsd} />
          </RailSection>
          <RailSection title="Plan" id="plan" folded={folded} setFolded={setFolded}
            summary={active.plan.length ? `${active.plan.filter((p) => p.status === "done").length}/${active.plan.length}` : undefined}>
            {active.plan.length
              ? <ul className="plan">{active.plan.map((p, i) => <li key={i} data-status={p.status}>{p.text}</li>)}</ul>
              : <p className="muted small">The agent's to-do list shows up here when it makes one.</p>}
          </RailSection>
          <RailSection title="Session" id="session" folded={folded} setFolded={setFolded}>
            <dl>
              <dt>Agent</dt><dd>{AGENT_NAMES[active.info.agent]}</dd>
              {active.model && <><dt>Model</dt><dd>{active.model}</dd></>}
              {active.usage && <><dt>Tokens</dt><dd>{fmtTokens(active.usage.inputTokens)} in · {fmtTokens(active.usage.outputTokens)} out</dd></>}
              {active.usage?.costUsd !== undefined && <><dt>Cost</dt><dd>${active.usage.costUsd.toFixed(2)}</dd></>}
              <dt>Hooks run</dt><dd>{active.hooks}</dd>
            </dl>
          </RailSection>
        </aside>
      )}
      {active && !layout.right && (
        <aside className="rail-slim">
          <button className="icon-btn" onClick={() => setLayout({ right: true })} aria-label="Show the details panel" title="Show the details panel">«</button>
        </aside>
      )}
    </div>
  );
}
