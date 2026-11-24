// The Terminal pane: shells beside the chat, started in the session's folder (like the side
// terminal in Claude's desktop app). Every shell stays mounted while its session is open, so
// switching sessions or hiding the pane never loses what's on screen.

import { useEffect, useRef } from "react";
import type React from "react";
import { TerminalView } from "./TerminalView";

export interface Shell { id: string; label: string; exited?: boolean }

/** Session id -> its shells, and which one is showing. */
export type ShellState = Record<string, { list: Shell[]; current: string | null }>;

const MIN = 280;

export function ShellPane({ visible, state, sessionId, folder, width, setWidth, onNew, onClose, onPick, onHide }: {
  visible: boolean; state: ShellState; sessionId: string | null; folder: string; width: number; setWidth: (w: number) => void;
  onNew: () => void; onClose: (id: string) => void; onPick: (id: string) => void; onHide: () => void;
}) {
  const mine = sessionId ? state[sessionId] : undefined;
  const pane = useRef<HTMLElement>(null);
  // Start one shell when the pane opens on a session that has none.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (!visible || !sessionId) return;
    if (mine?.list.length) { asked.current.delete(sessionId); return; }
    if (!asked.current.has(sessionId)) { asked.current.add(sessionId); onNew(); }
  }, [visible, mine?.list.length, sessionId, onNew]);

  /** Drag the left edge to resize; the width is kept between runs. */
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX, startW = pane.current?.offsetWidth ?? width;
    const max = () => Math.max(MIN, (pane.current?.parentElement?.offsetWidth ?? 1200) - 420);
    const move = (ev: PointerEvent) => setWidth(Math.round(Math.min(max(), Math.max(MIN, startW + startX - ev.clientX))));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); document.body.classList.remove("resizing"); };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <aside className="shell-pane" ref={pane} style={{ width }} aria-label="Terminal" hidden={!visible}>
      <div className="pane-resize" role="separator" aria-orientation="vertical" aria-label="Resize the terminal" tabIndex={0} onPointerDown={startResize}
        onKeyDown={(e) => { if (e.key === "ArrowLeft") setWidth(width + 24); if (e.key === "ArrowRight") setWidth(Math.max(MIN, width - 24)); }} />
      <div className="pane-head">
        <strong>Terminal</strong>
        <div className="pane-tabs" role="tablist" aria-label="Shells">
          {mine?.list.map((s) => (
            <span key={s.id} className={`pane-tab ${s.id === mine.current ? "on" : ""} ${s.exited ? "exited" : ""}`}>
              <button role="tab" aria-selected={s.id === mine.current} onClick={() => onPick(s.id)} title={s.exited ? "This shell has exited" : folder}>{s.label}</button>
              <button className="tab-x" onClick={() => onClose(s.id)} aria-label={`Close ${s.label}`}>×</button>
            </span>
          ))}
        </div>
        <button className="icon-btn" onClick={onNew} aria-label="New terminal" title="New terminal">+</button>
        <span className="pane-spacer" />
        <button className="icon-btn" onClick={onHide} aria-label="Hide the terminal" title="Hide the terminal (shells keep running)">×</button>
      </div>
      <div className="pane-body">
        {Object.entries(state).flatMap(([sid, s]) => s.list.map((sh) => (
          <div key={sh.id} className="pane-term" hidden={sid !== sessionId || sh.id !== s.current}>
            <TerminalView sessionId={sh.id} />
          </div>
        )))}
        {!mine?.list.length && <p className="muted small pad">Starting a shell…</p>}
      </div>
    </aside>
  );
}
