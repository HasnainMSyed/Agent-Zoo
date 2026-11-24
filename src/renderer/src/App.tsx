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
import { FilesPane } from "./components/FilesPane";
import { BrowserPane } from "./components/BrowserPane";

/** The side tools beside the chat (like Claude's desktop app): one shows at a time. */
type Tool = "terminal" | "files" | "browser";
const TOOLS: { id: Tool; label: string; icon: React.ReactNode }[] = [
  { id: "terminal", label: "Terminal", icon: <path d="M5 7l5 5-5 5M12 17h7" /> },
  { id: "files", label: "Files", icon: <path d="M4 6.5A1.5 1.5 0 0 1 5.5 5H10l2 2h6.5A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" /> },
  { id: "browser", label: "Browser", icon: <><circle cx="12" cy="12" r="8" /><path d="M4 12h16M12 4c2.5 2.6 2.5 13.4 0 16M12 4c-2.5 2.6-2.5 13.4 0 16" /></> },
];
import { Subagents, subagentsOf } from "./components/Subagents";
import { applySettings, loadSettings, saveSettings, type Settings } from "./settings";
import { CODEX_PANELS, type PanelKind, type PastSession, type UsageLimits } from "@shared/commands";
import { TerminalView, clearTerminalBuffer } from "./components/TerminalView";
import { VOICE } from "./voice";
import { desktopAlert, playSound, type AlertKind } from "./alerts";
import { CommandPalette, type PaletteItem } from "./components/CommandPalette";
import logoUrl from "./assets/prompt-habitat-logo.png";

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
function ElsewhereDialog({ p, onBring, onCopy, onAnyway, onCancel }: { p: PastSession; onBring: () => void; onCopy: () => void; onAnyway: () => void; onCancel: () => void }) {
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
        <button className="choice" onClick={onCopy}>
          <strong>Open a copy</strong>
          <span>Starts a separate copy here with everything so far. The other one carries on untouched, and the two go their own ways.</span>
        </button>
        <button className="choice" onClick={onAnyway}>
          <strong>Open here too</strong>
          <span>Both copies keep running. What you send in one won't show up in the other.</span>
        </button>
      </div>
    </div>
  );
}

type UpdateInfo = Awaited<ReturnType<typeof window.agents.updateState>>;
const REOPEN_KEY = "zoo.reopenAfterUpdate";

/** "A new version is ready": waits for working agents, then restarts into it. */
function UpdatePrompt({ update, busy, extras, waiting, onUpdate, onCancel, onLater }: {
  update: UpdateInfo; busy: number; extras: string[]; waiting: boolean;
  onUpdate: () => void; onCancel: () => void; onLater: () => void;
}) {
  return (
    <div className="update-toast" role="status" aria-live="polite">
      <div className="update-icon" aria-hidden="true">↑</div>
      <div className="update-text">
        {waiting ? <>
          <strong>Updating once your agents finish</strong>
          <span>{busy} {busy === 1 ? "agent is" : "agents are"} still working. Prompt Habitat restarts into {update.version} as soon as {busy === 1 ? "it's" : "they're"} done, and your sessions reopen.</span>
        </> : <>
          <strong>Prompt Habitat {update.version} is ready</strong>
          <span>Restarts in a moment and reopens your sessions where they were.{busy ? ` It waits for ${busy === 1 ? "the agent that's" : `the ${busy} agents that are`} working.` : ""}</span>
          {extras.map((x) => <span key={x} className="update-extra">{x}</span>)}
        </>}
        <div className="update-actions">
          {waiting
            ? <><button className="btn-small" onClick={onCancel}>Cancel</button></>
            : <><button className="btn-primary" onClick={onUpdate}>Update</button><button className="btn-ghost" onClick={onLater}>Later</button></>}
        </div>
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
  // The session whose Terminal view was opened to talk (shows how voice works there).
  const [voiceHint, setVoiceHint] = useState<string | null>(null);
  const drafts = useRef(new Map<string, string>());
  // A new version of the app: what's downloaded, whether it's put off till later, and whether it's waiting for agents.
  const [update, setUpdate] = useState<UpdateInfo>({ status: "idle" });
  const [updateLater, setUpdateLater] = useState(false);
  const [updateWaiting, setUpdateWaiting] = useState(false);
  useEffect(() => { window.agents.updateState().then(setUpdate).catch(() => {}); return window.agents.onUpdate(setUpdate); }, []);
  const [bringing, setBringing] = useState<Record<string, { p: PastSession; status: string }>>({});
  // The Terminal pane: shells per session, whether it's showing, and its width.
  const [shells, setShells] = useState<ShellState>({});
  const shellsRef = useRef(shells);
  shellsRef.current = shells;
  const [pane, setPane] = useState<Tool | null>(null);
  const paneOpen = pane !== null;
  const setPaneOpen = (open: boolean) => setPane(open ? "terminal" : null);
  // Which tools have been opened (they stay mounted after, so their state survives hiding).
  const [toolsUsed, setToolsUsed] = useState<Tool[]>([]);
  useEffect(() => { if (pane && !toolsUsed.includes(pane)) setToolsUsed([...toolsUsed, pane]); }, [pane]); // eslint-disable-line react-hooks/exhaustive-deps
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

  const start = useCallback(async (agent: AgentId, opts: { cwd?: string; prompt?: string; resumeId?: string; cloud?: string; fork?: boolean } = {}) => {
    setStartError("");
    try {
      const info = await window.agents.createSession(agent, opts.cwd ?? cwd, opts.resumeId, agent === "claude" ? settings.claudeMode : undefined, opts.cloud, opts.fork);
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
  const voice = VOICE[agent];

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
      if (typeof window.agents.setView !== "function") throw new Error("Prompt Habitat was updated while it was open. Quit it and start it again to finish updating.");
      await window.agents.setView(id, view, undefined, undefined, typeOnOpen);
    } catch (err) { showError(id, err); }
  };
  const runCommand = (id: string, cmd: SessionCommand) => { window.agents.command(id, cmd).catch((err) => showError(id, err)); };
  const closeSession = (id: string) => {
    drafts.current.delete(id);
    window.agents.closeSession(id).then(() => refreshPast()); // also ends its shells
    setShells((prev) => { const next = { ...prev }; delete next[id]; return next; });
    setSessions((prev) => { const next = { ...prev }; delete next[id]; return next; });
    if (activeId === id) setActiveId(null);
  };

  const list = Object.values(sessions);

  // Alerts: an agent finished, stopped with an error, or is waiting on you. "When I'm away" means the
  // window isn't focused, or you're looking at a different session.
  const lastState = useRef(new Map<string, { running: boolean; status: string }>());
  useEffect(() => {
    for (const s of list) {
      const prev = lastState.current.get(s.info.id);
      lastState.current.set(s.info.id, { running: s.running, status: s.status });
      if (!prev || s.view !== "gui" || settings.alerts === "off") continue;
      const kind: AlertKind | null = s.status === "waiting" && prev.status !== "waiting" ? "input"
        : prev.running && !s.running && !s.exited ? (s.status === "error" ? "error" : "done") : null;
      if (!kind) continue;
      const away = !document.hasFocus() || s.info.id !== activeId || showSettings;
      if (settings.alerts === "background" && !away) continue;
      playSound(settings.sound, kind);
      const id = s.info.id;
      desktopAlert(kind, AGENT_NAMES[s.info.agent], `${sessionLabel(s)} · ${s.info.cwd.split("/").filter(Boolean).pop() ?? s.info.cwd}`, () => {
        window.agents.focusWindow();
        setActiveId(id); setShowSettings(false);
      });
    }
    for (const id of [...lastState.current.keys()]) if (!sessions[id]) lastState.current.delete(id);
  }, [sessions]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Back from an update: every session that was open starts again, the one you were in last.
    let after: { keys: string[]; active: string | null } | null = null;
    try { after = JSON.parse(localStorage.getItem(REOPEN_KEY) ?? "null"); localStorage.removeItem(REOPEN_KEY); } catch { /* none */ }
    if (after?.keys.length && !list.length && !autoStart) {
      const order = [...after.keys.filter((k) => k !== after!.active), ...(after.active && after.keys.includes(after.active) ? [after.active] : [])];
      (async () => { for (const k of order) { const p = past.find((x) => keyOf(x) === k); if (p) await start(p.agent, { cwd: p.cwd, resumeId: p.id }); } })();
      return;
    }
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

  // Updating: wait until no agent is mid-turn, note which sessions to reopen, then restart.
  const busyCount = list.filter((x) => x.running).length;
  const installNow = () => {
    const keys = list.map(nativeKey).filter((k): k is string => Boolean(k));
    try { localStorage.setItem(REOPEN_KEY, JSON.stringify({ keys, active: active ? nativeKey(active) : null })); } catch { /* storage unavailable */ }
    window.agents.updateInstall().catch((err) => { setUpdateWaiting(false); setStartError(err instanceof Error ? err.message : String(err)); });
  };
  useEffect(() => { if (updateWaiting && busyCount === 0) installNow(); }, [updateWaiting, busyCount]); // eslint-disable-line react-hooks/exhaustive-deps
  const updateExtras = [
    ...(Object.values(shells).some((x) => x.list.some((sh) => !sh.exited)) ? ["Open terminals in the Terminal pane will close."] : []),
    ...(list.some((x) => x.view === "terminal") ? ["Sessions in Terminal view reopen in Chat."] : []),
  ];

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

  // The command palette (Ctrl+K, or Ctrl+Shift+P).
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && ((e.key.toLowerCase() === "k" && !e.shiftKey) || (e.key.toLowerCase() === "p" && e.shiftKey))) { e.preventDefault(); setPalette((p) => !p); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const paletteItems = (): PaletteItem[] => {
    const folderOf = (cwd: string) => cwd.split("/").filter(Boolean).pop() ?? cwd;
    const items: PaletteItem[] = [];
    for (const x of list) items.push({ id: `s:${x.info.id}`, group: "Open sessions", label: sessionLabel(x), hint: `${AGENT_NAMES[x.info.agent]} · ${folderOf(x.info.cwd)}`, run: () => selectSession(x.info.id) });
    for (const p of dormant) items.push({ id: `k:${keyOf(p)}`, group: "Open sessions", label: p.title, hint: `${AGENT_NAMES[p.agent]} · ${folderOf(p.cwd)} · asleep`, run: () => resumePast(p) });
    const act = (id: string, label: string, run: () => void, hint?: string, keywords?: string) => items.push({ id: `a:${id}`, group: "Actions", label, run, hint, keywords });
    act("new", "New session", () => { setActiveId(null); setShowSettings(false); }, undefined, "home start");
    act("folder", "Open a folder…", async () => { const f = await window.agents.pickFolder(); if (f) start(leadAgent, { cwd: f }); }, `with ${AGENT_NAMES[leadAgent]}`, "project new");
    act("browse", browsing ? "Hide all sessions" : "Show all sessions", () => setBrowsing(!browsing), undefined, "history past saved drawer");
    if (active) {
      for (const t of TOOLS) act(`tool-${t.id}`, pane === t.id ? `Hide the ${t.label.toLowerCase()}` : `Show the ${t.label.toLowerCase()}`, () => setPane(pane === t.id ? null : t.id), "side panel");
      if (!active.info.cloud) act("view", active.view === "gui" ? "Switch to Terminal view" : "Switch to Chat view", () => switchView(active.info.id, active.view === "gui" ? "terminal" : "gui"), undefined, "tui");
      if (active.running) act("stop", "Stop the agent", stop, "Esc", "interrupt cancel");
      const nid = active.nativeId ?? active.info.nativeId;
      if (nid && active.info.agent !== "grok" && !active.info.cloud && active.items.length) {
        act("copy", "Open a copy of this conversation", () => start(active.info.agent, { cwd: active.info.cwd, resumeId: nid, fork: true }), "a separate branch", "fork duplicate branch clone");
      }
      act("close", "Remove this session from the sidebar", () => removeOpen(active.info.id), undefined, "close end");
    }
    act("left", layout.left ? "Hide the sessions panel" : "Show the sessions panel", () => setLayout({ left: !layout.left }), undefined, "sidebar");
    if (active) act("right", railOpen ? "Hide the details panel" : "Show the details panel", () => setLayout({ right: !railOpen }), undefined, "usage plan subagents rail");
    act("settings", "Settings", () => setShowSettings(true), undefined, "preferences options");
    for (const t of ["system", "light", "dark"] as const) if (settings.theme !== t) act(`theme-${t}`, `Theme: ${t[0]!.toUpperCase()}${t.slice(1)}`, () => setSettings({ ...settings, theme: t }), undefined, "appearance mode");
    act("alerts", settings.alerts === "off" ? "Turn desktop alerts on" : "Turn desktop alerts off", () => setSettings({ ...settings, alerts: settings.alerts === "off" ? "background" : "off" }), undefined, "notifications");
    // Project folders: start any agent there.
    const folders = [...new Map(past.filter((p) => !p.cloud).map((p) => [p.cwd, p])).keys()].slice(0, 40);
    for (const f of folders) for (const a of ["claude", "codex", "grok"] as const) {
      items.push({ id: `f:${a}:${f}`, group: "Start in a folder", label: `${AGENT_NAMES[a]} in ${folderOf(f)}`, hint: f, searchOnly: true, run: () => start(a, { cwd: f }) });
    }
    for (const p of past) if (!list.some((x) => nativeKey(x) === keyOf(p)) && !dormant.includes(p)) {
      items.push({ id: `p:${keyOf(p)}`, group: "Saved conversations", label: p.title, hint: `${AGENT_NAMES[p.agent]} · ${folderOf(p.cwd)}`, searchOnly: true, run: () => resumePast(p) });
    }
    return items;
  };

  return (
    <div className={`app ${layout.left ? "" : "no-left"} ${!active || showSettings ? "no-rail" : railOpen ? "" : "slim-right"}`}
      data-skin={settings.skin === "agent" ? agent : settings.skin}
      style={{ "--agent-claude": settings.agentColors.claude, "--agent-codex": settings.agentColors.codex, "--agent-grok": settings.agentColors.grok } as React.CSSProperties}>
      {layout.left ? (
        <aside className="sidebar">
          <div className="sidebar-head">
            <div className="brand"><img src={logoUrl} alt="" width={32} height={32} />Prompt Habitat</div>
            <button className="icon-btn" onClick={() => setPalette(true)} aria-label="Search (Ctrl+K)" title="Search sessions, folders and actions (Ctrl+K)">⌕</button>
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
              <span className="topbar-tools" role="toolbar" aria-label="Side tools">
                {TOOLS.map((t) => (
                  <button key={t.id} className={`tool-btn ${pane === t.id ? "on" : ""}`} aria-pressed={pane === t.id} onClick={() => setPane(pane === t.id ? null : t.id)}
                    title={pane === t.id ? `Hide the ${t.label.toLowerCase()}` : t.id === "terminal" ? `Open a terminal in ${active.info.cwd}` : t.id === "files" ? `Files in ${active.info.cwd}` : "Open a browser beside the chat"}
                    aria-label={t.label}>
                    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{t.icon}</svg>
                  </button>
                ))}
              </span>
            </div>
          </header>
        )}
        {active?.view === "terminal" && voiceHint === active.info.id && voice && (
          <div className="voice-hint" role="status">
            <span className="voice-dot" aria-hidden="true" />
            <span>{voice.terminal.hint}</span>
            <button className="icon-btn" onClick={() => setVoiceHint(null)} aria-label="Dismiss">×</button>
          </div>
        )}
        {active?.view === "terminal" ? <TerminalView key={active.info.id} sessionId={active.info.id} /> : <>
        {active ? <Transcript items={active.items} onDecide={decide} empty={empty} /> : <div className="home-scroll">{empty}</div>}
        {active && (
          <div className="composer-dock" ref={dockRef}>
          <Composer key={active.info.id} running={active.running} disabled={active.exited} onSend={send} onStop={stop}
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
            draft={drafts.current.get(active.info.id) ?? ""}
            onDraft={(text) => drafts.current.set(active.info.id, text)} voice={voice}
            onVoiceTerminal={async () => {
              const id = active.info.id;
              try {
                if (active.info.agent === "codex") await window.agents.openCodexVoice(id);
                else {
                  const typed = await voice?.terminal.typeOnOpen?.().catch(() => undefined);
                  await switchView(id, "terminal", typed);
                }
                setVoiceHint(id);
              } catch (err) { showError(id, err); }
            }}
            mascot={<Mascot pack={pack} state={active.status} size={56} />}
            status={active.exited ? "Session ended" : mascotLabel(active.status)} />
          </div>
        )}
        </>}
        </>}
        </div>
        {toolsUsed.includes("files") && (
          <FilesPane visible={paneVisible && pane === "files"} sessionId={active && !active.info.cloud ? active.info.id : null} folder={active?.info.cwd ?? ""}
            refreshKey={`${active?.info.id}:${active?.running}`} width={paneWidth} setWidth={setPaneWidth} onHide={() => setPane(null)} />
        )}
        {toolsUsed.includes("browser") && <BrowserPane visible={paneVisible && pane === "browser"} width={paneWidth} setWidth={setPaneWidth} onHide={() => setPane(null)} />}
        {Object.keys(shells).length > 0 || (pane === "terminal" && active) ? (
          <ShellPane visible={paneVisible && pane === "terminal"} state={shells} sessionId={active?.info.id ?? null}
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
      {palette && <CommandPalette items={paletteItems()} onClose={() => setPalette(false)} />}
      {update.status === "ready" && !updateLater && (
        <UpdatePrompt update={update} busy={busyCount} extras={updateExtras} waiting={updateWaiting}
          onUpdate={() => (busyCount ? setUpdateWaiting(true) : installNow())}
          onCancel={() => setUpdateWaiting(false)} onLater={() => setUpdateLater(true)} />
      )}
      {elsewhere && (
        <ElsewhereDialog p={elsewhere} onCancel={() => setElsewhere(null)}
          onBring={() => { const p = elsewhere; setElsewhere(null); bringHere(p); }}
          onCopy={() => { const p = elsewhere; setElsewhere(null); start(p.agent, { cwd: p.cwd, resumeId: p.id, fork: true }); }}
          onAnyway={() => { const p = elsewhere; setElsewhere(null); start(p.agent, { cwd: p.cwd, resumeId: p.id }); }} />
      )}
      {cloudTask && <CloudTask task={cloudTask} onPickFolder={() => window.agents.pickFolder()} onClose={() => setCloudTask(null)} />}
    </div>
  );
}
