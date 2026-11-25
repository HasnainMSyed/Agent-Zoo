// Voice input, one entry per agent. Each agent's voice is its own provider's: Agent Zoo never
// records audio for one agent and sends it to another company's service.
//
import type { AgentId } from "@shared/events";

interface DictationHandlers {
  onRecording: (stop: () => void) => void;
  onTranscribing: () => void;
}

export interface AgentVoice {
  terminal: { title: string; hint: string; typeOnOpen?: () => Promise<string | undefined> };
  dictate?: (signal: AbortSignal, handlers: DictationHandlers) => Promise<string>;
}

async function dictateCodex(signal: AbortSignal, handlers: DictationHandlers): Promise<string> {
  await window.agents.codexDictationReady();
  signal.throwIfAborted();
  if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder?.isTypeSupported("audio/webm;codecs=opus")) {
    throw new Error("Microphone recording is unavailable in this app window.");
  }

  let stream: MediaStream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { throw new Error("Couldn't access the microphone. Check your microphone and system permissions."); }

  let recording: Blob;
  try {
    signal.throwIfAborted();
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    const chunks: Blob[] = [];
    const stop = () => { if (recorder.state !== "inactive") recorder.stop(); };

    recorder.start();
    const timer = setTimeout(stop, 60_000);
    signal.addEventListener("abort", stop, { once: true });
    try {
      recording = await new Promise<Blob>((resolve, reject) => {
        recorder.ondataavailable = ({ data }) => { if (data.size) chunks.push(data); };
        recorder.onstop = () => resolve(new Blob(chunks, { type: "audio/webm" }));
        recorder.onerror = () => reject(new Error("The microphone stopped recording. Try again."));
        handlers.onRecording(stop);
      });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      stop();
    }
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }

  signal.throwIfAborted();
  handlers.onTranscribing();
  const audio = await recording.arrayBuffer();
  signal.throwIfAborted();
  return window.agents.transcribeCodexAudio(audio);
}

export const VOICE: Partial<Record<AgentId, AgentVoice>> = {
  // Claude Code's voice is its /voice mode (hold Space to talk), with Claude's own speech service and
  // sign-in. Its chat-side equivalent (the stream-json "dictate" request) is reserved for Anthropic's
  // VS Code extension, so Claude's voice opens in the Terminal view.
  claude: {
    terminal: {
      title: "Talk to Claude (opens Claude's voice mode in the Terminal view)",
      hint: "Hold Space to talk to Claude, and let go to finish. Chat brings you back to this view.",
      // Voice mode is a setting in Claude Code; "/voice" switches it on when it's off.
      typeOnOpen: async () => ((await window.agents.claudeVoiceOn()) ? undefined : "/voice\r"),
    },
  },
  codex: {
    terminal: {
      title: "Open a live voice conversation in the Terminal tab",
      hint: "In a supported Codex session, enter /voice to start talking and /voice stop to finish. Select Chat to return.",
    },
    dictate: dictateCodex,
  },
};
