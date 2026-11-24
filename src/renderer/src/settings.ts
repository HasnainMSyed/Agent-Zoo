// App preferences, kept in this computer's local storage. Applied to the page by applySettings.

import type { AgentId } from "@shared/events";
import { flushSync } from "react-dom";

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

/**
 * Runs a change that re-colours the app (theme, skin, lead mascot) as an animated transition:
 * the new colours spread out in a circle from where you clicked, or cross-fade when there's no
 * click. Skipped when motion is reduced or the browser can't do view transitions.
 */
export function withThemeTransition(update: () => void, from?: { x: number; y: number }) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> } };
  const reduced = document.documentElement.classList.contains("reduce-motion") || matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!doc.startViewTransition || reduced) { update(); return; }
  const root = document.documentElement;
  root.classList.toggle("vt-reveal", Boolean(from));
  const t = doc.startViewTransition(() => flushSync(update));
  t.finished.finally(() => root.classList.remove("vt-reveal")).catch(() => {});
  if (!from) return;
  const r = Math.hypot(Math.max(from.x, innerWidth - from.x), Math.max(from.y, innerHeight - from.y));
  t.ready.then(() => {
    root.animate(
      { clipPath: [`circle(0px at ${from.x}px ${from.y}px)`, `circle(${r}px at ${from.x}px ${from.y}px)`] },
      { duration: 650, easing: "cubic-bezier(.2, .8, .2, 1)", pseudoElement: "::view-transition-new(root)" },
    );
  }).catch(() => { /* transition skipped */ });
}
