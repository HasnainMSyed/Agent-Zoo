// The Browser pane: a small browser beside the chat, for looking at what the agents are building
// (a dev server on localhost) or any website. Pages run sandboxed, with their own cookies, and
// can't reach the app. Links that open a new tab open here; sign-in pop-ups get a small window.

import { useCallback, useEffect, useRef, useState } from "react";
import { PaneFrame } from "./ShellPane";
import { loadError, toUrl } from "../browser-url";

/** The parts of Electron's <webview> element this pane uses. */
interface Webview extends HTMLElement {
  loadURL(url: string): Promise<void>; getURL(): string; getTitle(): string;
  canGoBack(): boolean; canGoForward(): boolean; goBack(): void; goForward(): void; reload(): void; stop(): void;
}

export function BrowserPane({ visible, width, setWidth, onHide }: { visible: boolean; width: number; setWidth: (w: number) => void; onHide: () => void }) {
  const view = useRef<Webview | null>(null);
  const [url, setUrl] = useState<string | null>(null);     // what the page shows (null: the start page)
  const [typed, setTyped] = useState("");
  const [nav, setNav] = useState({ back: false, forward: false, loading: false, title: "" });
  const [servers, setServers] = useState<{ port: number; name?: string }[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null); // why the page didn't load

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
    w.addEventListener("did-start-loading", () => { setFailed(null); setNav((n) => ({ ...n, loading: true })); });
    w.addEventListener("did-fail-load", (ev) => {
      const e = ev as Event & { errorCode: number; errorDescription: string; isMainFrame: boolean; validatedURL: string };
      if (!e.isMainFrame || e.errorCode === -3) return; // -3: replaced by another load
      setFailed(loadError(e.errorCode, e.errorDescription));
      if (e.validatedURL) { setUrl(e.validatedURL); setTyped(e.validatedURL); }
    });
    w.addEventListener("did-stop-loading", sync);
    w.addEventListener("did-navigate", sync);
    w.addEventListener("did-navigate-in-page", sync);
    w.addEventListener("page-title-updated", sync);
  }, []);

  const go = (input: string) => {
    const next = toUrl(input);
    if (!next) return;
    setUrl(next); setTyped(next);
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
        <input className="text-input" value={typed} onChange={(e) => setTyped(e.target.value)}
          placeholder="Search, or type an address or port" aria-label="Address" spellCheck={false}
          onFocus={(e) => e.currentTarget.select()} />
        {url && <button type="button" className="icon-btn" onClick={() => { setUrl(null); setTyped(""); }} aria-label="Start page" title="Start page">⌂</button>}
      </form>
      {nav.loading && <div className="url-progress" aria-hidden="true" />}
      <div className="browser-body">
        {/* The webview stays mounted, so pages keep running while the pane is hidden. */}
        {url && failed && (
          <div className="browser-failed">
            <p>{failed}</p>
            <button className="btn-small" onClick={() => view.current?.reload()}>Try again</button>
          </div>
        )}
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
              ) : <p className="muted tiny">No dev servers found. Start one (npm run dev, for example), or search or type any web address above.</p>}
            <button className="btn-small" onClick={findServers}>Look again</button>
          </div>
        )}
      </div>
    </PaneFrame>
  );
}
