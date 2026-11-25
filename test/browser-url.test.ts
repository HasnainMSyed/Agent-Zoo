import { describe, expect, it } from "vitest";
import { toUrl } from "../src/renderer/src/browser-url";

describe("toUrl", () => {
  it("opens ports and local addresses over http", () => {
    expect(toUrl("5173")).toBe("http://localhost:5173");
    expect(toUrl("localhost:3000/app")).toBe("http://localhost:3000/app");
  });
  it("opens web addresses over https", () => {
    expect(toUrl("example.com")).toBe("https://example.com");
    expect(toUrl("http://example.com/x")).toBe("http://example.com/x");
  });
  it("searches for anything else", () => {
    expect(toUrl("react use effect")).toBe("https://www.google.com/search?q=react%20use%20effect");
    expect(toUrl("vite")).toBe("https://www.google.com/search?q=vite");
  });
  it("ignores an empty bar", () => { expect(toUrl("  ")).toBeNull(); });
});
