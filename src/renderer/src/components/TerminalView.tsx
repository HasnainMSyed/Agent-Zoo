import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// Terminal output is buffered from the moment a session switches, so nothing printed before the view mounts is lost.
const buffers = new Map<string, string[]>();
const listeners = new Map<string, (chunk: string) => void>();
let subscribed = false;

function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  window.agents.onTermData((id, chunk) => {
    const listen = listeners.get(id);
    if (listen) { listen(chunk); return; }
    const buf = buffers.get(id) ?? [];
    buf.push(chunk);
    if (buf.length > 5000) buf.splice(0, buf.length - 5000);
    buffers.set(id, buf);
  });
}

export function clearTerminalBuffer(id: string) { buffers.delete(id); }
ensureSubscribed();

/** Reads the skin's tokens so the terminal matches the agent's colours. */
function themeFrom(el: HTMLElement) {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return { background: v("--canvas"), foreground: v("--text"), cursor: v("--accent"), cursorAccent: v("--canvas"), selectionBackground: v("--surface-2") };
}

export function TerminalView({ sessionId }: { sessionId: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current!;
    const term = new Terminal({
      fontFamily: getComputedStyle(el).getPropertyValue("--font-mono").trim() || "monospace",
      fontSize: 13, lineHeight: 1.15, cursorBlink: true, scrollback: 10000,
      theme: themeFrom(el),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    for (const chunk of buffers.get(sessionId) ?? []) term.write(chunk);
    buffers.delete(sessionId);
    listeners.set(sessionId, (chunk) => term.write(chunk));

    const input = term.onData((d) => window.agents.termInput(sessionId, d));
    const resize = () => {
      try { fit.fit(); } catch { return; }
      window.agents.termResize(sessionId, term.cols, term.rows);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    term.focus();

    return () => {
      ro.disconnect();
      input.dispose();
      listeners.delete(sessionId);
      term.dispose();
    };
  }, [sessionId]);

  return <div className="terminal-view" ref={host} />;
}
