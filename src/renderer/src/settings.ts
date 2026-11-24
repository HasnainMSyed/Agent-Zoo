// App preferences, kept in this computer's local storage. Applied to the page by applySettings.

import type { AgentId } from "@shared/events";

export interface Settings {
  displayName: string;                 // empty = the computer's user name
  theme: "system" | "light" | "dark";
  skin: "agent" | AgentId;             // "agent": the colours follow whichever agent is open
  agentColors: Record<AgentId, string>; // session dots and agent markers
  textSize: "small" | "default" | "large";
  reduceMotion: boolean;
  showMascots: boolean;
  mascots: Partial<Record<AgentId, string>>; // chosen pack id per agent (built-in or "user:<folder>")
  defaultAgent: "last" | AgentId;
  claudeMode: string;                  // permission mode new Claude sessions start in
}

export const AGENT_COLOR_DEFAULTS: Record<AgentId, string> = { claude: "#e07b55", codex: "#19c37d", grok: "#9b7bff" };

export const DEFAULT_SETTINGS: Settings = {
  displayName: "", theme: "system", skin: "agent", agentColors: AGENT_COLOR_DEFAULTS,
  textSize: "default", reduceMotion: false, showMascots: true, mascots: {}, defaultAgent: "last", claudeMode: "default",
};

const KEY = "zoo.settings";

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...raw, agentColors: { ...AGENT_COLOR_DEFAULTS, ...raw.agentColors } };
  } catch { return DEFAULT_SETTINGS; }
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

const ZOOM: Record<Settings["textSize"], string> = { small: "0.92", default: "1", large: "1.1" };

/** Puts the page-wide preferences on <html>; per-agent colours go on .app (see App). */
export function applySettings(s: Settings) {
  const root = document.documentElement;
  if (s.theme === "system") delete root.dataset.theme; else root.dataset.theme = s.theme;
  root.style.colorScheme = s.theme === "system" ? "light dark" : s.theme;
  root.style.setProperty("zoom", ZOOM[s.textSize]);
  root.classList.toggle("reduce-motion", s.reduceMotion);
  root.classList.toggle("no-mascots", !s.showMascots);
}
