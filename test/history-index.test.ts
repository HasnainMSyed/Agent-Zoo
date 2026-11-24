import { describe, expect, it } from "vitest";
import { parseClaudeSession } from "../src/main/history-index";

const line = (o: object) => JSON.stringify(o);

describe("Claude session index", () => {
  it("prefers a custom title, then Claude's AI title, then the first message", () => {
    const head = [line({ type: "user", cwd: "/p", sessionId: "s1", message: { content: "fix the build please" } })].join("\n");
    expect(parseClaudeSession(head, "", "f")).toMatchObject({ id: "f", cwd: "/p", title: "fix the build please" });
    const tail = "cut-off half line\n" + line({ type: "ai-title", aiTitle: "Fix the build" });
    expect(parseClaudeSession(head, tail, "f")?.title).toBe("Fix the build");
    expect(parseClaudeSession(head, tail + "\n" + line({ type: "custom-title", customTitle: "Build fixes" }), "f")?.title).toBe("Build fixes");
    // Titles that are just a slash command aren't useful.
    expect(parseClaudeSession(head, tail + "\n" + line({ type: "custom-title", customTitle: "/model model" }), "f")?.title).toBe("Fix the build");
  });

  it("skips files without a folder or a real message", () => {
    expect(parseClaudeSession(line({ type: "user", cwd: "/p", isMeta: true, message: { content: "x" } }), "", "f")).toBeNull();
    expect(parseClaudeSession(line({ type: "user", message: { content: "hi" } }), "", "f")).toBeNull();
  });
});
