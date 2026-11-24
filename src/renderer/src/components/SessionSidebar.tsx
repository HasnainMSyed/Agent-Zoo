// Sessions, in two places:
//  - SessionNav (the sidebar): only the sessions open in Agent Zoo, grouped by folder — quick navigation.
//  - SessionBrowser (a drawer that slides out from the sidebar): every conversation the agents have
//    saved, grouped by folder, with search and agent tabs. Picking one opens it and closes the drawer.

import { useEffect, useMemo, useState } from "react";
import type { AgentId } from "@shared/events";
import type { PastSession } from "@shared/commands";
import type { Session } from "../state";
import { AGENT_NAMES, timeAgo } from "./Usage";
import { TerminalView, clearTerminalBuffer } from "./TerminalView";

const PER_FOLDER = 5;
const CLOUD_KEY = "cloud:codex";
const AGENTS: AgentId[] = ["claude", "codex", "grok"];

interface Folder { key: string; name: string; path: string; open: Session[]; past: PastSession[]; latest: number }

const folderName = (cwd: string) => cwd.split("/").filter(Boolean).pop() || cwd;
const folderKey = (s: Session) => (s.info.cloud ? "cloud:claude" : s.info.cwd);

/** Same conversation? Open sessions know their agent's own id once it's assigned. */
const sameConversation = (s: Session, p: PastSession) => s.info.agent === p.agent && (s.nativeId ?? s.info.nativeId) === p.id;

function OpenRow({ s, active, label, onSelect, onClose }: { s: Session; active: boolean; label: string; onSelect: () => void; onClose: () => void }) {
  return (
    <div className={`session-row ${active ? "active" : ""}`}>
      <button onClick={onSelect}>
        <span className={`dot agent-${s.info.agent} ${s.status}`} aria-hidden="true" />
        <span className="session-name">{label}</span>
        <span className="session-agent">{AGENT_NAMES[s.info.agent]}{s.view === "terminal" ? " · Terminal" : ""}</span>
      </button>
      <button className="close" onClick={onClose} aria-label={`Close ${label}`}>×</button>
    </div>
  );
}

/** The sidebar: open sessions only, by folder, plus the button that opens the browser. */
export function SessionNav({ sessions, activeId, label, savedCount, browsing, onSelect, onClose, onBrowse }: {
  sessions: Session[]; activeId: string | null; label: (s: Session) => string; savedCount: number; browsing: boolean;
  onSelect: (id: string) => void; onClose: (id: string) => void; onBrowse: () => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; path: string; items: Session[] }>();
    for (const s of sessions) {
      const key = folderKey(s);
      const g = map.get(key) ?? { name: s.info.cloud ? "Claude cloud" : folderName(s.info.cwd), path: s.info.cwd, items: [] };
      g.items.push(s);
      map.set(key, g);
    }
    return [...map.entries()];
  }, [sessions]);
  return (
    <>
      <button className={`browse-btn ${browsing ? "on" : ""}`} onClick={onBrowse} aria-expanded={browsing}>
        <span aria-hidden="true">☰</span><span className="bb-label">All sessions</span>
        {savedCount > 0 && <span className="bb-count">{savedCount}</span>}
      </button>
      <nav className="session-list" aria-label="Open sessions">
        {groups.length > 0 && <span className="nav-label">Open</span>}
        {groups.map(([key, g]) => (
          <div key={key} className="folder-group">
            <div className="folder-label" title={g.path}>{g.name}</div>
            {g.items.map((s) => <OpenRow key={s.info.id} s={s} active={s.info.id === activeId} label={label(s)} onSelect={() => onSelect(s.info.id)} onClose={() => onClose(s.info.id)} />)}
          </div>
        ))}
        {!groups.length && (
          <div className="nav-empty">
            <p className="muted small">No sessions open.</p>
            <button className="btn-small" onClick={onBrowse}>Browse past sessions</button>
          </div>
        )}
      </nav>
    </>
  );
}

/** The drawer with every saved conversation: search, agent tabs, folders. */
export function SessionBrowser({ sessions, past, activeId, expanded, setExpanded, label, onSelect, onResume, onOpenCloud, onCloudTask, onDismiss }: {
  sessions: Session[]; past: PastSession[]; activeId: string | null;
  expanded: string[]; setExpanded: (v: string[]) => void;
  label: (s: Session) => string;
  onSelect: (id: string) => void; onResume: (p: PastSession) => void; onOpenCloud: (link: string) => void; onCloudTask: (p: PastSession) => void;
  onDismiss: () => void;
}) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"all" | AgentId>("all");
  const [showAll, setShowAll] = useState<string[]>([]);
  const [cloudInput, setCloudInput] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDismiss(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  const counts = useMemo(() => {
    const c: Record<"all" | AgentId, number> = { all: 0, claude: 0, codex: 0, grok: 0 };
    for (const p of past) if (!sessions.some((s) => sameConversation(s, p))) { c.all++; c[p.agent]++; }
    for (const s of sessions) { c.all++; c[s.info.agent]++; }
    return c;
  }, [sessions, past]);

  const folders = useMemo(() => {
    const map = new Map<string, Folder>();
    const get = (key: string, path: string, name = folderName(path)) => {
      let f = map.get(key);
      if (!f) { f = { key, name, path, open: [], past: [], latest: 0 }; map.set(key, f); }
      return f;
    };
    for (const s of sessions) {
      if (tab !== "all" && s.info.agent !== tab) continue;
      const f = get(folderKey(s), s.info.cwd, s.info.cloud ? "Claude cloud" : undefined);
      f.open.push(s); f.latest = Infinity;
    }
    for (const p of past) {
      if (tab !== "all" && p.agent !== tab) continue;
      if (sessions.some((s) => sameConversation(s, p))) continue; // listed as open
      const f = p.cloud ? get(CLOUD_KEY, "Codex Cloud", "Codex Cloud") : get(p.cwd, p.cwd);
      f.past.push(p); f.latest = Math.max(f.latest, p.updatedAt);
    }
    return [...map.values()].sort((a, b) => b.latest - a.latest);
  }, [sessions, past, tab]);

  const q = query.trim().toLowerCase();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);
  const toggle = (key: string) => setExpanded(expanded.includes(key) ? expanded.filter((k) => k !== key) : [...expanded, key]);
  let shown = 0;

  return (
    <div className="browser-backdrop" onMouseDown={onDismiss}>
      <aside className="session-browser" role="dialog" aria-label="All sessions" onMouseDown={(e) => e.stopPropagation()}>
        <div className="browser-head">
          <strong>All sessions</strong>
          <button className="icon-btn" onClick={onDismiss} aria-label="Close" title="Close (Esc)">×</button>
        </div>
        <input className="browser-search" type="search" autoFocus placeholder="Search by title or folder" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search sessions" />
        <div className="agent-tabs" role="tablist" aria-label="Filter by agent">
          {(["all", ...AGENTS] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} data-agent={t}>
              {t !== "all" && <span className={`dot mini agent-${t}`} aria-hidden="true" />}
              {t === "all" ? "All" : AGENT_NAMES[t].replace(" Code", "")}<span className="tab-count">{counts[t]}</span>
            </button>
          ))}
        </div>
        <div className="browser-list">
          {folders.map((f) => {
            const folderHit = matches(f.name) || matches(f.path);
            const open = f.open.filter((s) => folderHit || matches(label(s)));
            const pastHits = f.past.filter((p) => folderHit || matches(p.title));
            if (q && !open.length && !pastHits.length) return null;
            shown++;
            const isOpen = q ? true : expanded.includes(f.key) || f.open.some((s) => s.info.id === activeId);
            const all = showAll.includes(f.key) || Boolean(q);
            const shownPast = all ? pastHits : pastHits.slice(0, Math.max(0, PER_FOLDER - open.length));
            const hidden = pastHits.length - shownPast.length;
            const agents = [...new Set([...f.open.map((s) => s.info.agent), ...f.past.map((p) => p.agent)])] as AgentId[];
            return (
              <div key={f.key} className="folder-group">
                <button className="folder-head" aria-expanded={isOpen} title={f.path} onClick={() => toggle(f.key)}>
                  <span className={`chev-small ${isOpen ? "open" : ""}`} aria-hidden="true">›</span>
                  <span className="folder-name">{f.name}</span>
                  <span className="folder-dots" aria-hidden="true">{agents.map((a) => <span key={a} className={`dot mini agent-${a}`} />)}</span>
                  <span className="folder-count">{f.open.length ? <strong>{f.open.length} open</strong> : null}{f.open.length && f.past.length ? " · " : ""}{f.past.length || ""}</span>
                </button>
                <div className="fold" data-open={isOpen}><div className="fold-inner">
                  {open.map((s) => (
                    <div key={s.info.id} className={`session-row ${s.info.id === activeId ? "active" : ""}`}>
                      <button onClick={() => { onSelect(s.info.id); onDismiss(); }}>
                        <span className={`dot agent-${s.info.agent} ${s.status}`} aria-hidden="true" />
                        <span className="session-name">{label(s)}</span>
                        <span className="session-agent">{AGENT_NAMES[s.info.agent]} · open</span>
                      </button>
                    </div>
                  ))}
                  {shownPast.map((p) => (
                    <div key={`${p.agent}-${p.id}`} className="session-row past">
                      <button onClick={() => { if (p.cloud) onCloudTask(p); else onResume(p); onDismiss(); }} title={p.liveElsewhere ? "This conversation looks like it's running somewhere else right now" : p.title}>
                        <span className={`dot hollow agent-${p.agent}`} aria-hidden="true" />
                        <span className="session-name">{p.title}</span>
                        <span className="session-agent">
                          {AGENT_NAMES[p.agent]} · {p.cloud ? p.status ?? "cloud" : timeAgo(p.updatedAt)}
                          {p.liveElsewhere && <span className="elsewhere">open elsewhere</span>}
                        </span>
                      </button>
                    </div>
                  ))}
                  {hidden > 0 && <button className="show-all" onClick={() => setShowAll([...showAll, f.key])}>Show all ({pastHits.length})</button>}
                  {all && !q && pastHits.length > PER_FOLDER && <button className="show-all" onClick={() => setShowAll(showAll.filter((k) => k !== f.key))}>Show fewer</button>}
                </div></div>
              </div>
            );
          })}
          {shown === 0 && <p className="muted small pad">{q ? `Nothing matches “${query}”` : "No sessions yet"}</p>}
        </div>
        {cloudInput === null
          ? <button className="cloud-open" onClick={() => setCloudInput("")}>☁ Open a Claude cloud session</button>
          : (
            <form className="cloud-form" onSubmit={(e) => { e.preventDefault(); if (cloudInput.trim()) { onOpenCloud(cloudInput.trim()); setCloudInput(null); onDismiss(); } }}>
              <input autoFocus placeholder="claude.ai/code link or session ID" value={cloudInput} onChange={(e) => setCloudInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setCloudInput(null); } }} />
              <button type="submit" className="btn-small primary">Open</button>
            </form>
          )}
      </aside>
    </div>
  );
}

/** A Codex Cloud task: see its diff, or apply it to a local folder, through Codex's own commands. */
export function CloudTask({ task, onPickFolder, onClose }: { task: PastSession; onPickFolder: () => Promise<string | null>; onClose: () => void }) {
  const [run, setRun] = useState<{ action: "diff" | "apply"; cwd?: string } | null>(null);
  const [termId, setTermId] = useState<string | null>(null);
  useEffect(() => {
    if (!run) return;
    let mine: string | null = null, alive = true;
    window.agents.cloudRun(run.action, task.id, run.cwd).then((id) => { mine = id; if (alive) setTermId(id); else window.agents.accountClose(id); });
    return () => { alive = false; setTermId(null); if (mine) { window.agents.accountClose(mine); clearTerminalBuffer(mine); } };
  }, [run, task.id]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" data-skin="codex" role="dialog" aria-label={task.title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div><strong>{task.title}</strong><span className="muted small"> Codex Cloud · {task.cwd}{task.status ? ` · ${task.status}` : ""}</span></div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-actions">
          <button className="btn-small" onClick={() => setRun({ action: "diff" })}>Show changes</button>
          <button className="btn-small primary" onClick={async () => { const cwd = await onPickFolder(); if (cwd) setRun({ action: "apply", cwd }); }}>Apply to a folder…</button>
        </div>
        {termId ? <div className="modal-term"><TerminalView key={termId} sessionId={termId} /></div>
          : <p className="muted small">Pick an action. Codex runs it with your signed-in account.</p>}
      </div>
    </div>
  );
}
