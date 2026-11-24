// User mascot packs: folders in <app data>/mascots, each with mascot.json and mascot.svg (the same
// format as the built-in packs). Packs are plain data: the SVG is cleaned again in the page before use.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";

export interface RawPack { id: string; name: string; agent?: string; description: string; svg: string; user: true }

const MAX_SVG = 512 * 1024;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "mascot";

export class MascotStore {
  constructor(readonly dir: string) { mkdirSync(dir, { recursive: true }); }

  list(): RawPack[] {
    const out: RawPack[] = [];
    for (const name of readdirSync(this.dir)) {
      const folder = join(this.dir, name);
      try {
        if (!statSync(folder).isDirectory()) continue;
        const svgPath = join(folder, "mascot.svg");
        if (!existsSync(svgPath) || statSync(svgPath).size > MAX_SVG) continue;
        let meta: Record<string, unknown> = {};
        try { meta = JSON.parse(readFileSync(join(folder, "mascot.json"), "utf8")); } catch { /* name from the folder */ }
        out.push({
          id: `user:${name}`, name: String(meta.name ?? name), agent: typeof meta.agent === "string" ? meta.agent : undefined,
          description: String(meta.description ?? ""), svg: readFileSync(svgPath, "utf8"), user: true,
        });
      } catch { /* unreadable pack */ }
    }
    return out;
  }

  /** Copies a pack folder, or wraps a single .svg file into a new pack. Returns the new pack's id. */
  import(source: string): string {
    const isSvg = extname(source).toLowerCase() === ".svg";
    if (isSvg) {
      if (statSync(source).size > MAX_SVG) throw new Error("That SVG is larger than 512 KB.");
      const name = basename(source, extname(source));
      const folder = this.freeFolder(slug(name));
      mkdirSync(folder);
      writeFileSync(join(folder, "mascot.svg"), readFileSync(source));
      writeFileSync(join(folder, "mascot.json"), JSON.stringify({ name, description: "Imported SVG", version: 1 }, null, 2));
      return `user:${basename(folder)}`;
    }
    if (!existsSync(join(source, "mascot.svg"))) throw new Error("A mascot pack folder needs a mascot.svg file.");
    const folder = this.freeFolder(slug(basename(source)));
    mkdirSync(folder);
    for (const f of ["mascot.svg", "mascot.json"]) if (existsSync(join(source, f))) cpSync(join(source, f), join(folder, f));
    return `user:${basename(folder)}`;
  }

  /** A new empty folder for "Make a mascot". */
  newFolder(name: string): string {
    const folder = this.freeFolder(slug(name));
    mkdirSync(folder);
    return folder;
  }

  remove(id: string) {
    rmSync(this.folderOf(id), { recursive: true, force: true });
  }

  folderOf(id: string): string {
    const name = id.replace(/^user:/, "");
    const folder = resolve(this.dir, name);
    if (!name || !folder.startsWith(resolve(this.dir) + sep)) throw new Error("Unknown mascot pack.");
    return folder;
  }

  private freeFolder(base: string): string {
    let name = base, n = 2;
    while (existsSync(join(this.dir, name))) name = `${base}-${n++}`;
    return join(this.dir, name);
  }
}
