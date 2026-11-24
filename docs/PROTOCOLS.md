# Agent protocols: Phase 0 findings (verified 2026-11-24)

The recordings are in `fixtures/*-twoway.ndjson`. Each line starts with `<` (agent → GUI) or `>` (GUI → agent). The recorders are in `tools/record_*.py`. Every agent completed the same two-turn task in `sandbox/`: run a command, then edit `calc.py`. Every approval went through the GUI side.

> The fixtures include local config details (skill names, hook paths, home dir). Keep them out of anything public.

| | Claude Code 2.1.331 | Codex 0.171.0 | Grok 1.0.92 |
|---|---|---|---|
| Spawn | `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompts host --permission-prompt-tool stdio` | `codex app-server` | `grok agent stdio` |
| Wire format | NDJSON, Claude SDK control protocol | JSON-RPC (no `jsonrpc` field), NDJSON | JSON-RPC 2.0 over NDJSON (**ACP**, the Agent Client Protocol), plus `_x.ai/*` extensions |
| Handshake | `control_request {subtype:"initialize"}` → `control_response` (commands, models, agents) | `initialize {clientInfo, capabilities}` → `initialized` notification → `thread/start {cwd, model, approvalPolicy, sandbox}` | `initialize {protocolVersion:1, clientCapabilities}` → `session/new {cwd, mcpServers}` |
| Send a turn | write `{type:"user", message:{role, content}}` | `turn/start {threadId, input:[{type:"text", text, text_elements:[]}]}` | `session/prompt {sessionId, prompt:[{type:"text", text}]}` (the response arrives when the turn ends) |
| Multi-turn | ✅ same process, write the next user line after `result` | ✅ `turn/start` again on the same thread | ✅ `session/prompt` again |
| Turn end | `{type:"result"}` with `total_cost_usd` (cumulative) | `turn/completed {turn.status}` | response `{stopReason:"end_turn"}` and `_x.ai… turn_completed` |
| Text streaming | `stream_event` → `content_block_delta` | `item/agentMessage/delta` | `session/update: agent_message_chunk` |
| Thinking | `thinking` content blocks and deltas | `item/reasoning/*Delta` | `agent_thought_chunk` |
| Tools | `tool_use` blocks in `assistant`, `tool_result` blocks in `user` | `item/started` / `item/completed` (commandExecution, fileChange, …), `item/commandExecution/outputDelta` | `tool_call` / `tool_call_update` with `kind` (execute, edit, read…) and `content` (`diff` has `oldText`/`newText`) |
| **Approvals** | `control_request {subtype:"can_use_tool", tool_name, input}` → `control_response {behavior:"allow", updatedInput}` or `deny` | server requests `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` → `{decision:"accept"/"acceptForSession"/"decline"/"cancel"}` | `session/request_permission {toolCall, options[]}` → `{outcome:{outcome:"selected", optionId}}` (`kind: allow_once` etc.) |
| Usage and cost | `result.total_cost_usd`, per-message `usage` | `thread/tokenUsage/updated`, `account/rateLimits/updated` | `response_completed.usage`, `turn_completed.usage` (with `costUsdTicks`) |
| Plan and todos | TodoWrite tool input | `turn/plan/updated`, `turn/diff/updated` | ACP `plan` update (not exercised yet) |
| Hooks visible | `system: hook_started` / `hook_response` | `hook/started` / `hook/completed` | `_x.ai… hook_run_started` / `hook_execution` |
| Model list | `initialize` response | `model/list` (default `gpt-6.2-sol`) | `_x.ai/models/update`, `grok models` |
| Interrupt | `control_request {subtype:"interrupt"}` (not exercised yet) | `turn/interrupt` (not exercised yet) | ACP `session/cancel` (not exercised yet) |

## Gotchas found
- **Claude:** `--permission-prompts host` on its own auto-denies. **`--permission-prompt-tool stdio` is also required** for prompts to reach the GUI.
- **Codex:** a `model` set in `~/.codex/config.toml` can be one the signed-in account can't use (the turn then fails with `modelNotFound`). The GUI must pick a model from `model/list` and pass it in `thread/start`. It should also show turn errors from `error` / `turn/completed.status = "failed"`.
- **Grok:** `-p` is single-turn, but `grok agent stdio` is a full multi-turn ACP agent. That settles the Phase 0 risk.
- **All three:** the user's own hooks (from settings or plugins) run inside GUI-driven sessions too. The GUI should show hook events and must not assume hooks are absent.

## Still to exercise (in Phase 1 to 3 adapter work)
Interrupt or cancel, subagents (Claude Task, Codex multi-agent, Grok subagents), plan updates, resume or load of an existing session, and image input.

## Learned while building the adapters (Phases 1 to 3)
- **Grok cost** arrives in `turn_completed.usage.costUsdTicks` **for each turn**, in units of 1e-10 USD (checked against `grok usage <session>`). The adapter adds turns up so the UI shows a session total, as Claude's `total_cost_usd` does.
- **Grok context window** comes from `_x.ai/models/update` → `availableModels[current]._meta.totalContextTokens` (256k for grok-4.7). Context in use = the last `response_completed` input plus cache-read tokens.
- **Grok turn end** arrives twice (`_x.ai/session/prompt_complete` and the `session/prompt` response). The adapter closes the turn once.
- **Grok tool output** in `tool_call_update` (`in_progress`) is the full output so far, not a delta. The adapter emits only the new part.
- **Codex commands** come wrapped as `/bin/bash -lc "..."`. The readable form is `commandActions[0].command`.
- **Codex file changes** carry a unified diff for each file in `changes[].diff`, and the approval request only references the item, so the adapter keeps the diff from `item/started` for the approval card.
- **Claude** sends full tool inputs in `assistant` events and text and thinking as `stream_event` deltas. Block ids are `message id:index`.
