import { describe, expect, it } from "vitest";
import { parseGrokUsage } from "../src/main/grok-usage";

describe("Grok /usage screen", () => {
  it("reads the plan, the percentage and the reset time", () => {
    const screen = "\x1b[1m│ Weekly limit (SuperGrok)        │\x1b[0m\r\n│ ███░░░░░░░░░░░░░░ \x1b[33m10%\x1b[0m │\r\n│ Resets: November 28, 00:10 │";
    const r = parseGrokUsage(screen, new Date("2026-11-24T10:00:00"));
    expect(r).toEqual({ agent: "grok", plan: "SuperGrok", windows: [{ label: "Weekly", usedPct: 10, resetsAt: Math.round(Date.parse("November 28, 2026 00:10") / 1000) }] });
  });
  it("returns nothing for a screen without limits", () => {
    expect(parseGrokUsage("Loading session usage…")).toBeNull();
  });
});
