import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, AgentId, SessionCommand, SessionInfo } from "@shared/events";
import type { AccountInfo, PastSession, UsageLimits } from "@shared/commands";

const api = {
  /** fork: open a copy of the resumed conversation (Claude and Codex). */
  createSession: (agent: AgentId, cwd: string, resumeId?: string, permissionMode?: string, cloud?: string, fork?: boolean): Promise<SessionInfo> => ipcRenderer.invoke("session:create", agent, cwd, resumeId, permissionMode, cloud, fork),
  cloudRun: (action: "diff" | "apply", taskId: string, cwd?: string): Promise<string> => ipcRenderer.invoke("cloud:run", action, taskId, cwd),
  onSessionsChanged(cb: () => void) {
    const listener = () => cb();
    ipcRenderer.on("sessions:changed", listener);
    return () => { ipcRenderer.removeListener("sessions:changed", listener); };
  },
  mascots: {
    list: (): Promise<{ id: string; name: string; agent?: string; description: string; svg: string; user: true }[]> => ipcRenderer.invoke("mascots:list"),
    import: (): Promise<string | null> => ipcRenderer.invoke("mascots:import"),
    open: (): Promise<void> => ipcRenderer.invoke("mascots:open"),
    remove: (id: string): Promise<void> => ipcRenderer.invoke("mascots:remove", id),
    newFolder: (name: string): Promise<string> => ipcRenderer.invoke("mascots:newFolder", name),
    onChanged(cb: () => void) {
      const listener = () => cb();
      ipcRenderer.on("mascots:changed", listener);
      return () => { ipcRenderer.removeListener("mascots:changed", listener); };
    },
  },
  accounts: (): Promise<Record<AgentId, AccountInfo>> => ipcRenderer.invoke("app:accounts"),
  /** Runs an agent's own sign-in or sign-out in a small terminal; returns its terminal id. */
  accountRun: (agent: AgentId, action: "login" | "logout", cols?: number, rows?: number): Promise<string> => ipcRenderer.invoke("account:run", agent, action, cols, rows),
  accountClose: (id: string): Promise<void> => ipcRenderer.invoke("account:close", id),
  /** A shell in a session's folder for the Terminal pane; returns its terminal id. */
  shellOpen: (sessionId: string, cols?: number, rows?: number): Promise<string> => ipcRenderer.invoke("shell:open", sessionId, cols, rows),
  shellClose: (id: string): Promise<void> => ipcRenderer.invoke("shell:close", id),
  /** A new version: whether one is downloading or ready, and restarting into it. */
  updateState: (): Promise<{ status: "idle" | "downloading" | "ready" | "error"; version?: string; percent?: number; error?: string }> => ipcRenderer.invoke("update:get"),
  updateInstall: (): Promise<void> => ipcRenderer.invoke("update:install"),
  onUpdate(cb: (s: { status: "idle" | "downloading" | "ready" | "error"; version?: string; percent?: number; error?: string }) => void) {
    const listener = (_: unknown, s: Parameters<typeof cb>[0]) => cb(s);
    ipcRenderer.on("update:state", listener);
    return () => { ipcRenderer.removeListener("update:state", listener); };
  },
  /** Local web servers (dev servers) for the Browser pane: port and the program listening. */
  browserServers: (): Promise<{ port: number; name?: string }[]> => ipcRenderer.invoke("browser:servers"),
  /** The Files pane: a session's folder (paths are relative to it). */
  files: {
    list: (sessionId: string, rel: string): Promise<{ name: string; dir: boolean }[]> => ipcRenderer.invoke("files:list", sessionId, rel),
    read: (sessionId: string, rel: string): Promise<
      | { kind: "text"; text: string; mtime: number; size: number }
      | { kind: "image"; dataUrl: string; mtime: number; size: number }
      | { kind: "binary" | "too-big"; mtime: number; size: number }> => ipcRenderer.invoke("files:read", sessionId, rel),
    stat: (sessionId: string, rel: string): Promise<{ mtime: number; size: number } | null> => ipcRenderer.invoke("files:stat", sessionId, rel),
    write: (sessionId: string, rel: string, text: string, expectMtime?: number): Promise<{ mtime: number }> => ipcRenderer.invoke("files:write", sessionId, rel, text, expectMtime),
    reveal: (sessionId: string, rel: string): Promise<void> => ipcRenderer.invoke("files:reveal", sessionId, rel),
  },
  /** Brings the app window forward (clicking a desktop alert). */
  focusWindow: (): Promise<void> => ipcRenderer.invoke("app:focus"),
  /** Whether Claude Code's voice mode (/voice) is switched on in its settings. */
  claudeVoiceOn: (): Promise<boolean> => ipcRenderer.invoke("claude:voiceOn"),
  codexDictationReady: (): Promise<void> => ipcRenderer.invoke("codex:dictationReady"),
  transcribeCodexAudio: (audio: ArrayBuffer): Promise<string> => ipcRenderer.invoke("codex:transcribe", audio),
  openCodexVoice: (sessionId: string): Promise<void> => ipcRenderer.invoke("codex:voiceOpen", sessionId),
  /** Closes the copy of a Claude conversation running elsewhere once its turn is over (now: don't wait). */
  takeOver: (sessionId: string, now?: boolean): Promise<"closed" | "gone"> => ipcRenderer.invoke("session:takeOver", sessionId, now),
  takeOverCancel: (sessionId: string): Promise<void> => ipcRenderer.invoke("session:takeOverCancel", sessionId),
  onTakeOverWaiting(cb: (sessionId: string, status: string) => void) {
    const listener = (_: unknown, id: string, status: string) => cb(id, status);
    ipcRenderer.on("takeover:waiting", listener);
    return () => { ipcRenderer.removeListener("takeover:waiting", listener); };
  },
  usage: (): Promise<Partial<Record<AgentId, UsageLimits>>> => ipcRenderer.invoke("usage:get"),
  /** Re-reads plan limits (one agent, or all when omitted). */
  refreshUsage: (agent?: AgentId): Promise<Partial<Record<AgentId, UsageLimits>>> => ipcRenderer.invoke("usage:refresh", agent),
  pastSessions: (fresh?: boolean): Promise<PastSession[]> => ipcRenderer.invoke("sessions:past", fresh),
  onUsage(cb: (all: Partial<Record<AgentId, UsageLimits>>) => void) {
    const listener = (_: unknown, all: Partial<Record<AgentId, UsageLimits>>) => cb(all);
    ipcRenderer.on("usage:update", listener);
    return () => { ipcRenderer.removeListener("usage:update", listener); };
  },
  command: (id: string, cmd: SessionCommand): Promise<void> => ipcRenderer.invoke("session:command", id, cmd),
  /** Data for a panel (Claude's /mcp, /status, /context) or a setting change, straight from the agent. */
  query: (id: string, subtype: string, payload?: Record<string, unknown>): Promise<any> => ipcRenderer.invoke("session:query", id, subtype, payload),
  closeSession: (id: string): Promise<void> => ipcRenderer.invoke("session:close", id),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("dialog:pickFolder"),
  info: (): Promise<{ home: string; user: string; version: string; cwd: string; autoStart: AgentId | null; autoView: "terminal" | null; autoPrompt: string | null; autoType: string | null }> => ipcRenderer.invoke("app:info"),
  setView: (id: string, view: "gui" | "terminal", cols?: number, rows?: number, typeOnOpen?: string): Promise<void> => ipcRenderer.invoke("session:view", id, view, cols, rows, typeOnOpen),
  termInput: (id: string, data: string) => ipcRenderer.send("term:input", id, data),
  termResize: (id: string, cols: number, rows: number) => ipcRenderer.send("term:resize", id, cols, rows),
  onTermData(cb: (sessionId: string, chunk: string) => void) {
    const listener = (_: unknown, id: string, chunk: string) => cb(id, chunk);
    ipcRenderer.on("term:data", listener);
    return () => { ipcRenderer.removeListener("term:data", listener); };
  },
  onEvent(cb: (sessionId: string, e: AgentEvent) => void) {
    const listener = (_: unknown, id: string, e: AgentEvent) => cb(id, e);
    ipcRenderer.on("session:event", listener);
    return () => { ipcRenderer.removeListener("session:event", listener); };
  },
};

export type AgentsApi = typeof api;
contextBridge.exposeInMainWorld("agents", api);
