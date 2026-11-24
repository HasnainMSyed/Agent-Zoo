import { useEffect, useState } from "react";
import type { MascotPack } from "../mascots";
import type { MascotState } from "../state";
import "../mascots/mascot.css";

const LABELS: Record<MascotState, string> = {
  idle: "Ready", thinking: "Thinking", working: "Working", waiting: "Needs your approval", done: "Done", error: "Something went wrong",
};

/** Shows a pack's SVG and animates it from the session state. "done" settles back to idle after a moment. */
export function Mascot({ pack, state, size = 64 }: { pack?: MascotPack; state: MascotState; size?: number }) {
  const [shown, setShown] = useState<MascotState>(state);
  useEffect(() => {
    setShown(state);
    if (state !== "done") return;
    const t = setTimeout(() => setShown("idle"), 3500);
    return () => clearTimeout(t);
  }, [state]);
  if (!pack) return null;
  return (
    <div className="mascot" data-state={shown} style={{ width: size, height: size }} title={`${pack.name}: ${LABELS[shown]}`}
      role="img" aria-label={`${pack.name}, ${LABELS[shown]}`} dangerouslySetInnerHTML={{ __html: pack.svg }} />
  );
}

export const mascotLabel = (s: MascotState) => LABELS[s];
