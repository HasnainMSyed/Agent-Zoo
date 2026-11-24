// Slash commands and model options, shared by the adapters and the input box's "/" menu.

/** How the app carries out a command:
 *  send     - passed to the agent as a message (it handles the command itself)
 *  action   - the app calls a protocol method for it (Codex /compact, /new)
 *  model    - opens the model picker
 *  effort   - opens the effort picker
 *  terminal - only exists in the agent's own terminal interface; opens the Terminal view and types it
 *  panel    - the app draws it as a panel from data the agent reports (Claude /mcp, /status, /context) */
export type CommandRun = "send" | "action" | "model" | "effort" | "terminal" | "panel";

/** Panels the app draws for Claude's menu-style commands. "mode" has no command; the mode chip opens it. */
export type PanelKind = "mcp" | "status" | "context" | "mode";
export const CLAUDE_PANELS: Record<"mcp" | "status" | "context", string> = {
  mcp: "See and manage MCP servers",
  status: "Show account, model and connection status",
  context: "See what fills the context window",
};

/** Requests a panel may send to each agent; anything else is refused. Codex answers the same names. */
export const CLAUDE_QUERIES = ["mcp_status", "mcp_toggle", "mcp_reconnect", "get_status", "get_context_usage", "get_usage", "set_permission_mode"] as const;
export type ClaudeQuery = (typeof CLAUDE_QUERIES)[number];
export const AGENT_QUERIES: Record<"claude" | "codex" | "grok", readonly string[]> = {
  claude: CLAUDE_QUERIES,
  codex: ["mcp_status", "mcp_reconnect", "get_status", "set_permission_mode"],
  grok: [],
};

/** Codex's access presets, as its /approvals menu offers them. */
export const CODEX_MODES: { id: string; label: string; description: string }[] = [
  { id: "read-only", label: "Read only", description: "Reads files; asks before editing or running anything that changes them" },
  { id: "auto", label: "Auto", description: "Edits and runs commands in this folder; asks before going outside it or online" },
  { id: "full", label: "Full access", description: "Edits anything and uses the network without asking. Only for sandboxes you trust" },
];

/** Panels the app draws for Codex's menu commands (approvals opens the access picker). */
export const CODEX_PANELS: Record<string, { kind: PanelKind; description: string }> = {
  status: { kind: "status", description: "Show session, account and limits" },
  mcp: { kind: "mcp", description: "See MCP servers and reload them" },
  approvals: { kind: "mode", description: "Choose what Codex may do without asking" },
};

/** Claude's permission modes, in the order Shift+Tab cycles through the common ones. */
export const PERMISSION_MODES: { id: string; label: string; description: string }[] = [
  { id: "default", label: "Ask before edits", description: "Asks before editing files or running commands" },
  { id: "acceptEdits", label: "Accept edits", description: "Edits files without asking; still asks before other commands" },
  { id: "plan", label: "Plan", description: "Reads and plans only; changes nothing until you approve a plan" },
  { id: "auto", label: "Auto", description: "Decides for itself which actions are safe to run without asking" },
  { id: "dontAsk", label: "Don't ask", description: "Denies anything not already allowed, instead of asking" },
  { id: "bypassPermissions", label: "Bypass permissions", description: "Runs everything without asking. Only for sandboxes you trust" },
];

export interface SlashCommand { name: string; description: string; hint?: string; run: CommandRun }

/** Plan usage and billing for one agent, as last reported by that agent. */
export interface UsageLimits {
  agent: "claude" | "codex" | "grok";
  plan?: string;                 // e.g. "Claude Pro", "ChatGPT Plus"
  billing?: "subscription" | "api_key" | "other";
  keySource?: string;            // where an API key comes from (never the key itself)
  endpoint?: string;             // a non-default API host, e.g. a third-party proxy
  windows: { label: string; usedPct: number; resetsAt?: number }[]; // resetsAt in epoch seconds
  updatedAt: number;             // epoch ms
}

/** One agent's CLI as the Settings page shows it. Never holds a key or token. */
export interface AccountInfo { installed: boolean; version?: string; signedIn?: boolean; method?: string; plan?: string; who?: string }

/** A conversation saved by an agent, for the home screen and sidebar. */
export interface PastSession {
  agent: "claude" | "codex" | "grok"; id: string; cwd: string; title: string; updatedAt: number;
  /** Claude only: running somewhere else right now (a terminal, an editor), from Claude's own record of running sessions. */
  liveElsewhere?: boolean;
  /** Claude only: what the copy running elsewhere is doing ("busy", "idle" or "waiting" for an answer). */
  liveStatus?: string;
  /** A Codex Cloud task (runs on OpenAI's servers; `cwd` holds its environment's name). */
  cloud?: boolean;
  status?: string;
}
export interface ModelOption { id: string; label: string; description?: string; efforts?: string[] }

/** Menu-style commands that only their terminal interface can show. */
export const TERMINAL_ONLY: Record<"claude" | "codex" | "grok", [string, string][]> = {
  claude: [
    ["plugin", "Browse, install and manage plugins"],
    ["permissions", "View and edit tool permission rules"],
    ["hooks", "View and edit hooks"],
    ["memory", "Edit memory files"],
    ["status", "Show account, model and connection status"],
    ["login", "Sign in or switch accounts"],
    ["logout", "Sign out"],
    ["resume", "Pick an earlier conversation to resume"],
    ["agents", "Manage subagents"],
    ["doctor", "Check the installation"],
    ["help", "Show all commands and shortcuts"],
  ],
  codex: [
    ["review", "Review the current changes"],
    ["diff", "Show the git diff, including untracked files"],
    ["status", "Show session configuration and token usage"],
    ["mcp", "List configured MCP tools"],
    ["approvals", "Choose what Codex may do without asking"],
    ["init", "Create an AGENTS.md file with instructions for Codex"],
    ["resume", "Pick an earlier session to resume"],
    ["logout", "Sign out"],
  ],
  grok: [
    ["login", "Sign in"],
    ["logout", "Sign out"],
    ["resume", "Pick an earlier session to resume"],
    ["help", "Show all commands and shortcuts"],
  ],
};

/** Commands the app always offers as pickers, whatever the agent reports. */
export const PICKERS: SlashCommand[] = [
  { name: "model", description: "Choose the model", run: "model" },
  { name: "effort", description: "Choose how much effort the model spends", run: "effort" },
];

/** Merges an agent's own commands with the pickers and the terminal-only list, without duplicates. */
export function mergeCommands(agent: "claude" | "codex" | "grok", own: SlashCommand[], terminalNames: string[] = []): SlashCommand[] {
  const out = new Map<string, SlashCommand>();
  for (const p of PICKERS) out.set(p.name, p);
  if (agent === "claude") {
    for (const [name, description] of Object.entries(CLAUDE_PANELS)) out.set(name, { name, description: own.find((c) => c.name === name)?.description || description, run: "panel" });
  }
  if (agent === "codex") {
    for (const [name, p] of Object.entries(CODEX_PANELS)) out.set(name, { name, description: p.description, run: "panel" });
  }
  for (const c of own) if (!out.has(c.name)) out.set(c.name, terminalNames.includes(c.name) ? { ...c, run: "terminal" } : c);
  for (const [name, description] of TERMINAL_ONLY[agent]) if (!out.has(name)) out.set(name, { name, description, run: "terminal" });
  return [...out.values()];
}
