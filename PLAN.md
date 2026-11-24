# agents-gui: plan

A local desktop and web GUI that runs Claude Code, Codex and Grok, and shows their sessions as rich, themed UI instead of raw terminal text. It takes after `dsh-claude-style` (a DeepSeek Harness theme plugin) and adds a GPT skin and a Grok skin.

## 1. What's on this machine (checked 2026-11-24)

| Agent | Version | Structured interface | Session history |
|---|---|---|---|
| Claude Code | 2.1.331 | `claude -p --input-format stream-json --output-format stream-json --verbose`: a two-way NDJSON stream. `--permission-prompts host` sends permission prompts to us. | `~/.claude/projects/<slug>/*.jsonl` |
| Codex CLI | 0.171.0 | `codex app-server`: JSON-RPC over stdio, the same backend the Codex IDE and desktop clients use. `generate-ts` gives typed bindings. Fallback: `codex exec --json`. | `~/.codex/sessions`, sqlite |
| Grok Build | 1.0.92 | **`grok agent stdio`**: a full multi-turn ACP agent (JSON-RPC 2.0) with `session/request_permission`. Verified in Phase 0. | `~/.grok` |

Runtimes available: Node 26, Bun 1.3, Python 3.12. **No Rust toolchain**, so Tauri would need `rustup` first. The terminal is Ghostty on GNOME and Wayland.

## 2. The key decision: render structure, don't paint the TUI

There are two ways to build this:

- **A. PTY wrapper:** embed each TUI in xterm.js and add themed chrome around it. It's cheap and keeps every feature, but only the frame and the 16 ANSI colours can change. That isn't 10x.
- **B. Structured renderer (recommended):** drive each agent through its machine protocol (see the table), map the events onto one shared model, and render real components. This is the approach that DSH uses.

**Plan: build B as the product, with A as a "Raw terminal" tab.** The tab covers anything the protocols don't expose yet, such as slash-command UIs and login flows.

## 3. Architecture

```
┌──────────────── UI (Electron renderer: React + Vite) ─────────────────────────────┐
│ Sidebar: sessions × agent, status dots │ Transcript │ Right rail: plan/todos, diff, │
│                                        │  renderer  │ context & cost, subagents      │
└───────────────▲────────────────────────────────────────────────────────────────────┘
                │ Electron IPC: normalized AgentEvent stream + commands (send, approve, interrupt)
┌───────────────┴──────────── Electron main (Node) ──────────────────────────────────┐
│ SessionManager ── adapters/claude.ts   (stream-json, bidirectional)                 │
│                ├─ adapters/codex.ts    (app-server JSON-RPC, generated TS types)    │
│                ├─ adapters/grok.ts     (ACP session updates)                        │
│                └─ adapters/pty.ts      (node-pty fallback → xterm.js)               │
│ HistoryImporter (reads the three on-disk session stores) · Notifier · Settings      │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### Normalized event model (`packages/contracts`)

```ts
type AgentId = "claude" | "codex" | "grok";
type AgentEvent =
  | { kind: "session.started"; agent: AgentId; sessionId: string; model: string; cwd: string }
  | { kind: "message.delta" | "message.done"; role: "assistant" | "user"; id: string; text: string }
  | { kind: "thinking.delta" | "thinking.done"; id: string; text: string }
  | { kind: "tool.started"; id: string; tool: ToolKind; input: unknown; parentId?: string }
  | { kind: "tool.output"; id: string; chunk: string }
  | { kind: "tool.finished"; id: string; ok: boolean; result: unknown }
  | { kind: "permission.request"; id: string; tool: ToolKind; summary: string }
  | { kind: "plan.updated"; items: { text: string; status: "pending" | "active" | "done" }[] }
  | { kind: "usage"; inputTokens: number; outputTokens: number; costUsd?: number; contextPct?: number }
  | { kind: "turn.done" | "error"; detail?: string };
type ToolKind = "shell" | "edit" | "read" | "search" | "web" | "subagent" | "mcp" | "other";
```

Each adapter maps its agent's native tool names onto `ToolKind`, so a single `EditCard` covers Claude `Edit`, Codex `apply_patch` and Grok's edit tool.

**Stack:** Bun with TypeScript, React, Vite and Tailwind, plus CSS-variable design tokens. Shiki does syntax highlighting, `diff2html` or a custom renderer handles diffs, react-markdown renders streamed markdown, and xterm.js with node-pty runs the fallback tab. **Desktop app (decided):** Electron. Its main process hosts the adapters, and the renderer is the React UI, connected over IPC (no localhost port). Electron is used because no Rust toolchain is installed, so Tauri isn't an option.

## 4. What makes it look much better (component list)

1. **Tool cards:** shell commands with a collapsible live output and exit-code badge, edits as side-by-side diffs with syntax highlighting, reads as file chips with a hover preview, searches as grouped results.
2. **Streaming markdown** with stable layout, so nothing jumps while text arrives. Code blocks get copy and open-in-editor buttons.
3. **Thinking blocks** fold into a single shimmer line that can be expanded.
4. **Inline approval cards** for permission prompts (Allow once, Always, Deny, Edit command) instead of y/n text.
5. **Plan and todo rail** that stays in sync with TodoWrite, Codex plans and ACP plan updates.
6. **Subagent tree:** nested, collapsible runs with their own status.
7. **Context and cost meter:** a ring for context %, plus tokens and $ per turn.
8. **Session sidebar across all three agents,** with status dots (running, awaiting input, unread, error), search, and import of past sessions from disk.
9. **Compare mode:** send one prompt to two or three agents side by side, then diff what they produced.
10. **Command palette (⌘K),** desktop notifications when an agent needs input, optional sounds.
11. **Mascots (core feature, packs):** one original animated SVG character per agent. It sits on the input box and reacts to the session's state: idle, thinking, running a tool, waiting for approval, running subagents, error, done, sleeping. It is driven by the same event stream.

### Mascot packs
- **Picks (2026-11-24):** Claude = **Inkling**, Codex = **Prompt** (Dot kept as an alternative, now with a sad face for errors), Grok = **Void**. Sketches are in `design/mascots.html`.
- A mascot is a **pack**: a folder holding `mascot.json` (id, name, agent it suits, palette, credits) and `mascot.svg`. The SVG uses the shared class hooks: `.body`, `.eyes` › `.e-open` / `.e-happy` / `.e-x` / `.e-sad`, `.m-ok` / `.m-sad`, plus optional extras (`.spin`, `.orbit`, `.glow`, `.fa`/`.fb` animation frames). The app's state CSS animates any pack that uses these hooks, so a pack never contains code.
- Packs load from the built-in set plus `~/.config/agent-zoo/mascots/*`. Settings › Mascots lets you choose one per agent, keep favourites, and switch from the input box by clicking the mascot.
- **Make a mascot:** describe one in Settings, and the app runs a Claude session that writes a new pack into the user folder and previews it in all six states. (Phase 4)
- Local packs are git-ignored and never bundled into a build.

### Two views per session (decided 2026-11-24)
Every session has a **Graphical** view and a **Terminal** view of the same conversation. The Terminal tab runs the real `claude --resume <id>`, `codex resume <id>` or `grok --resume <id>` in an embedded terminal (xterm.js and node-pty), so no feature of any agent is ever lost. Switching tabs closes one process and resumes the session in the other, because only one may drive a session at a time. Graphical controls for popular terminal-only commands (model and effort pickers first, then MCP and plugins) get added over time. This is the first item in Phase 4. ✅ Built 2026-11-24 (Chat / Terminal switch in the top bar).

### Slash commands (requirement, for each agent) — "/" menu built 2026-11-24
Built: typing `/` lists the agent's own commands (Claude: from its initialize reply; Grok: `available_commands_update`; Codex: `/compact`, `/new` mapped to methods), plus model and effort pickers, plus menu-style commands marked "Opens in Terminal", which switch to the Terminal view and type the command there. Model and effort: Codex applies them on the next turn; Claude and Grok restart the chat process on the same conversation with `--model`/`--effort`.
Claude panels (built 2026-11-24): `/mcp`, `/status` and `/context` open graphical panels filled from Claude's control protocol (`mcp_status`, `get_status`, `get_context_usage`); MCP servers can be turned on or off and retried there (`mcp_toggle`, `mcp_reconnect`), while sign-in hands over to the Terminal view. A permission-mode chip next to the model chip switches modes with `set_permission_mode`, and the mode is kept across restarts and the Terminal view. Plan limits load at session start through `get_usage`. Only a fixed list of requests may be sent (`CLAUDE_QUERIES`).

### Settings, sessions list, Grok usage (built 2026-11-24)
- **Settings** (profile row at the bottom of the sidebar): local profile (display name, initials), each agent's sign-in state, plan and version (`claude auth status --json`, `codex login status`, `~/.grok/auth.json` non-secret fields only), with Sign in / Sign out running the agent's own command in a small terminal; theme (system/light/dark), colours follow agent or fixed, per-agent dot colours, text size, reduce motion, show mascots; default agent and Claude permission mode for new sessions.
- **Sessions list:** every saved conversation from all three agents, grouped by folder (open ones first, saved ones with hollow dots, 5 per folder plus "Show all"), with search. Claude files are re-indexed on change (file watcher, per-file cache, AI titles). Claude conversations running elsewhere are detected exactly from Claude's own record (`~/.claude/sessions/<pid>.json`, pid alive and start time matching, the app's own processes skipped); opening one offers **Bring it here** (waits until that copy is idle, ends it, resumes here with everything it did) or **Open here too**. Codex Cloud tasks get their own group (diff, apply to a folder); Claude cloud sessions open by link or ID in the Terminal view (`claude --cloud`). Listing Claude cloud sessions would need a private API, so it isn't done.
- **Sidebar workspace (2026-11-24):** sessions and whole folders drag from the All-sessions drawer into the sidebar. A dropped conversation opens; a dropped folder is pinned (also the ⇤ button) and lists its saved conversations. Sidebar folder groups fold. The drawer's Select mode ticks several conversations (or a whole folder) to open together or drag at once.
- **Theme transitions:** the colour tokens are registered with `@property`, so a change blends from one palette to the next (0.6 s). Off with reduce motion.
- **Sessions survive restarts (2026-11-24):** every session opened here stays in the sidebar (asleep, hollow dot) until removed with ×; the one you were last in starts again at launch (Settings → Sessions). Removing only takes it off the sidebar and out of pinned folders' lists; it stays in All sessions.
- **Voice (2026-11-24):** one entry per agent in `src/renderer/src/voice.ts`; the Composer's mic button reads it. Each agent's voice uses that agent's own provider. Claude: its `/voice` mode in the Terminal view (hold Space); Claude's chat-side `dictate` request is reserved for Anthropic's VS Code extension and gated server-side, so it isn't used. Codex and Grok add their own entries ("dictate" kind fills the input box; "terminal" kind opens their voice mode).
- **Updates (2026-11-24):** installed copies check GitHub Releases (electron-updater) at launch and every 4 hours and download in the background; a prompt offers the new version. Update waits until no agent is mid-turn, restarts, and reopens every session that was open. Releases come from `.github/workflows/release.yml` when a `v*` tag is pushed. The .deb asks for the password to install; the AppImage doesn't.
- **One app at a time:** a second launch focuses the open window. Development runs use their own settings folder (`agent-zoo-dev`), apart from the installed app's.
- **Side tools (like Claude's desktop app), phase 1 = Terminal:** the topbar's `>_` opens a resizable pane of shells (tabs, `+`) in the session's folder; shells stay alive while hidden and close with their session. Next: Files (tree, viewer, editor) and Browser.
- **Grok usage:** read from Grok's own `/usage` screen in a hidden terminal at launch and every 15 minutes, from a private folder whose empty Grok sessions are deleted afterwards. Background Grok processes run one at a time.
Typing `/` in the input box must offer each agent's own commands, and running one must work as it does in that agent's terminal UI. Claude lists them in `system:init.slash_commands` and runs a command sent as user text. Grok sends ACP `available_commands_update`. Codex has no command list over the protocol, so the GUI maps its commands to app-server methods (for example `thread/compact/start`, `model/list`, `thread/fork`). The design gets worked out with the user while each adapter is built.

## 5. Themes (token JSON → CSS variables; light and dark each)

| Skin | Accent | Dark canvas | Character |
|---|---|---|---|
| **Claude** | `#d97757` | `#191919` (light `#ffffff`, sidebar `#1f1f1f`/`#fafafa`) | Warm, serif display headings, soft bubbles. Tokens taken from dsh-claude-style. |
| **Codex / GPT** | near-black `#0d0d0d` / white, with a `#10a37f` highlight | `#212121` | Neutral greys, clean grotesk UI (Inter), dense cards, crisp 1px borders. |
| **Grok** | white on true black, with a cool `#7c8cff`→`#c4b5fd` gradient for live states | `#000000` | High contrast, monospace UI (JetBrains Mono or Geist Mono), sharp corners, subtle glow on streaming text. |

**The skin follows the agent (decided).** Fonts get no special treatment and use system defaults. Shared tokens cover the radius ladder (4/8/16), the motion set (80–400 ms, spring easing, reduced-motion support) and z-layers.

**IP note:** the mascots are original designs, not Clawd or any official logo. Brand-*inspired* palettes are fine for personal use.

## 6. Phases

| Phase | Scope | Exit criterion |
|---|---|---|
| **0. Protocol spike** ✅ done 2026-11-24 (see `docs/PROTOCOLS.md`) | Record real NDJSON or JSON-RPC transcripts from each agent: a simple Q&A, a shell call, an edit, a permission prompt, a subagent, an interrupt. Save them as `fixtures/`. Confirm how Grok does multi-turn: a long-lived process or `--resume` per turn. | Fixtures for all 3 agents, and the gaps written down |
| **1. MVP: Claude** ✅ done 2026-11-24 | Electron main process, Claude adapter, event model, transcript with message, thinking, shell, edit and read cards, approval cards, Claude skin, **Claude mascot**, Electron shell, single session | Real coding sessions from the GUI work end to end |
| **2. Codex** ✅ done 2026-11-24 | app-server adapter (generated types), GPT skin, **Codex mascot**, multi-session sidebar | Same as Phase 1 for Codex |
| **3. Grok** ✅ done 2026-11-24 | ACP adapter, Grok skin, **Grok mascot** | Same as Phase 1 for Grok |
| **4. Polish** | History import, plan rail, subagent tree, cost meter, ⌘K, notifications, PTY fallback tab | Daily-driver ready |
| **5. Extras** | Compare mode, custom themes editor, packaging (AppImage/.deb) | Optional |

Adapters are tested by replaying the fixtures, so renderer tests never touch the network or spend tokens.

## 7. Risks

- **Protocol drift:** all three CLIs ship often, and Codex's app-server is marked experimental. Keep adapters thin, pin versions in fixtures, and fall back to the PTY tab when parsing fails.
- **Interactive-only features:** slash commands, `/login` and some pickers have no headless equivalent. The PTY tab covers them.
- ~~**Grok headless multi-turn**~~: resolved, since `grok agent stdio` is multi-turn ACP.
- **Codex default model:** the configured `gpt-5.3-codex` is rejected, so the GUI picks from `model/list`.
- **Auth:** reuse each CLI's own login and never handle credentials in the GUI.
