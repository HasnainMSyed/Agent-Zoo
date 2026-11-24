// The Terminal view: runs an agent's real terminal interface in a pseudo-terminal,
// so every feature of the agent (menus, slash commands, login) stays available.

import { agentEnv } from "./env";
import { spawn as spawnPty, type IPty } from "node-pty";

export interface TerminalCallbacks {
  data(chunk: string): void;
  exit(code: number): void;
}

export class TerminalSession {
  private pty: IPty;
  private closing = false;

  constructor(command: string, args: string[], cwd: string, cb: TerminalCallbacks, cols = 100, rows = 30) {
    this.pty = spawnPty(command, args, {
      name: "xterm-256color", cwd, cols, rows,
      env: agentEnv({ TERM: "xterm-256color", COLORTERM: "truecolor" }),
    });
    this.pty.onData(cb.data);
    this.pty.onExit(({ exitCode }) => { if (!this.closing) cb.exit(exitCode); });
  }

  write(data: string) { this.pty.write(data); }

  resize(cols: number, rows: number) {
    if (cols > 0 && rows > 0) this.pty.resize(Math.floor(cols), Math.floor(rows));
  }

  close() {
    this.closing = true;
    try { this.pty.kill(); } catch { /* already gone */ }
  }
}
