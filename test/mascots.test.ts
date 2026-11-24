import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MascotStore } from "../src/main/mascots";
import { sanitizeSvg } from "../src/renderer/src/mascots";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><g class="body"><circle cx="60" cy="60" r="30"/></g></svg>';

describe("user mascot packs", () => {
  it("imports an SVG file or a pack folder, and lists them", () => {
    const root = mkdtempSync(join(tmpdir(), "zoo-mascots-"));
    const store = new MascotStore(join(root, "packs"));
    writeFileSync(join(root, "Sleepy Cat.svg"), SVG);
    expect(store.import(join(root, "Sleepy Cat.svg"))).toBe("user:sleepy-cat");
    mkdirSync(join(root, "Robo"));
    writeFileSync(join(root, "Robo", "mascot.svg"), SVG);
    writeFileSync(join(root, "Robo", "mascot.json"), JSON.stringify({ name: "Robo", description: "A robot" }));
    expect(store.import(join(root, "Robo"))).toBe("user:robo");
    expect(store.list().map((p) => [p.id, p.name]).sort()).toEqual([["user:robo", "Robo"], ["user:sleepy-cat", "Sleepy Cat"]]);
  });

  it("refuses ids that point outside the packs folder", () => {
    const store = new MascotStore(mkdtempSync(join(tmpdir(), "zoo-mascots-")));
    expect(() => store.folderOf("user:../../etc")).toThrow();
    expect(() => store.folderOf("user:")).toThrow();
  });

  it("strips scripts, handlers and anything loaded from outside", () => {
    const dirty = '<svg><script>alert(1)</script><image href="https://x.test/a.png" onload="x()"/><use xlink:href="#ok"/><rect style="fill:url(http://x.test/f)"/><image href="data:image/png;base64,AA"/></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(/script|onload|x\.test/);
    expect(clean).toContain('xlink:href="#ok"');
    expect(clean).toContain('href="data:image/png;base64,AA"');
  });
});
