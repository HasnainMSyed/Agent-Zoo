/// <reference types="electron-vite/node" />
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import type { AgentEvent, AgentId, SessionCommand } from "@shared/events";
import { SessionManager } from "./session-manager";
import { UsageStore } from "./usage-store";
import { codexLimitsNow, pastSessions, watchClaudeSessions } from "./history-index";
import { claudeUsageOnce } from "./adapters/claude";
import { claudeUsageLimits } from "./adapters/claude-mapper";
import { accounts, ACCOUNT_COMMANDS } from "./accounts";
import { grokUsage } from "./grok-usage";
import { MascotStore } from "./mascots";
import { userInfo } from "node:os";
import { loadShellPath } from "./env";
import { takeOverClaude } from "./live-sessions";
import { installUpdate, startUpdates, updateState } from "./updater";
import { fileStat, listDir, readFileFor, writeFileFor } from "./files";
import { localServers } from "./local-servers";
import { codexDictationKey, transcribeCodexAudio } from "./codex-dictation";
import logoPath from "../renderer/src/assets/prompt-habitat-logo.png?asset";

// Screenshot runs get a throwaway profile, so test clicks never change the real app's saved layout.
// AGENTS_GUI_TEST_PROFILE=name keeps one between runs (to test what survives a restart).
if (process.env.AGENTS_GUI_SCREENSHOT) app.setPath("userData", join(app.getPath("temp"), `agent-zoo-test-${process.env.AGENTS_GUI_TEST_PROFILE || process.pid}`));
// Development runs keep their own settings, apart from the installed app's (so the two never mix).
else if (!app.isPackaged) app.setPath("userData", join(app.getPath("appData"), "agent-zoo-dev"));

// One copy of the app at a time: starting it again brings the open window forward instead of
// running a second copy against the same settings and sessions.
if (!process.env.AGENTS_GUI_SCREENSHOT && !app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

let win: BrowserWindow | null = null;
let usage: UsageStore | undefined; // created once the app is ready (it needs the data folder)
let mascots: MascotStore | undefined;
const manager = new SessionManager({
  event: (sessionId, event) => win?.webContents.send("session:event", sessionId, event),
  termData: (sessionId, chunk) => win?.webContents.send("term:data", sessionId, chunk),
  limits: (patch) => usage?.update(patch),
});

/** A Claude API endpoint other than Anthropic's (e.g. a proxy) is worth showing next to billing. */
function claudeEndpoint(): string | undefined {
  const url = process.env.ANTHROPIC_BASE_URL;
  if (!url) return undefined;
  try { return new URL(url).host; } catch { return url; }
}

function createWindow() {
  // Screenshot runs render off-screen, so test windows never appear on (or take clicks from) the desktop.
  const offscreen = Boolean(process.env.AGENTS_GUI_SCREENSHOT);
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 760, minHeight: 520, show: !offscreen,
    title: "Prompt Habitat", icon: logoPath, backgroundColor: "#191919", autoHideMenuBar: true,
    webPreferences: { preload: join(import.meta.dirname, "../preload/index.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen, webviewTag: true },
  });
  // Links in agent output open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) import("electron").then(({ shell }) => shell.openExternal(url));
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  // The Browser pane's <webview>: web pages only, with no preload, no Node, sandboxed, and their
  // own cookie storage. Pages that open a new window go to the system browser instead.
  win.webContents.on("will-attach-webview", (e, prefs, params) => {
    delete (prefs as { preload?: string }).preload;
    prefs.nodeIntegration = false; prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true; prefs.sandbox = true; prefs.webSecurity = true;
    if (!/^(https?:|about:blank)/.test(params.src ?? "") || params.partition !== "persist:browser-pane") e.preventDefault();
  });
  win.webContents.on("did-attach-webview", (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) import("electron").then(({ shell }) => shell.openExternal(url));
      return { action: "deny" };
    });
    contents.on("will-navigate", (e, url) => { if (!/^https?:/.test(url)) e.preventDefault(); });
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  win.on("closed", () => { win = null; });

  // AGENTS_GUI_SCREENSHOT=out.png [AGENTS_GUI_SCREENSHOT_DELAY=ms]: capture the window, then quit.
  const shot = process.env.AGENTS_GUI_SCREENSHOT;
  if (shot) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        // AGENTS_GUI_SCREENSHOT_JS: optional script run in the page first (e.g. to type into the input box).
        const js = process.env.AGENTS_GUI_SCREENSHOT_JS;
        if (js) {
          const result = await win!.webContents.executeJavaScript(js).catch((e) => `error: ${e}`);
          // AGENTS_GUI_SCREENSHOT_OUT: where to save what the script returned (for layout checks).
          if (process.env.AGENTS_GUI_SCREENSHOT_OUT) writeFileSync(process.env.AGENTS_GUI_SCREENSHOT_OUT, JSON.stringify(result, null, 1));
          await new Promise((r) => setTimeout(r, 600));
        }
        const img = await win!.webContents.capturePage();
        writeFileSync(shot, img.toPNG());
        app.quit();
      }, Number(process.env.AGENTS_GUI_SCREENSHOT_DELAY ?? 8000));
    });
  }
}

ipcMain.handle("session:create", (_e, agent: AgentId, cwd: string, resumeId?: string, permissionMode?: string, cloud?: string, fork?: boolean) => manager.create(agent, cwd, resumeId, permissionMode, cloud, fork));
// Codex Cloud tasks: show a task's diff, or apply it to a local folder. Task ids are checked before use.
ipcMain.handle("cloud:run", (_e, action: "diff" | "apply", taskId: string, cwd?: string, cols?: number, rows?: number) => {
  if (!/^[\w-]{3,120}$/.test(taskId) || (action !== "diff" && action !== "apply")) throw new Error("Unknown cloud task.");
  // "diff" runs from a private folder (Codex Cloud writes a debug log where it runs); "apply" must run in the chosen folder.
  const where = action === "apply" && cwd ? cwd : join(app.getPath("temp"), "agent-zoo-codex-cloud");
  mkdirSync(where, { recursive: true });
  return manager.runUtility("codex", ["cloud", action, taskId], cols, rows, where);
});
ipcMain.handle("app:accounts", () => accounts());
// Mascot packs the user adds (see mascots.ts).
ipcMain.handle("mascots:list", () => mascots?.list() ?? []);
ipcMain.handle("mascots:open", () => (mascots ? import("electron").then(({ shell }) => shell.openPath(mascots!.dir)) : undefined));
ipcMain.handle("mascots:remove", (_e, id: string) => mascots?.remove(id));
ipcMain.handle("mascots:newFolder", (_e, name: string) => mascots?.newFolder(name));
ipcMain.handle("mascots:import", async () => {
  const r = await dialog.showOpenDialog(win!, {
    title: "Import a mascot: pick an SVG file, or a pack folder with mascot.svg",
    properties: ["openFile", "openDirectory"], filters: [{ name: "Mascot", extensions: ["svg"] }],
  });
  const source = r.canceled ? undefined : r.filePaths[0];
  return source && mascots ? mascots.import(source) : null;
});
// Refresh buttons: re-read plan limits for one agent, or all. No messages are sent.
ipcMain.handle("usage:refresh", async (_e, agent?: AgentId) => {
  const apply = (evs: AgentEvent[]) => evs.forEach((e) => { if (e.kind === "limits") usage?.update(e.limits); });
  const jobs: Promise<unknown>[] = [];
  if (!agent || agent === "claude") {
    jobs.push((manager.claudeQuery("get_usage") ?? claudeUsageOnce(app.getPath("home"))).then((r) => apply(claudeUsageLimits(r as Record<string, any>))).catch(() => {}));
  }
  if (!agent || agent === "codex") jobs.push(codexLimitsNow(apply).catch(() => {}));
  if (!agent || agent === "grok") jobs.push(grokUsage(app.getPath("userData")).then((l) => { if (l) usage?.update(l); }).catch(() => {}));
  await Promise.all(jobs);
  return usage?.all() ?? {};
});
ipcMain.handle("account:run", (_e, agent: AgentId, action: "login" | "logout", cols?: number, rows?: number) => {
  const cmd = ACCOUNT_COMMANDS[agent]?.[action];
  if (!cmd) throw new Error("Unknown account action.");
  return manager.runUtility(cmd[0]!, cmd.slice(1), cols, rows);
});
ipcMain.handle("account:close", (_e, id: string) => manager.closeUtility(id));
ipcMain.handle("shell:open", (_e, sessionId: string, cols?: number, rows?: number) => manager.openShell(sessionId, cols, rows));
ipcMain.handle("shell:close", (_e, id: string) => manager.closeShell(id));
// The Files pane: only inside an open session's own folder (files.ts refuses anything outside it).
const folderFor = (sessionId: string) => {
  const root = manager.folderOf(sessionId);
  if (!root) throw new Error("This session has no folder on this computer.");
  return root;
};
// Web servers listening on this computer (for the Browser pane's quick links).
ipcMain.handle("browser:servers", () => localServers());
ipcMain.handle("files:list", (_e, sessionId: string, rel: string) => listDir(folderFor(sessionId), rel));
ipcMain.handle("files:read", (_e, sessionId: string, rel: string) => readFileFor(folderFor(sessionId), rel));
ipcMain.handle("files:stat", (_e, sessionId: string, rel: string) => fileStat(folderFor(sessionId), rel));
ipcMain.handle("files:write", (_e, sessionId: string, rel: string, text: string, expectMtime?: number) => writeFileFor(folderFor(sessionId), rel, text, expectMtime));
ipcMain.handle("files:reveal", async (_e, sessionId: string, rel: string) => {
  const { inside } = await import("./files");
  const { shell } = await import("electron");
  shell.showItemInFolder(await inside(folderFor(sessionId), rel));
});
// Claude Code's voice mode setting (~/.claude/settings.json); only these two fields are read.
ipcMain.handle("claude:voiceOn", () => {
  try {
    const cfg = JSON.parse(readFileSync(join(app.getPath("home"), ".claude", "settings.json"), "utf8"));
    return cfg?.voice?.enabled === true || cfg?.voiceEnabled === true;
  } catch { return false; }
});
ipcMain.handle("codex:dictationReady", (event) => {
  if (event.sender !== win?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("Dictation is available in the app window.");
  codexDictationKey();
});
ipcMain.handle("codex:transcribe", (event, audio: unknown) => {
  if (event.sender !== win?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("Dictation is available in the app window.");
  return transcribeCodexAudio(audio);
});
ipcMain.handle("codex:voiceOpen", (_event, sessionId: string) => manager.openCodexVoice(sessionId));
// "Bring it here": close the copy of a Claude conversation running elsewhere once its turn is
// over, so the app can reopen it with everything it did. Progress goes to the page as it waits.
const takeovers = new Map<string, { cancelled: boolean }>();
ipcMain.handle("session:takeOver", async (_e, sessionId: string, now?: boolean) => {
  if (typeof sessionId !== "string" || !/^[\w-]{8,80}$/.test(sessionId)) throw new Error("Unknown session.");
  const job = { cancelled: false };
  const prev = takeovers.get(sessionId);
  if (prev) prev.cancelled = true;
  takeovers.set(sessionId, job);
  try {
    return await takeOverClaude(sessionId, { now, cancelled: () => job.cancelled, onWaiting: (status) => win?.webContents.send("takeover:waiting", sessionId, status) });
  } finally { if (takeovers.get(sessionId) === job) takeovers.delete(sessionId); }
});
ipcMain.handle("session:takeOverCancel", (_e, sessionId: string) => { const j = takeovers.get(sessionId); if (j) j.cancelled = true; });
ipcMain.handle("update:get", () => updateState());
ipcMain.handle("app:focus", () => { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); });
ipcMain.handle("update:install", () => installUpdate());
ipcMain.handle("usage:get", () => usage?.all() ?? {});
ipcMain.handle("sessions:past", (_e, fresh?: boolean) => pastSessions((patches) => patches.forEach((p) => usage?.update(p)), fresh));
ipcMain.handle("session:command", (_e, id: string, cmd: SessionCommand) => manager.command(id, cmd));
ipcMain.handle("session:query", (_e, id: string, subtype: string, payload?: Record<string, unknown>) => manager.query(id, subtype, payload));
ipcMain.handle("session:close", (_e, id: string) => manager.close(id));
ipcMain.handle("session:view", (_e, id: string, view: "gui" | "terminal", cols?: number, rows?: number, typeOnOpen?: string) => manager.setView(id, view, cols, rows, typeOnOpen));
ipcMain.on("term:input", (_e, id: string, data: string) => manager.termInput(id, data));
ipcMain.on("term:resize", (_e, id: string, cols: number, rows: number) => manager.termResize(id, cols, rows));
ipcMain.handle("dialog:pickFolder", async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"], title: "Choose a project folder" });
  return r.canceled ? null : r.filePaths[0] ?? null;
});
ipcMain.handle("app:info", () => ({
  home: app.getPath("home"),
  user: (() => { try { return userInfo().username; } catch { return ""; } })(),
  version: app.getVersion(),
  cwd: process.env.AGENTS_GUI_CWD || process.cwd(),
  // Screenshot runs start themselves: a replay's agent comes from the fixture's name, or AGENTS_GUI_AUTOSTART names one.
  autoStart: process.env.AGENTS_GUI_SCREENSHOT
    ? (process.env.AGENTS_GUI_AUTOSTART as "claude" | "codex" | "grok" | undefined)
      ?? (process.env.AGENTS_GUI_REPLAY ? (["codex", "grok", "claude"] as const).find((a) => process.env.AGENTS_GUI_REPLAY!.includes(a)) ?? "claude" : null)
    : null,
  autoView: process.env.AGENTS_GUI_SCREENSHOT && process.env.AGENTS_GUI_AUTOVIEW === "terminal" ? "terminal" : null,
  autoPrompt: process.env.AGENTS_GUI_SCREENSHOT ? process.env.AGENTS_GUI_AUTOPROMPT ?? null : null,
  autoType: process.env.AGENTS_GUI_SCREENSHOT ? process.env.AGENTS_GUI_AUTOTYPE ?? null : null,
}));

app.whenReady().then(async () => {
  // Installed copies start from the desktop menu, without a terminal's PATH (see env.ts).
  if (app.isPackaged) await loadShellPath();
  usage = new UsageStore((all) => win?.webContents.send("usage:update", all));
  mascots = new MascotStore(join(app.getPath("userData"), "mascots"));
  // New or edited packs (including ones Claude draws in "Make a mascot") show up by themselves.
  let mascotTimer: NodeJS.Timeout | undefined;
  try {
    watch(mascots.dir, { recursive: true }, () => { clearTimeout(mascotTimer); mascotTimer = setTimeout(() => win?.webContents.send("mascots:changed"), 800); });
  } catch { /* watching isn't available */ }
  const endpoint = claudeEndpoint();
  if (endpoint) usage.update({ agent: "claude", endpoint });
  createWindow();
  if (!process.env.AGENTS_GUI_SCREENSHOT || process.env.AGENTS_GUI_UPDATE_URL || process.env.AGENTS_GUI_FAKE_UPDATE) startUpdates(() => win);
  // Sessions saved by Claude anywhere (including plain terminals) show up in the sidebar.
  watchClaudeSessions(() => win?.webContents.send("sessions:changed"));
  // Grok's plan limits are read from its own /usage screen: at launch, then every 15 minutes.
  // Screenshot runs skip this so tests never start Grok.
  if (!process.env.AGENTS_GUI_SCREENSHOT || process.env.AGENTS_GUI_GROK_USAGE) {
    const readGrok = () => grokUsage(app.getPath("userData")).then((l) => { if (l) usage?.update(l); }).catch(() => {});
    setTimeout(readGrok, 4000);
    setInterval(readGrok, 15 * 60_000).unref();
  }
});
app.on("window-all-closed", () => { manager.closeAll(); app.quit(); });
app.on("before-quit", () => manager.closeAll());
