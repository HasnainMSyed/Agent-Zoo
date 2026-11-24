import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, AgentId, SessionCommand, SessionInfo } from "@shared/events";

const api = {
  createSession: (agent: AgentId, cwd: string): Promise<SessionInfo> => ipcRenderer.invoke("session:create", agent, cwd),
  command: (id: string, cmd: SessionCommand): Promise<void> => ipcRenderer.invoke("session:command", id, cmd),
  closeSession: (id: string): Promise<void> => ipcRenderer.invoke("session:close", id),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("dialog:pickFolder"),
  info: (): Promise<{ home: string; cwd: string; autoStart: AgentId | null }> => ipcRenderer.invoke("app:info"),
  onEvent(cb: (sessionId: string, e: AgentEvent) => void) {
    const listener = (_: unknown, id: string, e: AgentEvent) => cb(id, e);
    ipcRenderer.on("session:event", listener);
    return () => { ipcRenderer.removeListener("session:event", listener); };
  },
};

export type AgentsApi = typeof api;
contextBridge.exposeInMainWorld("agents", api);
