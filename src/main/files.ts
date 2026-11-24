// The Files pane: browse, view and edit files inside a session's folder. Every path is relative to
// that folder and is refused if it points outside it (including through a symlink).

import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";

export interface FileEntry { name: string; dir: boolean }
export type FileContent =
  | { kind: "text"; text: string; mtime: number; size: number }
  | { kind: "image"; dataUrl: string; mtime: number; size: number }
  | { kind: "binary" | "too-big"; mtime: number; size: number };

const TEXT_MAX = 2 * 1024 * 1024;
const IMAGE_MAX = 8 * 1024 * 1024;
const IMAGES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".bmp": "image/bmp" };
/** Folders that are big, generated, or private to a tool: listed last (the page dims them). */
const HEAVY = new Set([".git", "node_modules", "dist", "out", "build", ".next", "target", "__pycache__", ".venv", "venv"]);

/** Resolves a path inside root; throws if it would leave root. */
export async function inside(root: string, rel: string): Promise<string> {
  if (typeof rel !== "string" || rel.includes("\0")) throw new Error("Bad path.");
  const realRoot = await realpath(root);
  const full = resolve(realRoot, rel || ".");
  let real: string;
  try { real = await realpath(full); }
  catch { real = join(await realpath(dirname(full)), basename(full)); } // not there yet: check the folder it would go in
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error("That file is outside this session's folder.");
  return real;
}

export async function listDir(root: string, rel: string): Promise<FileEntry[]> {
  const dir = await inside(root, rel);
  const out: FileEntry[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) { try { isDir = (await stat(join(dir, d.name))).isDirectory(); } catch { continue; } }
    out.push({ name: d.name, dir: isDir });
  }
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || Number(HEAVY.has(a.name)) - Number(HEAVY.has(b.name))
    || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

export async function fileStat(root: string, rel: string): Promise<{ mtime: number; size: number } | null> {
  try { const st = await stat(await inside(root, rel)); return { mtime: st.mtimeMs, size: st.size }; } catch { return null; }
}

export async function readFileFor(root: string, rel: string): Promise<FileContent> {
  const path = await inside(root, rel);
  const st = await stat(path);
  if (st.isDirectory()) throw new Error("That's a folder.");
  const base = { mtime: st.mtimeMs, size: st.size };
  const mime = IMAGES[extname(path).toLowerCase()];
  if (mime) {
    if (st.size > IMAGE_MAX) return { kind: "too-big", ...base };
    return { kind: "image", dataUrl: `data:${mime};base64,${(await readFile(path)).toString("base64")}`, ...base };
  }
  if (st.size > TEXT_MAX) return { kind: "too-big", ...base };
  const buf = await readFile(path);
  if (buf.subarray(0, 8000).includes(0)) return { kind: "binary", ...base };
  return { kind: "text", text: buf.toString("utf8"), ...base };
}

/** Saves text; refuses when the file changed on disk since it was opened (expectMtime), unless that's left out. */
export async function writeFileFor(root: string, rel: string, text: string, expectMtime?: number): Promise<{ mtime: number }> {
  if (typeof text !== "string" || text.length > TEXT_MAX * 2) throw new Error("That's too much text to save.");
  const path = await inside(root, rel);
  if (expectMtime !== undefined) {
    const now = await stat(path).then((s) => s.mtimeMs, () => undefined);
    if (now !== undefined && Math.abs(now - expectMtime) > 1) throw new Error("CHANGED_ON_DISK");
  }
  await writeFile(path, text, "utf8");
  return { mtime: (await stat(path)).mtimeMs };
}
