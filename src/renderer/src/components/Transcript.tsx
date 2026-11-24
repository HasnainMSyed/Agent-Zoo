import { useEffect, useRef, useState } from "react";
import type { PermissionOption } from "@shared/events";
import type { Item } from "../state";
import { ApprovalCard } from "./ApprovalCard";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";

function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`thinking ${streaming ? "live" : ""}`}>
      <button onClick={() => setOpen(!open)} aria-expanded={open}><span className="shimmer">{streaming ? "Thinking…" : "Thought"}</span><span className="muted">{text.length > 0 ? `${text.split(/\s+/).length} words` : ""}</span></button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  );
}

const fmtSecs = (ms?: number) => (ms === undefined ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export function Items({ items, onDecide }: { items: Item[]; onDecide: (id: string, d: PermissionOption["id"]) => void }) {
  const render = (list: Item[]) => list.map((it) => {
    switch (it.type) {
      case "user": return <div key={it.id} className="msg-user"><div className="bubble">{it.text}</div></div>;
      case "assistant": return <div key={it.id} className={`msg-assistant ${it.streaming ? "streaming" : ""}`}><Markdown text={it.text} /></div>;
      case "thinking": return <Thinking key={it.id} text={it.text} streaming={it.streaming} />;
      case "tool": return <ToolCard key={it.id} item={it} renderChildren={render} />;
      case "permission": return <ApprovalCard key={it.id} item={it} onDecide={(d) => onDecide(it.id, d)} />;
      case "turn": return <div key={it.id} className={`turn-end ${it.ok ? "" : "failed"}`}>{it.ok ? "Turn finished" : `Turn failed${it.error ? `: ${it.error}` : ""}`}{it.durationMs ? ` · ${fmtSecs(it.durationMs)}` : ""}</div>;
      case "error": return <div key={it.id} className="error-banner" role="alert">{it.message}</div>;
    }
  });
  return <>{render(items)}</>;
}

/** Scrolls to the bottom as content arrives, unless the user has scrolled up to read. */
export function Transcript({ items, onDecide, empty }: { items: Item[]; onDecide: (id: string, d: PermissionOption["id"]) => void; empty: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastAuto = useRef(-1);
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) { el.scrollTop = el.scrollHeight; lastAuto.current = el.scrollTop; }
  });
  // Only a scroll the user made can unpin; our own jumps to the bottom are ignored.
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom) { pinned.current = true; return; }
    if (el.scrollTop < lastAuto.current - 4) pinned.current = false;
  };
  return (
    <div className="transcript" ref={ref} onScroll={onScroll}>
      <div className="transcript-inner">{items.length ? <Items items={items} onDecide={onDecide} /> : empty}</div>
    </div>
  );
}
