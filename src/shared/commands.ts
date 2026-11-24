// Slash commands and model options, shared by the adapters and the input box's "/" menu.

/** How the app carries out a command:
 *  send     - passed to the agent as a message (it handles the command itself)
 *  action   - the app calls a protocol method for it (Codex /compact, /new)
 *  model    - opens the model picker
 *  effort   - opens the effort picker
 *  terminal - only exists in the agent's own terminal interface; opens the Terminal view and types it */
export type CommandRun = "send" | "action" | "model" | "effort" | "terminal";

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

/** A conversation saved by an agent, for the home screen and sidebar. */
export interface PastSession { agent: "claude" | "codex" | "grok"; id: string; cwd: string; title: string; updatedAt: number }
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
  for (const c of own) if (!out.has(c.name)) out.set(c.name, terminalNames.includes(c.name) ? { ...c, run: "terminal" } : c);
  for (const [name, description] of TERMINAL_ONLY[agent]) if (!out.has(name)) out.set(name, { name, description, run: "terminal" });
  return [...out.values()];
}
