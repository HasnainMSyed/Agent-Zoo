import { useMemo, useRef, useState, type ReactNode } from "react";
import type { ModelOption, SlashCommand } from "@shared/commands";

const RUN_LABEL: Record<SlashCommand["run"], string | null> = { send: null, action: null, model: "Picker", effort: "Picker", terminal: "Opens in Terminal", panel: "Panel" };

/** Ranks commands for the "/" menu: names that start with the query first, then ones that contain it. */
function matchCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  const contains = commands.filter((c) => !c.name.toLowerCase().startsWith(q) && (c.name.toLowerCase().includes(q) || (q.length > 2 && c.description.toLowerCase().includes(q))));
  return [...starts, ...contains].slice(0, 50);
}

function ModelPicker({ models, model, effort, focus, onPick, onClose }: {
  models: ModelOption[]; model?: string; effort?: string; focus: "model" | "effort";
  onPick: (model?: string, effort?: string) => void; onClose: () => void;
}) {
  const current = models.find((m) => m.id === model) ?? models.find((m) => m.label === model);
  const efforts = current?.efforts ?? [...new Set(models.flatMap((m) => m.efforts ?? []))];
  return (
    <div className="picker" role="dialog" aria-label="Model and effort">
      <div className="picker-head"><strong>{focus === "effort" ? "Effort" : "Model"}</strong><button onClick={onClose} aria-label="Close">×</button></div>
      {focus === "model" && (
        <div className="picker-list" role="listbox" aria-label="Models">
          {models.length === 0 && <p className="muted small">The agent hasn't listed its models yet. Send a message first, or use the Terminal tab.</p>}
          {models.map((m) => (
            <button key={m.id} role="option" aria-selected={m.id === current?.id} className="picker-row" onClick={() => onPick(m.id, undefined)}>
              <span>{m.label}</span>{m.description && <small>{m.description}</small>}
            </button>
          ))}
        </div>
      )}
      {efforts.length > 0 && (
        <div className="picker-efforts">
          {focus === "model" && <span className="muted small">Effort</span>}
          <div className="effort-row">
            {efforts.map((e) => <button key={e} aria-pressed={e === effort} onClick={() => onPick(undefined, e)}>{e}</button>)}
          </div>
        </div>
      )}
      {focus === "effort" && efforts.length === 0 && <p className="muted small">This model doesn't offer effort levels.</p>}
    </div>
  );
}

export function Composer({ running, disabled, onSend, onStop, mascot, status, commands, models, model, effort, onCommand, onPickModel, panel, modeLabel, onMode }: {
  running: boolean; disabled?: boolean; onSend: (text: string) => void; onStop: () => void; mascot: ReactNode; status: string;
  commands: SlashCommand[]; models: ModelOption[]; model?: string; effort?: string;
  onCommand: (cmd: SlashCommand, args: string) => void; onPickModel: (model?: string, effort?: string) => void;
  /** An open panel (Claude's /mcp, /status, /context, mode), drawn above the input box. */
  panel?: ReactNode; modeLabel?: string; onMode?: () => void;
}) {
  const [text, setText] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [picker, setPicker] = useState<null | "model" | "effort">(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  // The menu shows while typing a command name: "/" followed by no space yet.
  const query = /^\/(\S*)$/.exec(text)?.[1];
  const matches = useMemo(() => (query === undefined ? [] : matchCommands(commands, query)), [commands, query]);
  const menuOpen = query !== undefined && !dismissed && matches.length > 0;

  const setValue = (v: string) => {
    setText(v); setHighlight(0); setDismissed(false);
    const el = ref.current;
    if (el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 240) + "px"; }
  };

  const run = (cmd: SlashCommand, args: string) => {
    setValue("");
    if ((cmd.run === "model" || cmd.run === "effort") && !args) { setPicker(cmd.run); return; }
    if (cmd.run === "model") { onPickModel(args, undefined); return; }
    if (cmd.run === "effort") { onPickModel(undefined, args); return; }
    onCommand(cmd, args);
  };

  const choose = (cmd: SlashCommand) => {
    // Commands that take arguments wait for them; the rest run straight away.
    if (cmd.hint && cmd.run !== "model" && cmd.run !== "effort" && cmd.run !== "terminal" && cmd.run !== "panel") { setValue(`/${cmd.name} `); ref.current?.focus(); return; }
    run(cmd, "");
  };

  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    const m = /^\/(\S+)\s*([\s\S]*)$/.exec(t);
    const cmd = m && commands.find((c) => c.name === m[1]);
    if (cmd) { if (!running || cmd.run === "terminal" || cmd.run === "panel" || cmd.run === "model" || cmd.run === "effort") run(cmd, m![2]!.trim()); return; }
    if (running) return;
    onSend(t);
    setValue("");
  };

  const modelLabel = models.find((m) => m.id === model)?.label ?? model;

  return (
    <div className="composer">
      <div className="composer-mascot">{mascot}<span className="composer-status">{status}</span></div>
      {menuOpen && (
        <div className="slash-menu" role="listbox" aria-label="Commands">
          {matches.map((c, i) => (
            <button key={c.name} role="option" aria-selected={i === highlight} className="slash-row"
              onMouseEnter={() => setHighlight(i)} onMouseDown={(e) => { e.preventDefault(); choose(c); }}
              ref={(el) => { if (i === highlight) el?.scrollIntoView({ block: "nearest" }); }}>
              <span className="slash-name">/{c.name}{c.hint && <span className="slash-hint"> {c.hint}</span>}</span>
              <span className="slash-desc">{c.description}</span>
              {RUN_LABEL[c.run] && <span className={`slash-tag ${c.run}`}>{RUN_LABEL[c.run]}</span>}
            </button>
          ))}
        </div>
      )}
      {!picker && panel}
      {picker && <ModelPicker models={models} model={model} effort={effort} focus={picker} onClose={() => setPicker(null)} onPick={(m, e) => { onPickModel(m, e); setPicker(null); }} />}
      <div className="composer-box">
        <textarea id="prompt" ref={ref} rows={1} value={text} disabled={disabled}
          placeholder={running ? "Working… press Esc to stop" : "Ask for a change, a fix, or an explanation. Type / for commands"}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (menuOpen) {
              if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => (h + 1) % matches.length); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => (h - 1 + matches.length) % matches.length); return; }
              if (e.key === "Tab") { e.preventDefault(); setValue(`/${matches[highlight]!.name} `); return; }
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); choose(matches[highlight]!); return; }
              if (e.key === "Escape") { e.preventDefault(); setDismissed(true); return; }
            }
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
            if (e.key === "Escape" && running) onStop();
            if (e.key === "Escape" && picker) setPicker(null);
          }} />
        {running
          ? <button className="send stop" onClick={onStop} aria-label="Stop">Stop</button>
          : <button className="send" onClick={submit} disabled={!text.trim() || disabled} aria-label="Send">Send</button>}
      </div>
      <div className="composer-foot">
        <button className="model-chip" onClick={() => setPicker(picker === "model" ? null : "model")} title="Choose the model and effort">
          {modelLabel ?? "Model"}{effort ? ` · ${effort}` : ""}<span aria-hidden="true"> ▾</span>
        </button>
        {modeLabel && onMode && (
          <button className="model-chip" onClick={onMode} title="Choose what Claude may do without asking">
            {modeLabel}<span aria-hidden="true"> ▾</span>
          </button>
        )}
        <span className="composer-hint">Enter to send · Shift+Enter for a new line · / for commands{running ? " · Esc to stop" : ""}</span>
      </div>
    </div>
  );
}
