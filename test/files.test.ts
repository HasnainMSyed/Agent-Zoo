// The Files pane only reaches inside a session's folder, and never saves over a file that changed on disk.
import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDir, readFileFor, writeFileFor } from "../src/main/files";

let base = "", root = "";
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "zoo-files-"));
  root = join(base, "project");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "blob.bin"), Buffer.from([1, 0, 2, 0]));
  writeFileSync(join(base, "secret.txt"), "outside");
  symlinkSync(join(base, "secret.txt"), join(root, "link-out"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

test("lists folders first", async () => {
  expect((await listDir(root, "")).map((e) => e.name)).toEqual(["src", "blob.bin", "link-out"]);
});

test("refuses paths outside the folder, including through a symlink", async () => {
  await expect(readFileFor(root, "../secret.txt")).rejects.toThrow("outside");
  await expect(readFileFor(root, "link-out")).rejects.toThrow("outside");
  await expect(listDir(root, "/etc")).rejects.toThrow("outside");
  await expect(writeFileFor(root, "../new.txt", "x")).rejects.toThrow("outside");
});

test("reads text, spots binary files", async () => {
  expect(await readFileFor(root, "src/a.ts")).toMatchObject({ kind: "text", text: "export const a = 1;\n" });
  expect((await readFileFor(root, "blob.bin")).kind).toBe("binary");
});

test("won't save over a file that changed since it was opened", async () => {
  const opened = await readFileFor(root, "src/a.ts");
  utimesSync(join(root, "src", "a.ts"), new Date(), new Date(Date.now() + 5000)); // someone else wrote it
  await expect(writeFileFor(root, "src/a.ts", "mine", opened.mtime)).rejects.toThrow("CHANGED_ON_DISK");
  await writeFileFor(root, "src/a.ts", "mine"); // "Keep mine"
  expect(await readFileFor(root, "src/a.ts")).toMatchObject({ text: "mine" });
});
