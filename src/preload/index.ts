import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, AgentId, SessionCommand, SessionInfo } from "@shared/events";
import type { AccountInfo, PastSession, UsageLimits } from "@shared/commands";

const api = {
  createSession: (agent: AgentId, cwd: string, resumeId?: string, permissionMode?: string, cloud?: string): Promise<SessionInfo> => ipcRenderer.invoke("session:create", agent, cwd, resumeId, permissionMode, cloud),
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
