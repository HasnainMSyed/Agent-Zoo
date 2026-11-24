// Mascot packs: a folder with mascot.json + mascot.svg (see PLAN.md "Mascot packs").
// Built-in packs are bundled; the user's own packs come from the app's data folder (see main/mascots.ts).

import type { AgentId } from "@shared/events";

export interface MascotPack { id: string; name: string; agent?: AgentId; description: string; svg: string; user?: boolean }

const metas = import.meta.glob<{ id: string; name: string; agent?: AgentId; description: string }>("./packs/*/mascot.json", { eager: true, import: "default" });
const svgs = import.meta.glob<string>("./packs/*/mascot.svg", { eager: true, query: "?raw", import: "default" });

/** Strips anything executable from pack SVG before it is put into the page. */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href\s*=\s*["'])\s*javascript:[^"']*/gi, "$1#")
    // Nothing may load from outside the pack: links other than in-file (#id) or embedded (data:) ones go.
    .replace(/((?:xlink:)?href\s*=\s*["'])(?!#|data:image\/)[^"']*/gi, "$1#")
    .replace(/url\(\s*["']?(?!#|data:)[^)]*\)/gi, "none")
    .replace(/@import[^;]*;/gi, "");
}

export const builtInPacks: MascotPack[] = Object.entries(metas).map(([path, meta]) => ({
  ...meta,
  svg: sanitizeSvg(svgs[path.replace("mascot.json", "mascot.svg")] ?? ""),
}));

export const defaultMascot: Record<AgentId, string> = { claude: "inkling", codex: "prompt", grok: "void" };

// The user's packs and their choice per agent; App keeps these in step with Settings.
let userPacks: MascotPack[] = [];
let chosenMascot: Partial<Record<AgentId, string>> = {};
export function setUserPacks(raw: MascotPack[]) { userPacks = raw.map((p) => ({ ...p, svg: sanitizeSvg(p.svg), agent: undefined, user: true })); }
export function setChosenMascots(choice: Partial<Record<AgentId, string>>) { chosenMascot = choice; }
export const allPacks = () => [...builtInPacks, ...userPacks];

export function packFor(agent: AgentId, chosen?: string): MascotPack | undefined {
  const id = chosen ?? chosenMascot[agent] ?? defaultMascot[agent];
  const all = allPacks();
  return all.find((p) => p.id === id) ?? builtInPacks.find((p) => p.id === defaultMascot[agent]) ?? builtInPacks.find((p) => p.agent === agent);
}
