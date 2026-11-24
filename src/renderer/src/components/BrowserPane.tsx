// The Browser pane: a small browser beside the chat, for looking at what the agents are building
// (a dev server on localhost) or any web page. Pages run sandboxed, with their own cookies, and
// can't reach the app. Links that open a new window go to your normal browser.

import { useCallback, useEffect, useRef, useState } from "react";
import { PaneFrame } from "./ShellPane";

/** The parts of Electron's <webview> element this pane uses. */
interface Webview extends HTMLElement {
  loadURL(url: string): Promise<void>; getURL(): string; getTitle(): string;
  canGoBack(): boolean; canGoForward(): boolean; goBack(): void; goForward(): void; reload(): void; stop(): void;
}

/** Turns what was typed into a URL: "localhost:3000", "3000", "example.com" or a full address. */
export function toUrl(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (/^\d{2,5}$/.test(t)) return `http://localhost:${t}`;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/.*)?$/i.test(t)) return `http://${t}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(t)) return `https://${t}`;
  return null;
}

export function BrowserPane({ visible, width, setWidth, onHide }: { visible: boolean; width: number; setWidth: (w: number) => void; onHide: () => void }) {
  const view = useRef<Webview | null>(null);
  const [url, setUrl] = useState<string | null>(null);     // what the page shows (null: the start page)
  const [typed, setTyped] = useState("");
  const [nav, setNav] = useState({ back: false, forward: false, loading: false, title: "" });
  const [servers, setServers] = useState<{ port: number; name?: string }[] | null>(null);
  const [bad, setBad] = useState(false);

  // The start page lists dev servers running on this computer.
  const findServers = useCallback(() => { window.agents.browserServers().then(setServers).catch(() => setServers([])); }, []);
  useEffect(() => { if (visible && !url) findServers(); }, [visible, url, findServers]);

  // Follow the page: address, title, back/forward, loading.
  const attach = useCallback((el: HTMLElement | null) => {
    const w = el as Webview | null;
    if (!w || view.current === w) return;
    view.current = w;
    const sync = () => {
      try {
        setNav({ back: w.canGoBack(), forward: w.canGoForward(), loading: false, title: w.getTitle() });
        const u = w.getURL();
        if (u && u !== "about:blank") { setUrl(u); setTyped(u); }
      } catch { /* not ready yet */ }
    };
    w.addEventListener("did-start-loading", () => setNav((n) => ({ ...n, loading: true })));
    w.addEventListener("did-stop-loading", sync);
    w.addEventListener("did-navigate", sync);
    w.addEventListener("did-navigate-in-page", sync);
    w.addEventListener("page-title-updated", sync);
  }, []);

  const go = (input: string) => {
    const next = toUrl(input);
    if (!next) { setBad(true); return; }
    setBad(false); setUrl(next); setTyped(next);
    if (view.current) view.current.loadURL(next).catch(() => {});
  };

  return (
    <PaneFrame hidden={!visible} label="Browser" width={width} setWidth={setWidth} head={<>
      <strong>Browser</strong>
      <span className="pane-spacer" />
      {url && <button className="icon-btn" onClick={() => window.open(url, "_blank")} aria-label="Open in your browser" title="Open in your browser">⤴</button>}
      <button className="icon-btn" onClick={onHide} aria-label="Hide the browser" title="Hide the browser">×</button>
    </>}>
      <form className="url-bar" onSubmit={(e) => { e.preventDefault(); go(typed); }}>
        <button type="button" className="icon-btn" disabled={!nav.back} onClick={() => view.current?.goBack()} aria-label="Back" title="Back">‹</button>
        <button type="button" className="icon-btn" disabled={!nav.forward} onClick={() => view.current?.goForward()} aria-label="Forward" title="Forward">›</button>
        <button type="button" className="icon-btn" disabled={!url} onClick={() => (nav.loading ? view.current?.stop() : view.current?.reload())}
          aria-label={nav.loading ? "Stop" : "Reload"} title={nav.loading ? "Stop" : "Reload"}>{nav.loading ? "×" : "↻"}</button>
        <input className={`text-input ${bad ? "bad" : ""}`} value={typed} onChange={(e) => { setTyped(e.target.value); setBad(false); }}
          placeholder="localhost:5173, a port, or a web address" aria-label="Address" spellCheck={false}
          onFocus={(e) => e.currentTarget.select()} />
        {url && <button type="button" className="icon-btn" onClick={() => { setUrl(null); setTyped(""); }} aria-label="Start page" title="Start page">⌂</button>}
      </form>
      {nav.loading && <div className="url-progress" aria-hidden="true" />}
      <div className="browser-body">
        {/* The webview stays mounted, so pages keep running while the pane is hidden. */}
        <webview ref={attach} src="about:blank" partition="persist:browser-pane" hidden={!url} className="browser-view" />
        {!url && (
          <div className="browser-start">
            <p className="muted small">Running on this computer</p>
            {servers === null ? <p className="muted tiny">Looking…</p>
              : servers.length ? (
                <div className="server-list">
                  {servers.map((s) => (
                    <button key={s.port} className="server-row" onClick={() => go(`localhost:${s.port}`)}>
                      <span className="server-port">localhost:{s.port}</span>{s.name && <span className="muted tiny">{s.name}</span>}
                    </button>
                  ))}
                </div>
              ) : <p className="muted tiny">No dev servers found. Start one (npm run dev, for example) or type an address above.</p>}
            <button className="btn-small" onClick={findServers}>Look again</button>
            {bad && <p className="voice-error">That doesn't look like a web address.</p>}
          </div>
        )}
      </div>
    </PaneFrame>
  );
}
