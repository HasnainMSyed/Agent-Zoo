// Voice input, one entry per agent. Each agent's voice is its own provider's: Agent Zoo never
// records audio for one agent and sends it to another company's service.
//
// Two kinds:
//  - "terminal": the agent's own voice mode lives in its terminal interface. The mic button opens
//    the session's Terminal view (the same conversation), where you talk to it; Chat brings you back.
//  - "dictate": words go straight into the input box. start() begins listening and reports text as
//    it's recognised (final: false for a running guess, true for finished words); the function it
//    returns stops listening. The Composer handles the button, the listening state and the text.
//
// To add an agent's voice, add an entry to VOICE below. Nothing else needs to change.

import type { AgentId } from "@shared/events";

export interface DictateHandlers { onText: (text: string, final: boolean) => void; onError: (message: string) => void }

export type VoiceProvider =
  | { kind: "terminal"; title: string; hint: string; /** Typed into the terminal when it opens, e.g. to switch voice mode on. */ typeOnOpen?: () => Promise<string | undefined> }
  | { kind: "dictate"; title: string; start: (sessionId: string, h: DictateHandlers) => Promise<() => void> };

export const VOICE: Partial<Record<AgentId, VoiceProvider>> = {
  // Claude Code's voice is its /voice mode (hold Space to talk), with Claude's own speech service and
  // sign-in. Its chat-side equivalent (the stream-json "dictate" request) is reserved for Anthropic's
  // VS Code extension, so Claude's voice opens in the Terminal view.
  claude: {
    kind: "terminal",
    title: "Talk to Claude (opens Claude's voice mode in the Terminal view)",
    hint: "Hold Space to talk to Claude, and let go to finish. Chat brings you back to this view.",
    // Voice mode is a setting in Claude Code; "/voice" switches it on when it's off.
    typeOnOpen: async () => ((await window.agents.claudeVoiceOn()) ? undefined : "/voice\r"),
  },
  // codex: …, grok: … — added by their own voice work.
};
