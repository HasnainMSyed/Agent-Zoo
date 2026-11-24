// The sessions list: every conversation the agents have saved on this computer, grouped by
// folder, with the ones open in Agent Zoo on top of each folder. Codex Cloud tasks get their
// own group; Claude cloud sessions open by link. Folders start folded except the active one.

import { useEffect, useMemo, useState } from "react";
import type { AgentId } from "@shared/events";
import type { PastSession } from "@shared/commands";
import type { Session } from "../state";
import { AGENT_NAMES, timeAgo } from "./Usage";
import { TerminalView, clearTerminalBuffer } from "./TerminalView";

const PER_FOLDER = 5;
const CLOUD_KEY = "cloud:codex";

interface Folder { key: string; name: string; path: string; open: Session[]; past: PastSession[]; latest: number }

const folderName = (cwd: string) => cwd.split("/").filter(Boolean).pop() || cwd;

/** Same conversation? Open sessions know their agent's own id once it's assigned. */
const sameConversation = (s: Session, p: PastSession) => s.info.agent === p.agent && (s.nativeId ?? s.info.nativeId) === p.id;

export function SessionSidebar({ sessions, past, activeId, expanded, setExpanded, label, onSelect, onClose, onResume, onOpenCloud, onCloudTask }: {
  sessions: Session[]; past: PastSession[]; activeId: string | null;
  expanded: string[]; setExpanded: (v: string[]) => void;
  label: (s: Session) => string;
  onSelect: (id: string) => void; onClose: (id: string) => void;
  onResume: (p: PastSession) => void; onOpenCloud: (link: string) => void; onCloudTask: (p: PastSession) => void;
}) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState<string[]>([]);
  const [cloudInput, setCloudInput] = useState<string | null>(null);

  const folders = useMemo(() => {
    const map = new Map<string, Folder>();
    const get = (key: string, path: string, name = folderName(path)) => {
      let f = map.get(key);
      if (!f) { f = { key, name, path, open: [], past: [], latest: 0 }; map.set(key, f); }
      return f;
    };
    for (const s of sessions) { const f = get(s.info.cloud ? "cloud:claude" : s.info.cwd, s.info.cwd, s.info.cloud ? "Claude cloud" : undefined); f.open.push(s); f.latest = Infinity; }
    for (const p of past) {
      if (sessions.some((s) => sameConversation(s, p))) continue; // already listed as open
      const f = p.cloud ? get(CLOUD_KEY, "Codex Cloud", "Codex Cloud") : get(p.cwd, p.cwd);
      f.past.push(p);
      f.latest = Math.max(f.latest, p.updatedAt);
    }
    return [...map.values()].sort((a, b) => b.latest - a.latest);
  }, [sessions, past]);

  const q = query.trim().toLowerCase();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);
  const activeFolder = sessions.find((s) => s.info.id === activeId);
  const activeKey = activeFolder ? (activeFolder.info.cloud ? "cloud:claude" : activeFolder.info.cwd) : undefined;
  // The active session's folder opens by itself.
  useEffect(() => { if (activeKey && !expanded.includes(activeKey)) setExpanded([...expanded, activeKey]); }, [activeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (key: string) => setExpanded(expanded.includes(key) ? expanded.filter((k) => k !== key) : [...expanded, key]);

  return (
    <>
      <div className="session-search">
        <input type="search" placeholder="Search sessions" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search sessions" />
      </div>
      <nav className="session-list" aria-label="Sessions by folder">
        {folders.map((f) => {
          const folderHit = matches(f.name) || matches(f.path);
          const open = f.open.filter((s) => folderHit || matches(label(s)));
          const pastHits = f.past.filter((p) => folderHit || matches(p.title));
          if (q && !open.length && !pastHits.length) return null;
          const isOpen = q ? true : expanded.includes(f.key);
          const all = showAll.includes(f.key) || Boolean(q);
          const shownPast = all ? pastHits : pastHits.slice(0, Math.max(0, PER_FOLDER - open.length));
          const hidden = pastHits.length - shownPast.length;
          const agents = [...new Set([...f.open.map((s) => s.info.agent), ...f.past.map((p) => p.agent)])] as AgentId[];
          return (
            <div key={f.key} className="folder-group">
              <button className="folder-head" aria-expanded={isOpen} title={f.path} onClick={() => toggle(f.key)}>
                <span className={`chev-small ${isOpen ? "open" : ""}`} aria-hidden="true">›</span>
                <span className="folder-name">{f.name}</span>
                {!isOpen && <span className="folder-dots" aria-hidden="true">{agents.map((a) => <span key={a} className={`dot mini agent-${a}`} />)}</span>}
                <span className="folder-count">{f.open.length ? <strong>{f.open.length}</strong> : null}{f.open.length && f.past.length ? " · " : ""}{f.past.length || ""}</span>
              </button>
              <div className="fold" data-open={isOpen}><div className="fold-inner">
                {open.map((s) => (
                  <div key={s.info.id} className={`session-row ${s.info.id === activeId ? "active" : ""}`}>
                    <button onClick={() => onSelect(s.info.id)}>
                      <span className={`dot agent-${s.info.agent} ${s.status}`} aria-hidden="true" />
                      <span className="session-name">{label(s)}</span>
                      <span className="session-agent">{AGENT_NAMES[s.info.agent]}{s.view === "terminal" ? " · Terminal" : ""} · open</span>
                    </button>
                    <button className="close" onClick={() => onClose(s.info.id)} aria-label={`Close ${label(s)}`}>×</button>
                  </div>
                ))}
                {shownPast.map((p) => (
                  <div key={`${p.agent}-${p.id}`} className="session-row past">
                    <button onClick={() => (p.cloud ? onCloudTask(p) : onResume(p))} title={p.liveElsewhere ? "This conversation looks like it's running somewhere else right now" : p.title}>
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
        {!folders.length && <p className="muted small pad">No sessions yet</p>}
        {q && folders.length > 0 && !folders.some((f) => matches(f.name) || f.open.some((s) => matches(label(s))) || f.past.some((p) => matches(p.title))) && <p className="muted small pad">Nothing matches “{query}”</p>}
      </nav>
      {cloudInput === null
        ? <button className="cloud-open" onClick={() => setCloudInput("")}>☁ Open a Claude cloud session</button>
        : (
          <form className="cloud-form" onSubmit={(e) => { e.preventDefault(); if (cloudInput.trim()) { onOpenCloud(cloudInput.trim()); setCloudInput(null); } }}>
            <input autoFocus placeholder="claude.ai/code link or session ID" value={cloudInput} onChange={(e) => setCloudInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setCloudInput(null); }} />
            <button type="submit" className="btn-small primary">Open</button>
          </form>
        )}
    </>
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
