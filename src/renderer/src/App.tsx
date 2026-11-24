import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent, AgentId, PermissionOption, SessionCommand } from "@shared/events";
import { apply, newSession, type Session } from "./state";
import type React from "react";
import { packFor } from "./mascots";
import { Mascot, mascotLabel } from "./components/Mascot";
import { Transcript } from "./components/Transcript";
import { Composer } from "./components/Composer";
import { HomeScreen } from "./components/HomeScreen";
import { UsageDetails } from "./components/Usage";
import { CommandPanel, modeLabel } from "./components/Panels";
import { SettingsPage, initials } from "./components/SettingsPage";
import { CloudTask, SessionSidebar } from "./components/SessionSidebar";
import { applySettings, loadSettings, saveSettings, type Settings } from "./settings";
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
  const [expanded, setExpanded] = usePersisted<string[]>("zoo.expandedFolders", []);
  const [cloudTask, setCloudTask] = useState<PastSession | null>(null);
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [home, setHome] = useState("");
  const [startError, setStartError] = useState("");
  const [past, setPast] = useState<PastSession[]>([]);
  const [pastLoading, setPastLoading] = useState(true);
  const [usage, setUsage] = useState<Partial<Record<AgentId, UsageLimits>>>({});
  const [settings, setSettingsState] = useState<Settings>(loadSettings);
  const setSettings = (s: Settings) => { setSettingsState(s); saveSettings(s); };
  useEffect(() => { applySettings(settings); }, [settings]);
  const [showSettings, setShowSettings] = useState(false);
  const [user, setUser] = useState("");
  const [appVersion, setAppVersion] = useState("");
  // The input box floats over the chat; the chat leaves room under its last message for it.
  const mainRef = useRef<HTMLElement>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const dock = dockRef.current, main = mainRef.current;
    if (!dock || !main) return;
    const ro = new ResizeObserver(() => main.style.setProperty("--dock-h", `${dock.offsetHeight}px`));
    ro.observe(dock);
    return () => ro.disconnect();
  });
  const [panel, setPanel] = useState<{ sessionId: string; kind: PanelKind } | null>(null);
  const [lastAgent, setLastAgent] = usePersisted<AgentId>("zoo.lastAgent", "claude");
  const refreshPast = useCallback((fresh = false) => {
    setPastLoading(true);
    window.agents.pastSessions(fresh).then(setPast).catch(() => {}).finally(() => setPastLoading(false));
  }, []);
  useEffect(() => {
    refreshPast();
    window.agents.usage().then(setUsage).catch(() => {});
    // Keep the sessions list current: Claude's saves arrive as they happen; the rest on focus.
    const offChanged = window.agents.onSessionsChanged(() => refreshPast());
    const onFocus = () => refreshPast();
    window.addEventListener("focus", onFocus);
    const offUsage = window.agents.onUsage(setUsage);
    return () => { offChanged(); offUsage(); window.removeEventListener("focus", onFocus); };
  }, [refreshPast]);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const [autoStart, setAutoStart] = useState<AgentId | null>(null);
  // Screenshot automation only: optionally send one prompt, then open the Terminal view.
  const autoView = useRef<"terminal" | null>(null);
  const autoPrompt = useRef<string | null>(null);
  const autoType = useRef<string | null>(null);
  useEffect(() => { window.agents.info().then((i) => { setCwd(i.cwd); setHome(i.home); setUser(i.user); setAppVersion(i.version); setAutoStart(i.autoStart); autoView.current = i.autoView; autoPrompt.current = i.autoPrompt; autoType.current = i.autoType; }); }, []);
  // Events can arrive before the session is added here (Claude sends a reopened conversation's
  // history right away), so events for an unknown session wait until it appears.
  const early = useRef(new Map<string, AgentEvent[]>());
  useEffect(() => window.agents.onEvent((id, e) => {
    if (!sessionsRef.current[id] && !id.startsWith("util-")) {
      const list = early.current.get(id) ?? [];
      list.push(e);
      early.current.set(id, list);
    }
    setSessions((prev) => (prev[id] ? { ...prev, [id]: apply(prev[id]!, e) } : prev));
  }), []);

  const start = useCallback(async (agent: AgentId, opts: { cwd?: string; prompt?: string; resumeId?: string; cloud?: string } = {}) => {
    setStartError("");
    try {
      const info = await window.agents.createSession(agent, opts.cwd ?? cwd, opts.resumeId, agent === "claude" ? settings.claudeMode : undefined, opts.cloud);
      if (opts.cloud) setTimeout(() => window.agents.setView(info.id, "terminal").catch(() => {}), 50);
      const waiting = early.current.get(info.id) ?? [];
      early.current.delete(info.id);
      setSessions((prev) => ({ ...prev, [info.id]: waiting.reduce(apply, newSession(info)) }));
      setActiveId(info.id);
      setShowSettings(false);
      setLastAgent(agent);
      if (opts.prompt) setTimeout(() => window.agents.command(info.id, { kind: "send", text: opts.prompt! }), 300);
      const prompt = autoPrompt.current;
      if (prompt) { autoPrompt.current = null; setTimeout(() => window.agents.command(info.id, { kind: "send", text: prompt }), 800); }
      else if (autoView.current) { autoView.current = null; setTimeout(() => window.agents.setView(info.id, "terminal"), 1500); }
    } catch (err) { setStartError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err)); }
  }, [cwd, setLastAgent, settings.claudeMode]);

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
    window.agents.closeSession(id).then(() => refreshPast());
    setSessions((prev) => { const next = { ...prev }; delete next[id]; return next; });
    if (activeId === id) setActiveId(null);
  };

  const list = Object.values(sessions);

  /** Reopens a saved conversation, or switches to it if it's already open here. */
  const resumePast = (ps: PastSession) => {
    const open = list.find((x) => x.info.agent === ps.agent && (x.nativeId ?? x.info.nativeId) === ps.id);
    if (open) { setActiveId(open.info.id); setShowSettings(false); return; }
    if (ps.liveElsewhere && !window.confirm(`“${ps.title}” looks like it's running somewhere else right now (it changed in the last minute). Opening it here too can mix up the two. Open anyway?`)) return;
    start(ps.agent, { cwd: ps.cwd, resumeId: ps.id });
  };
  const openCloud = (link: string) => start("claude", { cwd: home || cwd, cloud: link });
  const empty = active ? (
    <div className="empty-state">
      <Mascot pack={pack} state="idle" size={120} />
      <h1>What should we work on?</h1>
    </div>
  ) : (
    <>
      <HomeScreen home={home} past={past} loading={pastLoading} usage={usage} lastAgent={settings.defaultAgent === "last" ? lastAgent : settings.defaultAgent}
        onOpenFolder={() => window.agents.pickFolder()}
        onStart={(a, folder, prompt) => { start(a, { cwd: folder, prompt: prompt || undefined }); }}
        onResume={resumePast} />
      {startError && <div className="error-banner home-error" role="alert">{startError}</div>}
    </>
  );

  const sessionLabel = (s: Session) => s.title ?? `${AGENT_NAMES[s.info.agent]} session`;

  return (
    <div className={`app ${layout.left ? "" : "no-left"} ${!active || showSettings ? "no-rail" : layout.right ? "" : "slim-right"}`}
      data-skin={settings.skin === "agent" ? agent : settings.skin}
      style={{ "--agent-claude": settings.agentColors.claude, "--agent-codex": settings.agentColors.codex, "--agent-grok": settings.agentColors.grok } as React.CSSProperties}>
      {layout.left ? (
        <aside className="sidebar">
          <div className="sidebar-head">
            <div className="brand">Agent Zoo</div>
            <button className="icon-btn" onClick={() => setLayout({ left: false })} aria-label="Hide the sessions panel" title="Hide the sessions panel">«</button>
          </div>
          <button className="new-session" onClick={() => { setActiveId(null); setShowSettings(false); }}>+ New session</button>
          <SessionSidebar sessions={list} past={past} activeId={activeId} expanded={expanded} setExpanded={setExpanded} label={sessionLabel}
            onSelect={(id) => { setActiveId(id); setShowSettings(false); }} onClose={closeSession}
            onResume={resumePast} onOpenCloud={openCloud} onCloudTask={setCloudTask} />
          <button className={`profile-row ${showSettings ? "on" : ""}`} onClick={() => setShowSettings(!showSettings)} title="Settings">
            <span className="avatar" aria-hidden="true">{initials(settings.displayName || user)}</span>
            <span className="profile-name">{settings.displayName || user || "You"}</span>
            <span className="profile-gear" aria-hidden="true">⚙</span>
          </button>
        </aside>
      ) : (
        <aside className="sidebar-slim">
          <button className="icon-btn" onClick={() => setLayout({ left: true })} aria-label="Show the sessions panel" title="Show the sessions panel">»</button>
          <button className="icon-btn" onClick={() => { setActiveId(null); setShowSettings(false); }} aria-label="New session" title="New session">+</button>
          {list.map((s) => (
            <button key={s.info.id} className={`slim-session ${s.info.id === activeId ? "active" : ""}`} onClick={() => { setActiveId(s.info.id); setShowSettings(false); }} title={`${sessionLabel(s)} · ${s.info.cwd}`}>
              <span className={`dot agent-${s.info.agent} ${s.status}`} aria-hidden="true" />
            </button>
          ))}
          <button className="avatar slim-avatar" onClick={() => setShowSettings(!showSettings)} title="Settings" aria-label="Settings">{initials(settings.displayName || user)}</button>
        </aside>
      )}

      <main className="main" ref={mainRef}>
        {showSettings ? (
          <SettingsPage settings={settings} onChange={setSettings} user={user} version={appVersion} usage={usage} onClose={() => setShowSettings(false)} />
        ) : <>
        {active && (
          <header className="topbar">
            <div className="title"><strong>{active.info.title}</strong><span className="muted">{active.info.cwd}</span></div>
            <div className="chips">
              <div className="view-toggle" role="tablist" aria-label="View">
                {(["gui", "terminal"] as const).map((v) => (
                  <button key={v} role="tab" aria-selected={active.view === v} disabled={(active.view !== v && active.running) || (v === "gui" && Boolean(active.info.cloud))}
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
          <div className="composer-dock" ref={dockRef}>
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
          </div>
        )}
        </>}
        </>}
      </main>

      {active && !showSettings && layout.right && (
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
      {active && !showSettings && !layout.right && (
        <aside className="rail-slim">
          <button className="icon-btn" onClick={() => setLayout({ right: true })} aria-label="Show the details panel" title="Show the details panel">«</button>
        </aside>
      )}
      {cloudTask && <CloudTask task={cloudTask} onPickFolder={() => window.agents.pickFolder()} onClose={() => setCloudTask(null)} />}
    </div>
  );
}
