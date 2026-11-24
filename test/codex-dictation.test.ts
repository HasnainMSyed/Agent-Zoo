import { afterEach, expect, it, vi } from "vitest";
import { transcribeCodexAudio } from "../src/main/codex-dictation";
import { VOICE } from "../src/renderer/src/voice";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("uploads a WebM recording using the API key and returns the transcript", async () => {
  const request = vi.fn(async (_url: string, _options: RequestInit) => Response.json({ text: "  Check the tests. " }));
  vi.stubGlobal("fetch", request);
  vi.stubEnv("OPENAI_API_KEY", "test-key");

  await expect(transcribeCodexAudio(new Uint8Array([1, 2]).buffer)).resolves.toBe("Check the tests.");
  const [url, options] = request.mock.calls[0]!;
  expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
  expect(options.headers).toEqual({ Authorization: "Bearer test-key" });
  const body = options.body as FormData;
  expect(body.get("model")).toBe("gpt-transcribe");
  expect(body.get("file")).toMatchObject({ name: "dictation.webm", type: "audio/webm", size: 2 });
});

it("does not upload an empty or oversized recording", async () => {
  const request = vi.fn();
  vi.stubGlobal("fetch", request);
  await expect(transcribeCodexAudio(new ArrayBuffer(0))).rejects.toThrow("empty or too large");
  await expect(transcribeCodexAudio(new ArrayBuffer(8 * 1024 * 1024 + 1))).rejects.toThrow("empty or too large");
  expect(request).not.toHaveBeenCalled();
});

function mockMicrophone() {
  const stopTrack = vi.fn();
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", class {
    static isTypeSupported = () => true;
    state = "inactive";
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(["audio"]) });
        this.onstop?.();
      });
    }
  });
  const transcribe = vi.fn(async () => "Check the tests.");
  const ready = vi.fn(async () => {});
  vi.stubGlobal("window", { agents: { codexDictationReady: ready, transcribeCodexAudio: transcribe } });
  return { stopTrack, getUserMedia, transcribe, ready };
}

it("releases the microphone before transcribing when the user stops", async () => {
  const { stopTrack, transcribe } = mockMicrophone();
  await expect(VOICE.codex!.dictate!(new AbortController().signal, {
    onRecording: (stop) => stop(),
    onTranscribing: () => expect(stopTrack).toHaveBeenCalledOnce(),
  })).resolves.toBe("Check the tests.");
  expect(transcribe).toHaveBeenCalledOnce();
});

it("releases the microphone and discards the recording on cancellation", async () => {
  const { stopTrack, transcribe } = mockMicrophone();
  const controller = new AbortController();
  await expect(VOICE.codex!.dictate!(controller.signal, {
    onRecording: () => controller.abort(),
    onTranscribing: () => { throw new Error("Cancelled audio must be discarded"); },
  })).rejects.toMatchObject({ name: "AbortError" });
  expect(stopTrack).toHaveBeenCalledOnce();
  expect(transcribe).not.toHaveBeenCalled();
});

it("requires transcription configuration before requesting microphone access", async () => {
  const { ready, getUserMedia } = mockMicrophone();
  ready.mockRejectedValueOnce(new Error("Set OPENAI_API_KEY"));
  await expect(VOICE.codex!.dictate!(new AbortController().signal, {
    onRecording: vi.fn(), onTranscribing: vi.fn(),
  })).rejects.toThrow("Set OPENAI_API_KEY");
  expect(getUserMedia).not.toHaveBeenCalled();
});
