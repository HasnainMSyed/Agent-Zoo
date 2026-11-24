// Mascot packs: a folder with mascot.json + mascot.svg (see PLAN.md "Mascot packs").
// Built-in packs are bundled; user packs arrive later from ~/.config/agent-zoo/mascots.

import type { AgentId } from "@shared/events";

export interface MascotPack { id: string; name: string; agent?: AgentId; description: string; svg: string }

const metas = import.meta.glob<{ id: string; name: string; agent?: AgentId; description: string }>("./packs/*/mascot.json", { eager: true, import: "default" });
const svgs = import.meta.glob<string>("./packs/*/mascot.svg", { eager: true, query: "?raw", import: "default" });

/** Strips anything executable from pack SVG before it is put into the page. */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href\s*=\s*["'])\s*javascript:[^"']*/gi, "$1#");
}

export const builtInPacks: MascotPack[] = Object.entries(metas).map(([path, meta]) => ({
  ...meta,
  svg: sanitizeSvg(svgs[path.replace("mascot.json", "mascot.svg")] ?? ""),
}));

export const defaultMascot: Record<AgentId, string> = { claude: "inkling", codex: "prompt", grok: "void" };

export function packFor(agent: AgentId, chosen?: string): MascotPack | undefined {
  const id = chosen ?? defaultMascot[agent];
  return builtInPacks.find((p) => p.id === id) ?? builtInPacks.find((p) => p.agent === agent);
}
