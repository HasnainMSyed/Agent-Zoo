// Remembers the latest plan usage and billing for each agent, so the home screen can show it
// between sessions. Stored in the app's data folder; never stores an API key.

import { app } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageLimits } from "@shared/commands";

type Agent = UsageLimits["agent"];
const file = () => join(app.getPath("userData"), "usage.json");

export class UsageStore {
  private data: Partial<Record<Agent, UsageLimits>> = {};

  constructor(private onChange: (all: Partial<Record<Agent, UsageLimits>>) => void) {
    try { this.data = JSON.parse(readFileSync(file(), "utf8")); } catch { this.data = {}; }
  }

  all() { return this.data; }

  /** Merges a partial update: present fields replace, windows replace by label. */
  update(patch: Partial<UsageLimits> & { agent: Agent }) {
    const prev: UsageLimits = this.data[patch.agent] ?? { agent: patch.agent, windows: [], updatedAt: 0 };
    const windows = patch.windows
      ? [...prev.windows.filter((w) => !patch.windows!.some((n) => n.label === w.label)), ...patch.windows]
          .sort((a, b) => (a.label === "5-hour" ? -1 : b.label === "5-hour" ? 1 : 0))
      : prev.windows;
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    this.data[patch.agent] = { ...prev, ...defined, windows, updatedAt: Date.now() };
    try { writeFileSync(file(), JSON.stringify(this.data, null, 2)); } catch { /* best effort */ }
    this.onChange(this.data);
  }
}
