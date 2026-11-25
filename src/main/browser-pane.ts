// The Browser pane's web session: any website, kept apart from the app. Pages get their own
// cookies ("persist:browser-pane"), no Node and no preload, and can't use anything personal.

import { app, session, type WebContents } from "electron";

export const PARTITION = "persist:browser-pane";

/** What any page may use: going full screen, copying text you selected, locking the pointer (games). */
const ALLOWED = new Set(["fullscreen", "clipboard-sanitized-write", "pointerLock"]);

const web = (url: string) => /^https?:/i.test(url);

/** Sets up the pane's session once, at startup. */
export function setUpBrowserSession(): void {
  const s = session.fromPartition(PARTITION);
  // Look like the Chrome this is: some sites (sign-ins especially) refuse or degrade "Electron".
  const name = app.getName().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  s.setUserAgent(s.getUserAgent().replace(new RegExp(`\\s(${name}|Electron)/\\S+`, "g"), ""));
  // Camera, microphone, location, notifications and the like stay off for websites in the pane.
  s.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED.has(permission)));
  s.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission));
}

/**
 * Rules for a page in the pane (and any pop-up it opens): web addresses only. A link that opens a
 * new tab opens in the pane itself; a real pop-up (a "Sign in with…" window) gets a small window
 * of its own, so the sign-in can hand its answer back to the page.
 */
export function guardBrowserPage(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (!web(url)) return { action: "deny" };
    if (disposition === "new-window") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 520, height: 700, autoHideMenuBar: true,
          webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    contents.loadURL(url).catch(() => {});
    return { action: "deny" };
  });
  contents.on("did-create-window", (child) => guardBrowserPage(child.webContents));
  contents.on("will-navigate", (e, url) => { if (!web(url)) e.preventDefault(); });
  contents.on("will-redirect", (e, url) => { if (!web(url)) e.preventDefault(); });
}
