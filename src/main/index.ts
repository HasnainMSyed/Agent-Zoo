import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { AgentId, SessionCommand } from "@shared/events";
import { SessionManager } from "./session-manager";

let win: BrowserWindow | null = null;
const manager = new SessionManager((sessionId, event) => win?.webContents.send("session:event", sessionId, event));

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 760, minHeight: 520,
    title: "Agent Zoo", backgroundColor: "#191919", autoHideMenuBar: true,
    webPreferences: { preload: join(import.meta.dirname, "../preload/index.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
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
ipcMain.handle("dialog:pickFolder", async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"], title: "Choose a project folder" });
  return r.canceled ? null : r.filePaths[0] ?? null;
});
ipcMain.handle("app:info", () => ({
  home: app.getPath("home"),
  cwd: process.env.AGENTS_GUI_CWD || process.cwd(),
  // Replays with a screenshot start themselves; the agent comes from the fixture's name.
  autoStart: process.env.AGENTS_GUI_REPLAY && process.env.AGENTS_GUI_SCREENSHOT
    ? (["codex", "grok", "claude"] as const).find((a) => process.env.AGENTS_GUI_REPLAY!.includes(a)) ?? "claude"
    : null,
}));

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { manager.closeAll(); app.quit(); });
app.on("before-quit", () => manager.closeAll());
