// App preferences, kept in this computer's local storage. Applied to the page by applySettings.

import type { AgentId } from "@shared/events";

export interface Settings {
  displayName: string;                 // empty = the computer's user name
  theme: "system" | "light" | "dark";
  skin: "agent" | AgentId | "custom";  // "agent": the colours follow whichever agent is open; "custom": customTheme
  customTheme: CustomTheme;
  agentColors: Record<AgentId, string>; // session dots and agent markers
  textSize: "small" | "default" | "large";
  reduceMotion: boolean;
  showMascots: boolean;
  mascots: Partial<Record<AgentId, string>>; // chosen pack id per agent (built-in or "user:<folder>")
  defaultAgent: "last" | AgentId;
  claudeMode: string;                  // permission mode new Claude sessions start in
  reopenLast: boolean;                 // at launch, reopen the session you were last in
  alerts: "background" | "always" | "off"; // desktop alerts when an agent finishes or needs you
  sound: "off" | "chime" | "pop" | "bell";  // played with an alert
  askFeedback: boolean;                // now and then, Settings asks how the app is doing
}

/** The colours a custom theme can change (CSS tokens), with their names in Settings. */
export const THEME_TOKENS = [
  ["--accent", "Accent"], ["--on-accent", "Text on accent"], ["--canvas", "Background"], ["--sidebar", "Sidebar"],
  ["--surface", "Cards"], ["--surface-2", "Raised"], ["--line", "Lines"], ["--text", "Text"], ["--muted", "Quiet text"], ["--link", "Links"],
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number][0];
/** A custom theme: an agent's palette as the base, with any colours changed, separately for light and dark. */
export interface CustomTheme { base: AgentId; light: Partial<Record<ThemeToken, string>>; dark: Partial<Record<ThemeToken, string>> }
export const CUSTOM_DEFAULT: CustomTheme = { base: "claude", light: {}, dark: {} };

/** Reads a shared theme (JSON), keeping only known tokens and colour values. */
export function parseTheme(text: string): CustomTheme | null {
  try {
    const raw = JSON.parse(text);
    const base = ["claude", "codex", "grok"].includes(raw?.base) ? raw.base as AgentId : "claude";
    const clean = (o: unknown) => Object.fromEntries(Object.entries((o ?? {}) as Record<string, unknown>)
      .filter(([k, v]) => THEME_TOKENS.some(([t]) => t === k) && typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)));
    return { base, light: clean(raw?.light), dark: clean(raw?.dark) };
  } catch { return null; }
}

export const AGENT_COLOR_DEFAULTS: Record<AgentId, string> = { claude: "#e07b55", codex: "#19c37d", grok: "#9b7bff" };

export const DEFAULT_SETTINGS: Settings = {
  displayName: "", theme: "system", skin: "agent", agentColors: AGENT_COLOR_DEFAULTS,
  textSize: "default", reduceMotion: false, showMascots: true, mascots: {}, defaultAgent: "last", claudeMode: "default",
  reopenLast: true,
  alerts: "background", sound: "off", askFeedback: true,
  customTheme: CUSTOM_DEFAULT,
};

const KEY = "zoo.settings";

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...raw, agentColors: { ...AGENT_COLOR_DEFAULTS, ...raw.agentColors }, customTheme: { ...CUSTOM_DEFAULT, ...raw.customTheme } };
  } catch { return DEFAULT_SETTINGS; }
}

/** Settings → Technical → Paste settings: known keys from a copied settings object, over the defaults. */
export function parseSettings(text: string): Settings | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const known = Object.fromEntries(Object.entries(raw).filter(([k, v]) => k in DEFAULT_SETTINGS && typeof v === typeof DEFAULT_SETTINGS[k as keyof Settings]));
    if (!Object.keys(known).length) return null;
    const s = { ...DEFAULT_SETTINGS, ...known } as Settings;
    return { ...s, agentColors: { ...AGENT_COLOR_DEFAULTS, ...s.agentColors }, customTheme: parseTheme(JSON.stringify(s.customTheme)) ?? CUSTOM_DEFAULT };
  } catch { return null; }
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

