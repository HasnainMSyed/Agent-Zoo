import { useRef, useState, type ReactNode } from "react";

export function Composer({ running, disabled, onSend, onStop, mascot, status }: {
  running: boolean; disabled?: boolean; onSend: (text: string) => void; onStop: () => void; mascot: ReactNode; status: string;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const send = () => {
    const t = text.trim();
    if (!t || running || disabled) return;
    onSend(t);
    setText("");
  };
  return (
    <div className="composer">
      <div className="composer-mascot">{mascot}<span className="composer-status">{status}</span></div>
      <div className="composer-box">
        <textarea id="prompt" ref={ref} rows={1} value={text} disabled={disabled} placeholder={running ? "Working… press Esc to stop" : "Ask for a change, a fix, or an explanation"}
          onChange={(e) => { setText(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 240) + "px"; }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            if (e.key === "Escape" && running) onStop();
          }} />
        {running
          ? <button className="send stop" onClick={onStop} aria-label="Stop">Stop</button>
          : <button className="send" onClick={send} disabled={!text.trim() || disabled} aria-label="Send">Send</button>}
      </div>
      <div className="composer-hint">Enter to send · Shift+Enter for a new line{running ? " · Esc to stop" : ""}</div>
    </div>
  );
}
