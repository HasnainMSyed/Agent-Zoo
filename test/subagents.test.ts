import { describe, expect, it } from "vitest";
import { subagentsOf } from "../src/renderer/src/components/Subagents";
import type { Item } from "../src/renderer/src/state";

const tool = (id: string, extra: Partial<Extract<Item, { type: "tool" }>> = {}): Item =>
  ({ type: "tool", id, tool: "subagent", name: "Task", title: `task ${id}`, input: {}, children: [], ...extra }) as Item;

describe("subagents panel", () => {
  it("shows running ones first, with their latest step", () => {
    const items: Item[] = [
      tool("a", { ok: true }),
      tool("b", { children: [{ type: "tool", id: "c", tool: "read", name: "Read", title: "Read App.tsx", input: {}, children: [] }] }),
    ];
    const list = subagentsOf(items);
    expect(list.map((s) => [s.id, s.state, s.doing])).toEqual([["b", "working", "Read App.tsx"], ["a", "done", "Finished"]]);
    expect(list[0]!.steps).toBe(1);
  });
});
