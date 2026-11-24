import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentId } from "@shared/events";
import type { PastSession, UsageLimits } from "@shared/commands";
import { packFor } from "../mascots";
import { Mascot } from "./Mascot";
import { AGENT_NAMES, LimitBars, RefreshUsage, timeAgo } from "./Usage";

const AGENTS: AgentId[] = ["claude", "codex", "grok"];

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
const folderName = (cwd: string) => cwd.split("/").filter(Boolean).pop() ?? cwd;
const tidyPath = (cwd: string, home: string) => (home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd);

interface Project { cwd: string; sessions: PastSession[]; updatedAt: number }

export function HomeScreen({ home, past, loading, usage, lastAgent, onPickLead, onOpenFolder, onStart, onResume }: {
  home: string; past: PastSession[]; loading: boolean; usage: Partial<Record<AgentId, UsageLimits>>; lastAgent: AgentId;
  /** `from`: the centre of the clicked mascot, where the new colours spread from. */
  onPickLead: (agent: AgentId, from?: { x: number; y: number }) => void;
  onOpenFolder: () => Promise<string | null>;
  onStart: (agent: AgentId, cwd: string, prompt: string) => void;
  onResume: (s: PastSession) => void;
}) {
  // Cloud tasks have no local folder; they live in the sidebar's cloud group.
  const local = useMemo(() => past.filter((s) => !s.cloud), [past]);
  const projects = useMemo(() => {
    const map = new Map<string, Project>();
    for (const s of local) {
      const p = map.get(s.cwd) ?? { cwd: s.cwd, sessions: [], updatedAt: 0 };
      p.sessions.push(s);
      p.updatedAt = Math.max(p.updatedAt, s.updatedAt);
      map.set(s.cwd, p);
    }
    return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [local]);

  const [selected, setSelected] = useState<string | null>(null);
  const [agent, setAgent] = useState<AgentId>(lastAgent);
  // The start card follows the lead mascot until you pick another agent on it.
  useEffect(() => { setAgent(lastAgent); }, [lastAgent]);
  const [prompt, setPrompt] = useState("");
  const [recentOpen, setRecentOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (selected) inputRef.current?.focus(); }, [selected]);

  // Skip conversations that seem to be running elsewhere right now (e.g. in another terminal).
  const latest = local.find((s) => !s.liveElsewhere);
  const project = selected ? projects.find((p) => p.cwd === selected) ?? { cwd: selected, sessions: [], updatedAt: 0 } : undefined;

  const openFolder = async () => { const p = await onOpenFolder(); if (p) setSelected(p); };
  const start = () => { if (selected) onStart(agent, selected, prompt.trim()); };

  return (
    <div className="home">
      <div className="home-hero">
        <div className="home-mascots" role="radiogroup" aria-label="Lead agent">
          {AGENTS.map((a) => (
            <button key={a} role="radio" aria-checked={a === lastAgent} data-skin={a} className={a === lastAgent ? "lead" : ""}
              onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onPickLead(a, { x: r.left + r.width / 2, y: r.top + r.height / 2 }); }} title={a === lastAgent ? `${AGENT_NAMES[a]} leads: new sessions start with it` : `Make ${AGENT_NAMES[a]} the lead`}>
              <Mascot pack={packFor(a)} state="idle" size={a === lastAgent ? 64 : 46} />
            </button>
          ))}
        </div>
        <h1>{greeting()}</h1>
        <p>Pick up a project, or open a new one.</p>
        <button className="btn-primary big" onClick={openFolder}>+ Open folder</button>
      </div>

      {project && (
        <section className="home-start" data-skin={agent} aria-label={`Start in ${folderName(project.cwd)}`}>
          <div className="home-start-head">
            <div><strong>{folderName(project.cwd)}</strong><span className="muted"> {tidyPath(project.cwd, home)}</span></div>
            <button className="icon-btn" onClick={() => setSelected(null)} aria-label="Close">×</button>
          </div>
          <div className="agent-choice" role="radiogroup" aria-label="Agent">
            {AGENTS.map((a) => (
              <button key={a} role="radio" aria-checked={a === agent} data-skin={a} onClick={() => setAgent(a)}>
                <Mascot pack={packFor(a)} state="idle" size={30} /><span>{AGENT_NAMES[a]}</span>
              </button>
            ))}
          </div>
          <div className="home-input">
            <textarea ref={inputRef} rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should it work on? (optional)"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); start(); } }} />
            <button className="btn-primary" onClick={start}>Start {AGENT_NAMES[agent]}</button>
          </div>
          {project.sessions.length > 0 && (
            <div className="home-sessions">
              <span className="home-label">Earlier in this project</span>
              {project.sessions.slice(0, 5).map((s) => (
                <button key={`${s.agent}-${s.id}`} className="home-session" onClick={() => onResume(s)}>
                  <span className={`dot agent-${s.agent}`} aria-hidden="true" /><span className="t">{s.title}</span><span className="muted">{timeAgo(s.updatedAt)}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {!project && latest && (
        <section className="home-section">
          <span className="home-label">Pick up where you left off</span>
          <button className="resume-card" data-skin={latest.agent} onClick={() => onResume(latest)}>
            <Mascot pack={packFor(latest.agent)} state="idle" size={40} />
            <div className="rc-text"><strong>{latest.title}</strong><span className="muted">{folderName(latest.cwd)} · {AGENT_NAMES[latest.agent]} · {timeAgo(latest.updatedAt)}</span></div>
            <span className="rc-go">Continue →</span>
          </button>
        </section>
      )}

      <section className="home-section recent">
        {/* Folded at every launch; the button opens the cards. */}
        <button className="recent-toggle" aria-expanded={recentOpen} onClick={() => setRecentOpen(!recentOpen)}>
          <span className="rt-label">Recent projects</span>
          {projects.length > 0 && <span className="rt-count">{projects.length > 6 ? 6 : projects.length}</span>}
          <span className="rt-dots" aria-hidden="true">{[...new Set(local.map((s) => s.agent))].map((a) => <span key={a} className={`dot agent-${a}`} />)}</span>
          <span className={`rt-chev ${recentOpen ? "open" : ""}`} aria-hidden="true">›</span>
        </button>
        <div className="fold" data-open={recentOpen}><div className="fold-inner"><div className="recent-body">
        {loading && !projects.length && <p className="muted small">Looking for your projects…</p>}
        {!loading && !projects.length && <p className="muted small">No projects yet. Open a folder to start your first session.</p>}
        <div className="project-grid">
          {projects.slice(0, 6).map((p) => (
            <button key={p.cwd} className={`project-card ${p.cwd === selected ? "on" : ""}`} onClick={() => setSelected(p.cwd)} title={p.cwd}>
              <strong>{folderName(p.cwd)}</strong>
              <span className="pc-path">{tidyPath(p.cwd, home)}</span>
              <span className="pc-last">{p.sessions[0]?.title}</span>
              <span className="pc-meta">
                {[...new Set(p.sessions.map((s) => s.agent))].map((a) => <span key={a} className={`dot agent-${a}`} aria-label={AGENT_NAMES[a]} />)}
                {p.sessions.length} session{p.sessions.length === 1 ? "" : "s"} · {timeAgo(p.updatedAt)}
              </span>
            </button>
          ))}
        </div>
        </div></div></div>
      </section>

      <div className="usage-row-head"><span className="home-label">Plan usage</span><RefreshUsage /></div>
      <section className="usage-row" aria-label="Plan usage">
        {AGENTS.map((a) => (
          <div key={a} className="usage-cell" data-skin={a}>
            <div className="uc-head"><span className={`dot agent-${a}`} aria-hidden="true" />{usage[a]?.plan ?? AGENT_NAMES[a]}</div>
            {usage[a]?.windows.length ? <LimitBars usage={usage[a]} compact />
              : <span className="muted tiny">{a === "grok" ? "Reading Grok's limits…" : "Shown after your next session"}</span>}
          </div>
        ))}
      </section>
    </div>
  );
}
