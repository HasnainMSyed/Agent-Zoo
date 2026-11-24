// The right panel's Subagents section: every subagent the session started, each with its own small
// mascot, its task, and what it's doing right now (from its latest step). Running ones come first.

import type { Item } from "../state";
import type { MascotPack } from "../mascots";
import { Mascot } from "./Mascot";

type ToolItem = Extract<Item, { type: "tool" }>;

export interface SubagentView { id: string; title: string; state: "working" | "thinking" | "done" | "error" | "waiting"; doing: string; steps: number }

function collect(items: Item[], out: ToolItem[] = []): ToolItem[] {
  for (const it of items) if (it.type === "tool") { if (it.tool === "subagent") out.push(it); collect(it.children, out); }
  return out;
}

/** What a subagent is doing now, from its newest step. */
function activity(t: ToolItem): { doing: string; state: SubagentView["state"] } {
  if (t.ok === false) return { doing: "Failed", state: "error" };
  if (t.ok !== undefined) return { doing: "Finished", state: "done" };
  const last = t.children[t.children.length - 1];
  if (!last) return { doing: "Starting…", state: "thinking" };
  if (last.type === "tool") return { doing: last.title, state: "working" };
  if (last.type === "thinking") return { doing: "Thinking…", state: "thinking" };
  if (last.type === "assistant") return { doing: last.streaming ? "Writing its answer…" : last.text.replace(/\s+/g, " ").slice(0, 80), state: "working" };
  if (last.type === "permission") return { doing: `Needs approval: ${last.title}`, state: "waiting" };
  return { doing: "Working…", state: "working" };
}

export function subagentsOf(items: Item[]): SubagentView[] {
  const list = collect(items).map((t) => ({ id: t.id, title: t.title, steps: t.children.filter((c) => c.type === "tool").length, ...activity(t) }));
  const running = list.filter((s) => s.state !== "done" && s.state !== "error");
  return [...running, ...list.filter((s) => !running.includes(s)).reverse()];
}

export function Subagents({ list, pack }: { list: SubagentView[]; pack?: MascotPack }) {
  if (!list.length) return <p className="muted small">Subagents the agent starts show up here, with what each one is doing.</p>;
  return (
    <ul className="subagents">
      {list.slice(0, 12).map((s) => (
        <li key={s.id} className={`subagent ${s.state}`}>
          <Mascot pack={pack} state={s.state} size={30} />
          <div className="sa-text">
            <strong title={s.title}>{s.title}</strong>
            <span title={s.doing}>{s.doing}{s.steps ? ` · ${s.steps} step${s.steps === 1 ? "" : "s"}` : ""}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
