import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { AgentId, SessionCommand } from "@shared/events";
import { SessionManager } from "./session-manager";

let win: BrowserWindow | null = null;
const manager = new SessionManager({
  event: (sessionId, event) => win?.webContents.send("session:event", sessionId, event),
  termData: (sessionId, chunk) => win?.webContents.send("term:data", sessionId, chunk),
});

function createWindow() {
  // Screenshot runs render off-screen, so test windows never appear on (or take clicks from) the desktop.
  const offscreen = Boolean(process.env.AGENTS_GUI_SCREENSHOT);
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 760, minHeight: 520, show: !offscreen,
    title: "Agent Zoo", backgroundColor: "#191919", autoHideMenuBar: true,
    webPreferences: { preload: join(import.meta.dirname, "../preload/index.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen },
  });
  // Links in agent output open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) import("electron").then(({ shell }) => shell.openExternal(url));
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  win.on("closed", () => { win = null; });

  // AGENTS_GUI_SCREENSHOT=out.png [AGENTS_GUI_SCREENSHOT_DELAY=ms]: capture the window, then quit.
  const shot = process.env.AGENTS_GUI_SCREENSHOT;
  if (shot) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        const img = await win!.webContents.capturePage();
        writeFileSync(shot, img.toPNG());
        app.quit();
      }, Number(process.env.AGENTS_GUI_SCREENSHOT_DELAY ?? 8000));
    });
  }
}

ipcMain.handle("session:create", (_e, agent: AgentId, cwd: string) => manager.create(agent, cwd));
ipcMain.handle("session:command", (_e, id: string, cmd: SessionCommand) => manager.command(id, cmd));
ipcMain.handle("session:close", (_e, id: string) => manager.close(id));
ipcMain.handle("session:view", (_e, id: string, view: "gui" | "terminal", cols?: number, rows?: number) => manager.setView(id, view, cols, rows));
ipcMain.on("term:input", (_e, id: string, data: string) => manager.termInput(id, data));
ipcMain.on("term:resize", (_e, id: string, cols: number, rows: number) => manager.termResize(id, cols, rows));
ipcMain.handle("dialog:pickFolder", async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"], title: "Choose a project folder" });
  return r.canceled ? null : r.filePaths[0] ?? null;
});
ipcMain.handle("app:info", () => ({
  home: app.getPath("home"),
  cwd: process.env.AGENTS_GUI_CWD || process.cwd(),
  // Screenshot runs start themselves: a replay's agent comes from the fixture's name, or AGENTS_GUI_AUTOSTART names one.
  autoStart: process.env.AGENTS_GUI_SCREENSHOT
    ? (process.env.AGENTS_GUI_AUTOSTART as "claude" | "codex" | "grok" | undefined)
      ?? (process.env.AGENTS_GUI_REPLAY ? (["codex", "grok", "claude"] as const).find((a) => process.env.AGENTS_GUI_REPLAY!.includes(a)) ?? "claude" : null)
    : null,
  autoView: process.env.AGENTS_GUI_SCREENSHOT && process.env.AGENTS_GUI_AUTOVIEW === "terminal" ? "terminal" : null,
  autoPrompt: process.env.AGENTS_GUI_SCREENSHOT ? process.env.AGENTS_GUI_AUTOPROMPT ?? null : null,
}));

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { manager.closeAll(); app.quit(); });
app.on("before-quit", () => manager.closeAll());
