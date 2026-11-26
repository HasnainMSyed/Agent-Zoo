// "How's Agent Zoo treating you?": a small card that now and then appears at the top of Settings.
// A rating (bad, fine, good) and an optional note. Both are kept on this computer; "Send on GitHub"
// opens a filled-in issue in the browser, which you then post yourself. Nothing is sent otherwise.

import { useState } from "react";
import type { MascotPack } from "../mascots";
import type { MascotState } from "../state";
import { Mascot } from "./Mascot";

export type Rating = "bad" | "fine" | "good";
interface Entry { at: number; rating: Rating; note: string; version: string }
interface Store { firstSeen: number; lastShown: number; lastAnswered: number; entries: Entry[] }

const KEY = "zoo.feedback";
const DAY = 86_400_000;
const ISSUES = "https://github.com/HasnainMSyed/Agent-Zoo/issues/new";

function load(): Store {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Store>;
    return { firstSeen: raw.firstSeen ?? Date.now(), lastShown: raw.lastShown ?? 0, lastAnswered: raw.lastAnswered ?? 0, entries: raw.entries ?? [] };
  } catch { return { firstSeen: Date.now(), lastShown: 0, lastAnswered: 0, entries: [] }; }
}
function save(s: Store) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ } }

let askedThisRun = false;

/**
 * Whether to show the card on this visit to Settings: at most once per run of the app, not in the
 * first two days, not within a week of the last time, not within a month of an answer, and even
 * then only on about one visit in four.
 */
export function shouldAskFeedback(now = Date.now(), roll = Math.random()): boolean {
  if (askedThisRun) return false;
  const fresh = !localStorage.getItem(KEY);
  const s = load();
  if (fresh) save(s); // remember the first visit
  const due = now - s.firstSeen > 2 * DAY && now - s.lastShown > 7 * DAY && now - s.lastAnswered > 30 * DAY && roll < 0.25;
  if (due) { askedThisRun = true; save({ ...s, lastShown: now }); }
  return due;
}

export const feedbackCount = () => load().entries.length;

const FACES: { id: Rating; label: string; mouth: string; mascot: MascotState }[] = [
  { id: "bad", label: "Bad", mouth: "M21 45c4-6 18-6 22 0", mascot: "error" },
  { id: "fine", label: "Fine", mouth: "M22 41h20", mascot: "idle" },
  { id: "good", label: "Good", mouth: "M20 38c5 8 19 8 24 0", mascot: "done" },
];

const ASK: Record<Rating, [string, string]> = {
  bad: ["Sorry about that. What went wrong?", "A bug, something confusing, something missing…"],
  fine: ["What would make it good?", "One thing you'd change…"],
  good: ["Glad to hear it! What do you like?", "Or anything you'd still change…"],
};

export function FeedbackCard({ pack, version, onClose }: { pack?: MascotPack; version: string; onClose: () => void }) {
  const [rating, setRating] = useState<Rating | null>(null);
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);

  const record = (post: boolean) => {
    if (!rating) return;
    const s = load();
    const text = note.trim();
    save({ ...s, lastAnswered: Date.now(), entries: [...s.entries, { at: Date.now(), rating, note: text, version }].slice(-50) });
    if (post) {
      const title = `Feedback: ${rating}${text ? ` · ${text.split("\n")[0]!.slice(0, 60)}` : ""}`;
      const body = `**Rating:** ${rating}\n**Version:** ${version}\n\n${text || "(no note)"}`;
      window.open(`${ISSUES}?labels=feedback&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`, "_blank");
    }
    setSent(true);
    setTimeout(onClose, 1800);
  };

  const face = FACES.find((f) => f.id === rating);
  return (
    <section className={`set-card feedback ${rating ? `rated-${rating}` : ""}`} aria-label="Feedback">
      <button className="icon-btn feedback-close" onClick={() => { if (rating && !sent) record(false); else onClose(); }} aria-label="Not now" title="Not now">×</button>
      <div className="feedback-head">
        <Mascot pack={pack} state={sent ? "done" : face?.mascot ?? "waiting"} size={44} />
        <div>
          <h2>{sent ? "Thank you!" : rating ? ASK[rating][0] : "How's Agent Zoo treating you?"}</h2>
          <span className="muted small">{sent ? "Every note gets read." : rating ? "Optional. A sentence is plenty." : "One click. It helps decide what gets built next."}</span>
        </div>
      </div>
      {!sent && (
        <div className="feedback-faces" role="radiogroup" aria-label="Rating">
          {FACES.map((f) => (
            <button key={f.id} className={`face face-${f.id}`} role="radio" aria-checked={rating === f.id} onClick={() => setRating(f.id)}>
              <svg viewBox="0 0 64 64" aria-hidden="true">
                <circle className="face-bg" cx="32" cy="32" r="27" />
                <circle className="face-eye" cx="23" cy="27" r="3.2" /><circle className="face-eye" cx="41" cy="27" r="3.2" />
                <path className="face-mouth" d={f.mouth} />
              </svg>
              <span>{f.label}</span>
            </button>
          ))}
        </div>
      )}
      {rating && !sent && (
        <div className="feedback-note">
          <textarea className="text-input" rows={3} value={note} autoFocus placeholder={ASK[rating][1]} onChange={(e) => setNote(e.target.value)} />
          <div className="feedback-actions">
            <span className="muted tiny">Kept on this computer. "Send on GitHub" opens a filled-in issue for you to post.</span>
            <button className="btn-small" onClick={() => record(false)}>{note.trim() ? "Just save it" : "Done"}</button>
            <button className="btn-small primary" onClick={() => record(true)}>Send on GitHub</button>
          </div>
        </div>
      )}
    </section>
  );
}
