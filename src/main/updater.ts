// Updates: installed copies look for a new release on GitHub at launch and every few hours, and
// download it in the background. The page then offers it; installing waits until no agent is in
// the middle of a turn (the page decides that), restarts the app, and the sessions that were open
// start again. The .deb asks for the computer's password to install; the AppImage doesn't.

import { app, type BrowserWindow } from "electron";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;
const EVERY = 4 * 60 * 60_000;

export interface UpdateState { status: "idle" | "downloading" | "ready" | "error"; version?: string; percent?: number; error?: string }

let state: UpdateState = { status: "idle" };

export function startUpdates(win: () => BrowserWindow | null) {
  // Only installed copies update themselves (AGENTS_GUI_UPDATE_URL points a test build at a local server).
  const testFeed = process.env.AGENTS_GUI_UPDATE_URL;
  // AGENTS_GUI_FAKE_UPDATE=version (screenshot runs only): pretend that version is downloaded, to test the prompt.
  const fake = process.env.AGENTS_GUI_SCREENSHOT && process.env.AGENTS_GUI_FAKE_UPDATE;
  if (fake) { state = { status: "ready", version: fake }; return; }
  if (!app.isPackaged && !testFeed) return;
  if (testFeed) autoUpdater.setFeedURL({ provider: "generic", url: testFeed });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false; // only when you choose to update
  autoUpdater.logger = null;
  const send = (next: UpdateState) => { state = next; win()?.webContents.send("update:state", state); };
  autoUpdater.on("update-available", (i) => send({ status: "downloading", version: i.version, percent: 0 }));
  autoUpdater.on("download-progress", (p) => send({ ...state, status: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (i) => send({ status: "ready", version: i.version }));
  // Being offline, or no release yet, isn't worth a message: just try again later.
  autoUpdater.on("error", (e) => { if (state.status === "downloading") send({ status: "error", version: state.version, error: e.message }); });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 15_000);
  setInterval(check, EVERY).unref();
}

export const updateState = () => state;

/** Restarts into the downloaded version. */
export function installUpdate() {
  if (state.status !== "ready") throw new Error("No update is ready.");
  if (process.env.AGENTS_GUI_FAKE_UPDATE) return; // test runs stop here
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
}
