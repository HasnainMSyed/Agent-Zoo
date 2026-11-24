// Sessions, in two places:
//  - SessionNav (the sidebar): only the sessions open in Agent Zoo, grouped by folder — quick navigation.
//  - SessionBrowser (a drawer that slides out from the sidebar): every conversation the agents have
//    saved, grouped by folder, with search and agent tabs. Picking one opens it and closes the drawer.

import { useEffect, useMemo, useState } from "react";
import type React from "react";
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
      <button className="close" onClick={onClose} aria-label={`Remove ${label} from the sidebar`} title="Remove from the sidebar (it stops, and stays in All sessions)">×</button>
    </div>
  );
}

/** What a drag from the drawer carries: saved conversations to open, folders to pin. */
export interface DragLoad { sessions: { agent: AgentId; id: string }[]; folders: string[] }
const DRAG_TYPE = "application/x-zoo-sessions";

function startDrag(e: React.DragEvent, load: DragLoad) {
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(load));
  e.dataTransfer.effectAllowed = "copy";
  // A small pill instead of the row's ghost: "3 sessions", "2 folders".
  const n = load.sessions.length, f = load.folders.length;
  const pill = document.createElement("div");
  pill.className = "drag-pill";
  pill.textContent = [f ? `${f} folder${f > 1 ? "s" : ""}` : "", n ? `${n} session${n > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");
  document.body.appendChild(pill);
  e.dataTransfer.setDragImage(pill, 12, 12);
  setTimeout(() => pill.remove(), 0);
  document.body.classList.add("zoo-dragging");
}
const endDrag = () => document.body.classList.remove("zoo-dragging");

/** Makes an element accept drops from the drawer. */
export function useDropTarget(onDrop: (load: DragLoad) => void) {
  const [over, setOver] = useState(false);
  const accepts = (e: React.DragEvent) => e.dataTransfer.types.includes(DRAG_TYPE);
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => { if (!accepts(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; if (!over) setOver(true); },
      onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); },
      onDrop: (e: React.DragEvent) => {
        setOver(false); endDrag();
        if (!accepts(e)) return;
        e.preventDefault();
        try { onDrop(JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as DragLoad); } catch { /* not ours */ }
      },
    },
  };
}

/** A conversation listed in the sidebar but not running (kept from an earlier run, or a pinned folder's). */
function SavedRow({ p, kept, onResume, onRemove }: { p: PastSession; kept: boolean; onResume: () => void; onRemove: () => void }) {
  return (
    <div className={`session-row past ${kept ? "kept" : ""}`}>
      <button onClick={onResume} title={kept ? `${p.title} (click to start it again)` : p.title}>
        <span className={`dot hollow agent-${p.agent}`} aria-hidden="true" />
        <span className="session-name">{p.title}</span>
        <span className="session-agent">{AGENT_NAMES[p.agent]} · {p.liveElsewhere ? "open elsewhere" : timeAgo(p.updatedAt)}</span>
      </button>
      <button className="close" onClick={onRemove} aria-label={`Remove ${p.title} from the sidebar`} title="Remove from the sidebar (it stays in All sessions)">×</button>
    </div>
  );
}

/**
 * The sidebar: your sessions, grouped by folder. Sessions you've opened stay here across restarts
 * (asleep until you click one) until you remove them; folders you've pinned (by dragging them in
 * from the drawer) also list their saved conversations. Removing only takes a row off the sidebar:
 * the conversation stays in All sessions.
 */
export function SessionNav({ sessions, dormant, past, hidden, pinned, folded, setFolded, activeId, label, savedCount, browsing, onSelect, onClose, onRemove, onBrowse, onResume, onUnpin, onDrop }: {
  sessions: Session[]; dormant: PastSession[]; past: PastSession[]; hidden: string[]; pinned: string[]; folded: string[]; setFolded: (v: string[]) => void;
  activeId: string | null; label: (s: Session) => string; savedCount: number; browsing: boolean;
  onSelect: (id: string) => void; onClose: (id: string) => void; onRemove: (p: PastSession) => void; onBrowse: () => void;
  onResume: (p: PastSession) => void; onUnpin: (path: string) => void; onDrop: (load: DragLoad) => void;
}) {
  const [showAll, setShowAll] = useState<string[]>([]);
  const drop = useDropTarget(onDrop);
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; path: string; pinned: boolean; items: Session[]; kept: PastSession[]; saved: PastSession[] }>();
    const get = (key: string, path: string, name: string) => {
      let g = map.get(key);
      if (!g) { g = { name, path, pinned: false, items: [], kept: [], saved: [] }; map.set(key, g); }
      return g;
    };
    const keyOf = (p: PastSession) => `${p.agent}:${p.id}`;
    for (const path of pinned) get(path, path, folderName(path)).pinned = true;
    for (const s of sessions) get(folderKey(s), s.info.cwd, s.info.cloud ? "Claude cloud" : folderName(s.info.cwd)).items.push(s);
    for (const p of dormant) get(p.cwd, p.cwd, folderName(p.cwd)).kept.push(p);
    const listed = new Set(dormant.map(keyOf));
    for (const p of past) {
      const g = !p.cloud ? map.get(p.cwd) : undefined;
      if (g?.pinned && !listed.has(keyOf(p)) && !hidden.includes(keyOf(p)) && !sessions.some((s) => sameConversation(s, p))) g.saved.push(p);
    }
    for (const g of map.values()) { g.kept.sort((a, b) => b.updatedAt - a.updatedAt); g.saved.sort((a, b) => b.updatedAt - a.updatedAt); }
    return [...map.entries()];
  }, [sessions, dormant, past, hidden, pinned]);
  const toggle = (key: string) => setFolded(folded.includes(key) ? folded.filter((k) => k !== key) : [...folded, key]);
  return (
    <>
      <button className={`browse-btn ${browsing ? "on" : ""}`} onClick={onBrowse} aria-expanded={browsing}>
        <span aria-hidden="true">☰</span><span className="bb-label">All sessions</span>
        {savedCount > 0 && <span className="bb-count">{savedCount}</span>}
      </button>
      <nav className={`session-list drop-zone ${drop.over ? "drop-over" : ""}`} aria-label="Open sessions" {...drop.props}>
        {groups.map(([key, g]) => {
          const isFolded = folded.includes(key) && !g.items.some((s) => s.info.id === activeId);
          const all = showAll.includes(key);
          const saved = all ? g.saved : g.saved.slice(0, Math.max(0, PER_FOLDER - g.items.length - g.kept.length));
          return (
            <div key={key} className={`folder-group nav-group ${g.pinned ? "pinned" : ""}`}>
              <div className="folder-label-row">
                <button className="folder-label" aria-expanded={!isFolded} title={g.path} onClick={() => toggle(key)}>
                  <span className={`chev-small ${isFolded ? "" : "open"}`} aria-hidden="true">›</span>
                  <span className="folder-label-name">{g.name}</span>
                  {isFolded && <span className="folder-label-count">{g.items.length + g.kept.length || g.saved.length}</span>}
                </button>
                {g.pinned && <button className="unpin" onClick={() => onUnpin(g.path)} aria-label={`Unpin ${g.name}`} title="Unpin this folder">×</button>}
              </div>
              <div className="fold" data-open={!isFolded}><div className="fold-inner">
                {g.items.map((s) => <OpenRow key={s.info.id} s={s} active={s.info.id === activeId} label={label(s)} onSelect={() => onSelect(s.info.id)} onClose={() => onClose(s.info.id)} />)}
                {g.kept.map((p) => <SavedRow key={`${p.agent}-${p.id}`} p={p} kept onResume={() => onResume(p)} onRemove={() => onRemove(p)} />)}
                {saved.map((p) => <SavedRow key={`${p.agent}-${p.id}`} p={p} kept={false} onResume={() => onResume(p)} onRemove={() => onRemove(p)} />)}
                {saved.length < g.saved.length && <button className="show-all" onClick={() => setShowAll([...showAll, key])}>Show all ({g.saved.length})</button>}
                {g.pinned && !g.items.length && !g.kept.length && !g.saved.length && <p className="muted tiny pad-l">No saved conversations here yet.</p>}
              </div></div>
            </div>
          );
        })}
        {!groups.length && (
          <div className="nav-empty">
            <p className="muted small">No sessions here yet.</p>
            <p className="muted tiny">Drag sessions or whole folders here from All sessions.</p>
            <button className="btn-small" onClick={onBrowse}>Browse past sessions</button>
          </div>
        )}
        <div className="drop-hint" aria-hidden="true">Drop to open here</div>
      </nav>
    </>
  );
}

/** The drawer with every saved conversation: search, agent tabs, folders. */
export function SessionBrowser({ sessions, past, activeId, expanded, setExpanded, label, onSelect, onResume, onOpenMany, onPin, onOpenCloud, onCloudTask, onDismiss }: {
  sessions: Session[]; past: PastSession[]; activeId: string | null;
  expanded: string[]; setExpanded: (v: string[]) => void;
  label: (s: Session) => string;
  onSelect: (id: string) => void; onResume: (p: PastSession) => void;
  /** Several saved conversations at once (Select mode). */
  onOpenMany: (list: PastSession[]) => void; onPin: (path: string) => void;
  onOpenCloud: (link: string) => void; onCloudTask: (p: PastSession) => void;
  onDismiss: () => void;
}) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"all" | AgentId>("all");
  const [showAll, setShowAll] = useState<string[]>([]);
  const [cloudInput, setCloudInput] = useState<string | null>(null);
  // Select mode: tick several conversations, then open them together or drag them into the sidebar.
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const keyOf = (p: { agent: AgentId; id: string }) => `${p.agent}:${p.id}`;
  const pick = (keys: string[], on: boolean) => setPicked((cur) => (on ? [...new Set([...cur, ...keys])] : cur.filter((k) => !keys.includes(k))));
  const pickedList = past.filter((p) => picked.includes(keyOf(p)));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (selecting) { setSelecting(false); setPicked([]); } else onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss, selecting]);
  useEffect(() => endDrag, []);

  /** Dragging a ticked row takes every ticked row with it. */
  const dragRow = (e: React.DragEvent, p: PastSession) => {
    const list = selecting && picked.includes(keyOf(p)) ? pickedList : [p];
    startDrag(e, { sessions: list.map((x) => ({ agent: x.agent, id: x.id })), folders: [] });
  };

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
          <span className="browser-head-actions">
            <button className={`btn-small select-toggle ${selecting ? "on" : ""}`} aria-pressed={selecting}
              onClick={() => { setSelecting(!selecting); setPicked([]); }} title="Pick several sessions to open together">{selecting ? "Done" : "Select"}</button>
            <button className="icon-btn" onClick={onDismiss} aria-label="Close" title="Close (Esc)">×</button>
          </span>
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
            const local = !f.key.startsWith("cloud:");
            const folderKeys = local ? pastHits.map(keyOf) : [];
            const allPicked = folderKeys.length > 0 && folderKeys.every((k) => picked.includes(k));
            return (
              <div key={f.key} className="folder-group">
                <div className="folder-head-row" draggable={local} title={local ? "Drag into the sidebar to pin this folder" : undefined}
                  onDragStart={(e) => startDrag(e, { sessions: [], folders: [f.path] })} onDragEnd={endDrag}>
                {selecting && local && (
                  <button className={`check ${allPicked ? "on" : ""}`} role="checkbox" aria-checked={allPicked} aria-label={`Select every session in ${f.name}`}
                    onClick={() => pick(folderKeys, !allPicked)} />
                )}
                <button className="folder-head" aria-expanded={isOpen} title={f.path} onClick={() => toggle(f.key)}>
                  <span className={`chev-small ${isOpen ? "open" : ""}`} aria-hidden="true">›</span>
                  <span className="folder-name">{f.name}</span>
                  <span className="folder-dots" aria-hidden="true">{agents.map((a) => <span key={a} className={`dot mini agent-${a}`} />)}</span>
                  <span className="folder-count">{f.open.length ? <strong>{f.open.length} open</strong> : null}{f.open.length && f.past.length ? " · " : ""}{f.past.length || ""}</span>
                </button>
                {local && !selecting && <button className="pin-btn" onClick={() => onPin(f.path)} aria-label={`Pin ${f.name} to the sidebar`} title="Pin to the sidebar">⇤</button>}
                </div>
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
                  {shownPast.map((p) => {
                    const on = picked.includes(keyOf(p));
                    const canPick = selecting && !p.cloud;
                    return (
                    <div key={`${p.agent}-${p.id}`} className={`session-row past ${on ? "picked" : ""}`} draggable={!p.cloud}
                      onDragStart={(e) => dragRow(e, p)} onDragEnd={endDrag}>
                      <button onClick={() => { if (canPick) { pick([keyOf(p)], !on); return; } if (p.cloud) onCloudTask(p); else onResume(p); onDismiss(); }}
                        role={canPick ? "checkbox" : undefined} aria-checked={canPick ? on : undefined}
                        title={p.liveElsewhere ? "This conversation looks like it's running somewhere else right now" : p.title}>
                        {canPick ? <span className={`check ${on ? "on" : ""}`} aria-hidden="true" /> : <span className={`dot hollow agent-${p.agent}`} aria-hidden="true" />}
                        <span className="session-name">{p.title}</span>
                        <span className="session-agent">
                          {AGENT_NAMES[p.agent]} · {p.cloud ? p.status ?? "cloud" : timeAgo(p.updatedAt)}
                          {p.liveElsewhere && <span className="elsewhere">open elsewhere</span>}
                        </span>
                      </button>
                    </div>
                    );
                  })}
                  {hidden > 0 && <button className="show-all" onClick={() => setShowAll([...showAll, f.key])}>Show all ({pastHits.length})</button>}
                  {all && !q && pastHits.length > PER_FOLDER && <button className="show-all" onClick={() => setShowAll(showAll.filter((k) => k !== f.key))}>Show fewer</button>}
                </div></div>
              </div>
            );
          })}
          {shown === 0 && <p className="muted small pad">{q ? `Nothing matches “${query}”` : "No sessions yet"}</p>}
        </div>
        {selecting
          ? (
            <div className="select-bar">
              <span className="muted small">{picked.length ? `${picked.length} selected` : "Tick sessions, or drag them to the sidebar"}</span>
              <button className="btn-small" disabled={!picked.length} onClick={() => setPicked([])}>Clear</button>
              <button className="btn-small primary" disabled={!picked.length} onClick={() => { onOpenMany(pickedList); setPicked([]); setSelecting(false); onDismiss(); }}>
                Open{picked.length ? ` ${picked.length}` : ""}
              </button>
            </div>
          )
          : cloudInput === null
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
