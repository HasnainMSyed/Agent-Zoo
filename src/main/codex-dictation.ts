const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export function codexDictationKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("To dictate, launch Agent Zoo with OPENAI_API_KEY set. Talk to Codex uses your Codex sign-in.");
  return key;
}

export async function transcribeCodexAudio(audio: unknown): Promise<string> {
  if (!(audio instanceof ArrayBuffer) || !audio.byteLength || audio.byteLength > MAX_AUDIO_BYTES) {
    throw new Error("The recording is empty or too large. Try a shorter dictation.");
  }
  const data = new FormData();
  data.set("model", "gpt-transcribe");
  data.set("file", new Blob([audio], { type: "audio/webm" }), "dictation.webm");

  const key = codexDictationKey();
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", headers: { Authorization: `Bearer ${key}` }, body: data, signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") throw new Error("Dictation timed out. Try again.");
    throw new Error("Couldn't reach OpenAI for dictation. Check your connection and try again.");
  }
  if (response.status === 401 || response.status === 403) throw new Error("OpenAI rejected the API key for dictation. Check OPENAI_API_KEY and its permissions.");
  if (response.status === 429) throw new Error("OpenAI rate-limited dictation. Check your API usage or try again shortly.");
  if (!response.ok) throw new Error(`OpenAI couldn't transcribe the recording (HTTP ${response.status}).`);
  const result: { text?: unknown } = await response.json();
  if (typeof result.text !== "string" || !result.text.trim()) throw new Error("No speech was transcribed. Try again.");
  return result.text.trim();
}
