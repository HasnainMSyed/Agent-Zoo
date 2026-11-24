// Desktop alerts and sounds: when an agent finishes, stops with an error, or needs your answer.
// Sounds are made on the spot with Web Audio (no sound files).

export type SoundName = "off" | "chime" | "pop" | "bell";
export type AlertKind = "done" | "error" | "input";

let ctx: AudioContext | null = null;

function tone(at: number, freq: number, dur: number, type: OscillatorType, peak: number, slideTo?: number) {
  const a = ctx!;
  const osc = a.createOscillator(), gain = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, at + dur);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain).connect(a.destination);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

/** Plays a sound; "input" (an agent waiting on you) rises, "error" falls, "done" is the plain one. */
export function playSound(name: SoundName, kind: AlertKind = "done") {
  if (name === "off") return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const t = ctx.currentTime + 0.02;
    const up = kind === "input", down = kind === "error";
    if (name === "chime") {
      const [a, b] = down ? [880, 587] : up ? [660, 990] : [880, 1320];
      tone(t, a, 0.35, "sine", 0.18); tone(t + 0.12, b, 0.5, "sine", 0.16);
      if (up) tone(t + 0.24, 1320, 0.45, "sine", 0.12);
    } else if (name === "pop") {
      tone(t, down ? 420 : 620, 0.09, "sine", 0.3, down ? 160 : 240);
      if (up) tone(t + 0.13, 760, 0.09, "sine", 0.26, 300);
    } else {
      const f = down ? 440 : up ? 784 : 659;
      tone(t, f, 1.2, "triangle", 0.16); tone(t, f * 2.01, 0.8, "sine", 0.05);
      if (up) tone(t + 0.18, f * 1.5, 1, "triangle", 0.12);
    }
  } catch { /* no audio device */ }
}

const TEXT: Record<AlertKind, (agent: string) => string> = {
  done: (a) => `${a} finished`,
  error: (a) => `${a} stopped with an error`,
  input: (a) => `${a} needs your answer`,
};

/** Shows a desktop alert; clicking it brings the app forward on that session. */
export function desktopAlert(kind: AlertKind, agent: string, body: string, onClick: () => void) {
  try {
    if (typeof Notification === "undefined" || Notification.permission === "denied") return;
    const n = new Notification(TEXT[kind](agent), { body, silent: true, tag: `${kind}:${body}` });
    n.onclick = () => { onClick(); n.close(); };
  } catch { /* alerts unavailable */ }
}
