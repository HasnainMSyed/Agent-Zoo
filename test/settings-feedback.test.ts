import { beforeEach, describe, expect, it, vi } from "vitest";

// The renderer keeps these in local storage; a Map stands in for it here.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 26);

describe("shouldAskFeedback", () => {
  beforeEach(() => { store.clear(); vi.resetModules(); });
  const fresh = async () => (await import("../src/renderer/src/components/Feedback")).shouldAskFeedback;

  it("waits two days after the first visit", async () => {
    const ask = await fresh();
    expect(ask(now, 0)).toBe(false);
    expect(JSON.parse(store.get("zoo.feedback")!).firstSeen).toBeTypeOf("number");
  });

  it("asks on about one visit in four once due, and only once per run", async () => {
    store.set("zoo.feedback", JSON.stringify({ firstSeen: now - 3 * DAY, lastShown: 0, lastAnswered: 0, entries: [] }));
    const ask = await fresh();
    expect(ask(now, 0.9)).toBe(false);
    expect(ask(now, 0.1)).toBe(true);
    expect(ask(now, 0.1)).toBe(false);
    expect(JSON.parse(store.get("zoo.feedback")!).lastShown).toBe(now);
  });

  it("leaves a week after showing and a month after an answer", async () => {
    store.set("zoo.feedback", JSON.stringify({ firstSeen: now - 90 * DAY, lastShown: now - 3 * DAY, lastAnswered: 0, entries: [] }));
    expect((await fresh())(now, 0)).toBe(false);
    vi.resetModules();
    store.set("zoo.feedback", JSON.stringify({ firstSeen: now - 90 * DAY, lastShown: now - 10 * DAY, lastAnswered: now - 20 * DAY, entries: [] }));
    expect((await fresh())(now, 0)).toBe(false);
    vi.resetModules();
    store.set("zoo.feedback", JSON.stringify({ firstSeen: now - 90 * DAY, lastShown: now - 10 * DAY, lastAnswered: now - 40 * DAY, entries: [] }));
    expect((await fresh())(now, 0)).toBe(true);
  });
});

describe("parseSettings", () => {
  it("keeps known settings of the right type over the defaults", async () => {
    const { parseSettings, DEFAULT_SETTINGS } = await import("../src/renderer/src/settings");
    const s = parseSettings(JSON.stringify({ theme: "dark", reopenLast: "yes", bogus: 1, agentColors: { claude: "#000000" } }));
    expect(s?.theme).toBe("dark");
    expect(s?.reopenLast).toBe(DEFAULT_SETTINGS.reopenLast);
    expect(s && "bogus" in s).toBe(false);
    expect(s?.agentColors.codex).toBe(DEFAULT_SETTINGS.agentColors.codex);
    expect(s?.agentColors.claude).toBe("#000000");
  });

  it("rejects text that isn't settings", async () => {
    const { parseSettings } = await import("../src/renderer/src/settings");
    expect(parseSettings("hello")).toBeNull();
    expect(parseSettings("[1,2]")).toBeNull();
    expect(parseSettings(JSON.stringify({ nothing: true }))).toBeNull();
  });
});
