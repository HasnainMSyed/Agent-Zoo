import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentEvent, AgentId, PermissionOption, SessionCommand } from "@shared/events";
import { apply, newSession, type Session } from "./state";
import type React from "react";
import { allPacks, packFor, setChosenMascots, setUserPacks, type MascotPack } from "./mascots";
import { makeMascotPrompt } from "./mascots/make-prompt";
import { Mascot, mascotLabel } from "./components/Mascot";
import { Transcript } from "./components/Transcript";
import { Composer } from "./components/Composer";
import { HomeScreen } from "./components/HomeScreen";
import { UsageDetails } from "./components/Usage";
import { CommandPanel, modeLabel } from "./components/Panels";
import { SettingsPage, initials } from "./components/SettingsPage";
import { CloudTask, SessionBrowser, SessionNav, useDropTarget, type DragLoad } from "./components/SessionSidebar";
import { ShellPane, type ShellState } from "./components/ShellPane";
import { Subagents, subagentsOf } from "./components/Subagents";
import { applySettings, loadSettings, saveSettings, type Settings } from "./settings";
import { CODEX_PANELS, type PanelKind, type PastSession, type UsageLimits } from "@shared/commands";
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

const keyOf = (p: { agent: AgentId; id: string }) => `${p.agent}:${p.id}`;
const nativeKey = (s: Session) => { const id = s.nativeId ?? s.info.nativeId; return id && !s.info.cloud ? keyOf({ agent: s.info.agent, id }) : null; };
const LIVE_STATUS: Record<string, string> = {
  busy: "It's working on something right now.",
  idle: "It's idle, waiting for its next message.",
  waiting: "It's waiting for an answer in that window.",
};

/** A conversation you're opening is running somewhere else (a terminal, an editor). */
function ElsewhereDialog({ p, onBring, onAnyway, onCancel }: { p: PastSession; onBring: () => void; onAnyway: () => void; onCancel: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onCancel]);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal elsewhere-dialog" role="dialog" aria-label="Open elsewhere" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div><strong>“{p.title}” is open somewhere else</strong>
            <p className="muted small">{LIVE_STATUS[p.liveStatus ?? ""] ?? "Another program has it open right now."}</p></div>
          <button className="icon-btn" onClick={onCancel} aria-label="Cancel">×</button>
        </div>
        <button className="choice primary" autoFocus onClick={onBring}>
          <strong>Bring it here</strong>
          <span>Closes the other copy as soon as it finishes what it's doing, then carries on here with everything it did.</span>
        </button>
        <button className="choice" onClick={onAnyway}>
          <strong>Open here too</strong>
          <span>Both copies keep running. What you send in one won't show up in the other.</span>
        </button>
      </div>
    </div>
  );
}

export function App() {
  const [layoutState, setLayoutState] = usePersisted("zoo.layout", { left: true, right: true });
  const layout = layoutState;
  const setLayout = (patch: Partial<typeof layoutState>) => setLayoutState({ ...layoutState, ...patch });
  const [folded, setFolded] = usePersisted<string[]>("zoo.folded", []);
  const [expanded, setExpanded] = usePersisted<string[]>("zoo.expandedFolders", []);
  const [pinned, setPinned] = usePersisted<string[]>("zoo.pinnedFolders", []);
  const [navFolded, setNavFolded] = usePersisted<string[]>("zoo.navFolded", []);
  // Sessions you've opened stay in the sidebar across restarts (asleep until clicked) until you
  // remove them; removed ones also drop out of pinned folders' lists. Keys are "agent:id".
  const [kept, setKept] = usePersisted<string[]>("zoo.keptSessions", []);
  const [hidden, setHidden] = usePersisted<string[]>("zoo.hiddenSessions", []);
  const [lastOpen, setLastOpen] = usePersisted<string | null>("zoo.lastSession", null);
  // "Open elsewhere": the question being asked, and conversations waiting to be brought here.
  const [elsewhere, setElsewhere] = useState<PastSession | null>(null);
  const [bringing, setBringing] = useState<Record<string, { p: PastSession; status: string }>>({});
  // The Terminal pane: shells per session, whether it's showing, and its width.
  const [shells, setShells] = useState<ShellState>({});
  const shellsRef = useRef(shells);
  shellsRef.current = shells;
  const [paneOpen, setPaneOpen] = useState(false);
  const [paneWidth, setPaneWidth] = usePersisted("zoo.paneWidth", 460);
  // With the terminal open the details panel steps aside (slim), unless you bring it back.
  const [railWithPane, setRailWithPane] = useState(false);
  useEffect(() => { if (!paneOpen) setRailWithPane(false); }, [paneOpen]);
  const [cloudTask, setCloudTask] = useState<PastSession | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [home, setHome] = useState("");
  const [startError, setStartError] = useState("");
  const [past, setPast] = useState<PastSession[]>([]);
  const [pastLoading, setPastLoading] = useState(true);
  const [usage, setUsage] = useState<Partial<Record<AgentId, UsageLimits>>>({});
  const [settings, setSettingsState] = useState<Settings>(loadSettings);
  // Colour changes blend by themselves: the colour tokens are animatable (see "Theme blend" in styles.css).
  const setSettings = (s: Settings) => { setSettingsState(s); saveSettings(s); };
  useLayoutEffect(() => { applySettings(settings); }, [settings]);
  // Mascot packs: the user's own (from the app's data folder) plus the choice per agent.
  const [packs, setPacks] = useState<MascotPack[]>(allPacks);
  const loadPacks = useCallback(() => {
    window.agents.mascots.list().then((raw) => { setUserPacks(raw as MascotPack[]); setPacks(allPacks()); }).catch(() => {});
  }, []);
  useEffect(() => { loadPacks(); return window.agents.mascots.onChanged(loadPacks); }, [loadPacks]);
  setChosenMascots(settings.mascots);
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
    if (id.startsWith("util-") && e.kind === "exited") {
      setShells((prev) => {
        const sid = Object.keys(prev).find((k) => prev[k]!.list.some((x) => x.id === id));
        return sid ? { ...prev, [sid]: { ...prev[sid]!, list: prev[sid]!.list.map((x) => (x.id === id ? { ...x, exited: true } : x)) } } : prev;
      });
    }
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
  // With no session open, the app wears the lead agent's colours (the biggest mascot on the home screen).
  const leadAgent: AgentId = settings.defaultAgent === "last" ? lastAgent : settings.defaultAgent;
  const agent: AgentId = active?.info.agent ?? leadAgent;
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
    window.agents.closeSession(id).then(() => refreshPast()); // also ends its shells
    setShells((prev) => { const next = { ...prev }; delete next[id]; return next; });
    setSessions((prev) => { const next = { ...prev }; delete next[id]; return next; });
    if (activeId === id) setActiveId(null);
  };

  const list = Object.values(sessions);

  // Every session opened here joins the sidebar's kept list (once its agent has given it an id).
  useEffect(() => {
    const live = list.map(nativeKey).filter((k): k is string => Boolean(k));
    const add = live.filter((k) => !kept.includes(k));
    if (add.length) setKept([...kept, ...add]);
    if (hidden.some((k) => live.includes(k))) setHidden(hidden.filter((k) => !live.includes(k)));
    const cur = active ? nativeKey(active) : null;
    if (cur && cur !== lastOpen) setLastOpen(cur);
  }, [sessions, activeId]); // eslint-disable-line react-hooks/exhaustive-deps
  // At launch, pick up where you left off: the session you were last in starts again by itself.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || pastLoading || !cwd) return;
    restored.current = true;
    const last = settings.reopenLast && lastOpen && kept.includes(lastOpen) ? past.find((p) => keyOf(p) === lastOpen) : undefined;
    if (last && !last.liveElsewhere && !list.length && !autoStart) start(last.agent, { cwd: last.cwd, resumeId: last.id });
  }, [pastLoading, cwd]); // eslint-disable-line react-hooks/exhaustive-deps
  const dormant = kept.map((k) => past.find((p) => keyOf(p) === k)).filter((p): p is PastSession => Boolean(p) && !list.some((s) => nativeKey(s) === keyOf(p!)));
  /** Takes a conversation off the sidebar (it stays in All sessions). */
  const forget = (key: string) => {
    setKept(kept.filter((k) => k !== key));
    if (!hidden.includes(key)) setHidden([...hidden, key]);
    if (lastOpen === key) setLastOpen(null);
  };
  const removeOpen = (id: string) => { const s = sessions[id]; const k = s && nativeKey(s); closeSession(id); if (k) forget(k); };

  // Bringing a conversation here: wait for the other copy to finish its turn, close it, reopen it here.
  useEffect(() => window.agents.onTakeOverWaiting((id, status) => setBringing((prev) => {
    const k = Object.keys(prev).find((x) => prev[x]!.p.id === id);
    return k ? { ...prev, [k]: { ...prev[k]!, status } } : prev;
  })), []);
  const stopBringing = (k: string) => setBringing((prev) => { const next = { ...prev }; delete next[k]; return next; });
  const bringHere = async (p: PastSession, now = false) => {
    const k = keyOf(p);
    setBringing((prev) => ({ ...prev, [k]: { p, status: prev[k]?.status ?? p.liveStatus ?? "busy" } }));
    try { await window.agents.takeOver(p.id, now); }
    catch (err) {
      const msg = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);
      if (!/Cancelled/.test(msg)) { stopBringing(k); setStartError(msg); } // a cancelled wait was replaced or stopped
      return;
    }
    stopBringing(k);
    await start(p.agent, { cwd: p.cwd, resumeId: p.id });
    refreshPast();
  };

  /** Reopens a saved conversation, or switches to it if it's already open here. */
  const resumePast = (ps: PastSession) => {
    const open = list.find((x) => x.info.agent === ps.agent && (x.nativeId ?? x.info.nativeId) === ps.id);
    if (open) { setActiveId(open.info.id); setShowSettings(false); return; }
    if (bringing[keyOf(ps)]) return; // already on its way here
    if (ps.liveElsewhere) { setElsewhere(ps); return; }
    start(ps.agent, { cwd: ps.cwd, resumeId: ps.id });
  };
  /** Opens several saved conversations (Select mode, or a drop on the sidebar), asking once about any running elsewhere. */
  const openMany = async (todo: PastSession[]) => {
    if (todo.length === 1) { resumePast(todo[0]!); return; }
    let fresh = todo.filter((p) => !list.some((x) => x.info.agent === p.agent && (x.nativeId ?? x.info.nativeId) === p.id));
    if (!fresh.length) return;
    if (fresh.length > 6 && !window.confirm(`Open ${fresh.length} sessions? Each one starts its agent.`)) return;
    const elsewhere = fresh.filter((p) => p.liveElsewhere && !bringing[keyOf(p)]);
    if (elsewhere.length) {
      fresh = fresh.filter((p) => !p.liveElsewhere);
      if (window.confirm(`${elsewhere.length} of these are open somewhere else right now. Bring them here? Each one closes there as soon as it finishes what it's doing. (Cancel opens just the others.)`)) elsewhere.forEach((p) => bringHere(p));
    }
    for (const p of fresh) await start(p.agent, { cwd: p.cwd, resumeId: p.id });
  };
  /** A drop from the drawer: folders get pinned (and unfolded), conversations open. */
  const onDropLoad = (load: DragLoad) => {
    if (load.folders.length) {
      setPinned([...new Set([...pinned, ...load.folders])]);
      setNavFolded(navFolded.filter((k) => !load.folders.includes(k)));
    }
    const todo = load.sessions.map((x) => past.find((p) => p.agent === x.agent && p.id === x.id)).filter((p): p is PastSession => Boolean(p));
    if (todo.length) openMany(todo);
  };
  const slimDrop = useDropTarget(onDropLoad);
  const selectSession = (id: string) => { setActiveId(id); setShowSettings(false); };
  const newShell = useCallback(async () => {
    const sid = activeId;
    if (!sid) return;
    try {
      const id = await window.agents.shellOpen(sid);
      setShells((prev) => {
        const cur = prev[sid] ?? { list: [], current: null };
        const name = sessionsRef.current[sid]?.info.cwd.split(/[\\/]/).filter(Boolean).pop() ?? "shell";
        const n = cur.list.length ? ` ${cur.list.length + 1}` : "";
        return { ...prev, [sid]: { list: [...cur.list, { id, label: name + n }], current: id } };
      });
    } catch (err) { showError(sid, err); setPaneOpen(false); }
  }, [activeId]);
  const closeShell = (id: string) => {
    window.agents.shellClose(id);
    setShells((prev) => {
      const next: ShellState = {};
      for (const [sid, v] of Object.entries(prev)) {
        const rest = v.list.filter((x) => x.id !== id);
        next[sid] = { list: rest, current: v.current === id ? rest[rest.length - 1]?.id ?? null : v.current };
      }
      return next;
    });
    if (activeId && shellsRef.current[activeId]?.list.length === 1 && shellsRef.current[activeId]!.list[0]!.id === id) setPaneOpen(false);
  };
  const openCloud = (link: string) => start("claude", { cwd: home || cwd, cloud: link });
  const empty = active ? (
    <div className="empty-state">
      <Mascot pack={pack} state="idle" size={120} />
      <h1>What should we work on?</h1>
    </div>
  ) : (
    <>
      <HomeScreen home={home} past={past} loading={pastLoading} usage={usage} lastAgent={leadAgent}
        onPickLead={(a) => { setLastAgent(a); if (settings.defaultAgent !== "last") setSettings({ ...settings, defaultAgent: a }); }}
        onOpenFolder={() => window.agents.pickFolder()}
        onStart={(a, folder, prompt) => { start(a, { cwd: folder, prompt: prompt || undefined }); }}
        onResume={resumePast} />
      {startError && <div className="error-banner home-error" role="alert">{startError}</div>}
    </>
  );

  const paneVisible = paneOpen && Boolean(active) && !showSettings;
  const railOpen = layout.right && (!paneVisible || railWithPane);
  const sessionLabel = (s: Session) => s.title ?? `${AGENT_NAMES[s.info.agent]} session`;

  return (
    <div className={`app ${layout.left ? "" : "no-left"} ${!active || showSettings ? "no-rail" : railOpen ? "" : "slim-right"}`}
      data-skin={settings.skin === "agent" ? agent : settings.skin}
      style={{ "--agent-claude": settings.agentColors.claude, "--agent-codex": settings.agentColors.codex, "--agent-grok": settings.agentColors.grok } as React.CSSProperties}>
      {layout.left ? (
        <aside className="sidebar">
          <div className="sidebar-head">
            <div className="brand">Agent Zoo</div>
            <button className="icon-btn" onClick={() => setLayout({ left: false })} aria-label="Hide the sessions panel" title="Hide the sessions panel">«</button>
          </div>
          <button className="new-session" onClick={() => { setActiveId(null); setShowSettings(false); }}>+ New session</button>
          <SessionNav sessions={list} dormant={dormant} past={past} hidden={hidden} pinned={pinned} folded={navFolded} setFolded={setNavFolded} activeId={activeId} label={sessionLabel} browsing={browsing}
            onResume={resumePast} onUnpin={(path) => setPinned(pinned.filter((p) => p !== path))} onDrop={onDropLoad}
            savedCount={past.filter((p) => !list.some((s) => s.info.agent === p.agent && (s.nativeId ?? s.info.nativeId) === p.id)).length}
            onSelect={selectSession} onClose={removeOpen} onRemove={(p) => forget(keyOf(p))} onBrowse={() => setBrowsing(!browsing)} />
          <button className={`profile-row ${showSettings ? "on" : ""}`} onClick={() => setShowSettings(!showSettings)} title="Settings">
            <span className="avatar" aria-hidden="true">{initials(settings.displayName || user)}</span>
            <span className="profile-name">{settings.displayName || user || "You"}</span>
            <span className="profile-gear" aria-hidden="true">⚙</span>
          </button>
        </aside>
      ) : (
        <aside className={`sidebar-slim drop-zone ${slimDrop.over ? "drop-over" : ""}`} {...slimDrop.props}>
          <button className="icon-btn" onClick={() => setLayout({ left: true })} aria-label="Show the sessions panel" title="Show the sessions panel">»</button>
          <button className="icon-btn" onClick={() => { setActiveId(null); setShowSettings(false); }} aria-label="New session" title="New session">+</button>
          <button className="icon-btn" onClick={() => setBrowsing(!browsing)} aria-label="All sessions" title="All sessions">☰</button>
          {list.map((s) => (
            <button key={s.info.id} className={`slim-session ${s.info.id === activeId ? "active" : ""}`} onClick={() => selectSession(s.info.id)} title={`${sessionLabel(s)} · ${s.info.cwd}`}>
              <span className={`dot agent-${s.info.agent} ${s.status}`} aria-hidden="true" />
            </button>
          ))}
          <button className="avatar slim-avatar" onClick={() => setShowSettings(!showSettings)} title="Settings" aria-label="Settings">{initials(settings.displayName || user)}</button>
        </aside>
      )}

      <main className="main" ref={mainRef}>
        <div className="main-col">
        {startError && active && !showSettings && (
          <div className="bring-list"><div className="bring-error" role="alert"><span className="bring-text">{startError}</span>
            <button className="icon-btn" onClick={() => setStartError("")} aria-label="Dismiss">×</button></div></div>
        )}
        {Object.keys(bringing).length > 0 && !showSettings && (
          <div className="bring-list" role="status">
            {Object.entries(bringing).map(([k, b]) => (
              <div key={k} className="bring-banner">
                <span className="bring-spin" aria-hidden="true" />
                <span className="bring-text"><strong>Bringing “{b.p.title}” here.</strong>{" "}
                  {b.status === "waiting" ? "It's waiting for an answer in its other window; answer it there, or close it now." : b.status === "idle" ? "Closing the other copy…" : "Waiting for it to finish what it's doing…"}</span>
                <button className="btn-small" onClick={() => bringHere(b.p, true)} title="Close the other copy now, even mid-task">Close it now</button>
                <button className="btn-small" onClick={() => { window.agents.takeOverCancel(b.p.id); stopBringing(k); }}>Cancel</button>
              </div>
            ))}
          </div>
        )}
        {showSettings ? (
          <SettingsPage settings={settings} onChange={setSettings} user={user} version={appVersion} usage={usage} onClose={() => setShowSettings(false)}
            packs={packs} onPacksChanged={loadPacks}
            onMakeMascot={async (description) => {
              const folder = await window.agents.mascots.newFolder(description.split(/\s+/).slice(0, 4).join(" "));
              start("claude", { cwd: folder, prompt: makeMascotPrompt(description, folder) });
            }} />
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
              <span className="topbar-tools">
                <button className={`tool-btn ${paneOpen ? "on" : ""}`} aria-pressed={paneOpen} onClick={() => setPaneOpen(!paneOpen)}
                  title={paneOpen ? "Hide the terminal" : `Open a terminal in ${active.info.cwd}`} aria-label="Terminal">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7l5 5-5 5M12 17h7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </span>
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
              else if (cmd.run === "panel") setPanel({ sessionId: active.info.id, kind: active.info.agent === "codex" ? CODEX_PANELS[cmd.name]!.kind : (cmd.name as PanelKind) });
              else runCommand(active.info.id, { kind: "slash", name: cmd.name, args });
            }}
            onPickModel={(model, effort) => runCommand(active.info.id, { kind: "setModel", model, effort })}
            panel={panel?.sessionId === active.info.id
              ? <CommandPanel key={panel.kind} kind={panel.kind} agent={active.info.agent} sessionId={active.info.id} mode={active.permissionMode} onClose={() => setPanel(null)}
                  onTerminal={(typed) => { setPanel(null); switchView(active.info.id, "terminal", typed); }} />
              : undefined}
            modeLabel={active.info.agent === "claude" ? modeLabel(active.permissionMode ?? "default")
              : active.info.agent === "codex" ? `Access: ${modeLabel(active.permissionMode ?? "auto", "codex")}` : undefined}
            onMode={() => setPanel(panel?.kind === "mode" && panel.sessionId === active.info.id ? null : { sessionId: active.info.id, kind: "mode" })}
            mascot={<Mascot pack={pack} state={active.status} size={56} />}
            status={active.exited ? "Session ended" : mascotLabel(active.status)} />
          </div>
        )}
        </>}
        </>}
        </div>
        {Object.keys(shells).length > 0 || (paneOpen && active) ? (
          <ShellPane visible={paneVisible} state={shells} sessionId={active?.info.id ?? null}
            folder={active?.info.cwd ?? ""} width={paneWidth} setWidth={setPaneWidth}
            onNew={newShell} onClose={closeShell} onHide={() => setPaneOpen(false)}
            onPick={(id) => activeId && setShells((prev) => ({ ...prev, [activeId]: { ...prev[activeId]!, current: id } }))} />
        ) : null}
      </main>

      {active && !showSettings && railOpen && (
        <aside className="rail">
          <div className="rail-top"><button className="icon-btn" onClick={() => (paneVisible ? setRailWithPane(false) : setLayout({ right: false }))} aria-label="Hide the details panel" title="Hide the details panel">»</button></div>
          <RailSection title="Usage" id="usage" folded={folded} setFolded={setFolded}
            summary={usage[active.info.agent]?.windows[0] ? `${usage[active.info.agent]!.windows[0]!.usedPct}%` : undefined}>
            <UsageDetails agent={active.info.agent} usage={usage[active.info.agent]} sessionCost={active.usage?.costUsd} />
          </RailSection>
          {(() => {
            const subs = subagentsOf(active.items);
            const running = subs.filter((x) => x.state !== "done" && x.state !== "error").length;
            return (
              <RailSection title="Subagents" id="subagents" folded={folded} setFolded={setFolded}
                summary={subs.length ? (running ? `${running} running` : `${subs.length}`) : undefined}>
                <Subagents list={subs} pack={pack} />
              </RailSection>
            );
          })()}
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
      {active && !showSettings && !railOpen && (
        <aside className="rail-slim">
          <button className="icon-btn" onClick={() => { setLayout({ right: true }); if (paneVisible) setRailWithPane(true); }} aria-label="Show the details panel" title="Show the details panel">«</button>
        </aside>
      )}
      {browsing && (
        <SessionBrowser sessions={list} past={past} activeId={activeId} expanded={expanded} setExpanded={setExpanded} label={sessionLabel}
          onSelect={selectSession} onResume={resumePast} onOpenMany={openMany}
          onPin={(path) => { setPinned([...new Set([...pinned, path])]); setNavFolded(navFolded.filter((k) => k !== path)); }} onOpenCloud={openCloud} onCloudTask={setCloudTask}
          onDismiss={() => setBrowsing(false)} />
      )}
      {elsewhere && (
        <ElsewhereDialog p={elsewhere} onCancel={() => setElsewhere(null)}
          onBring={() => { const p = elsewhere; setElsewhere(null); bringHere(p); }}
          onAnyway={() => { const p = elsewhere; setElsewhere(null); start(p.agent, { cwd: p.cwd, resumeId: p.id }); }} />
      )}
      {cloudTask && <CloudTask task={cloudTask} onPickFolder={() => window.agents.pickFolder()} onClose={() => setCloudTask(null)} />}
    </div>
  );
}
