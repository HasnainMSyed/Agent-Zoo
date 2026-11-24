// The command palette (Ctrl+K): type to find a session, a folder or an action, Enter to run it.

import { useEffect, useMemo, useRef, useState } from "react";

export interface PaletteItem {
  id: string; label: string; group: string;
  /** Shown dimmed after the label (a folder, an agent, a shortcut). */
  hint?: string;
  /** Extra words that should find it (not shown). */
  keywords?: string;
  /** Only listed once something is typed (long lists like saved conversations). */
  searchOnly?: boolean;
  run: () => void;
}

/** Scores a match: every typed character in order; earlier, word-start and consecutive hits score more. */
export function score(query: string, text: string): number {
  const q = query.toLowerCase(), t = text.toLowerCase();
  if (!q) return 1;
  const at = t.indexOf(q);
  if (at >= 0) return 1000 - at + (at === 0 || /\W/.test(t[at - 1]!) ? 200 : 0);
  let pos = -1, total = 0, run = 0;
  for (const ch of q) {
    const next = t.indexOf(ch, pos + 1);
    if (next < 0) return 0;
    run = next === pos + 1 ? run + 1 : 0;
    total += 10 + run * 5 + (next === 0 || /\W/.test(t[next - 1]!) ? 8 : 0) - Math.min(next - pos, 10);
    pos = next;
  }
  return Math.max(total, 1);
}

export function CommandPalette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  const shown = useMemo(() => {
    const q = query.trim();
    const scored = items
      .filter((it) => q || !it.searchOnly)
      .map((it) => ({ it, s: q ? Math.max(score(q, it.label), score(q, `${it.label} ${it.hint ?? ""} ${it.keywords ?? ""}`) * 0.8) : 1 }))
      .filter((x) => x.s > 0);
    if (!q) return scored.slice(0, 80).map((x) => x.it);
    // Groups keep their order; inside each, best matches first (a few per group).
    const groups = [...new Set(items.map((it) => it.group))];
    return groups.flatMap((g) => scored.filter((x) => x.it.group === g).sort((a, b) => b.s - a.s).slice(0, 8).map((x) => x.it));
  }, [items, query]);
  useEffect(() => { setIndex(0); }, [query]);

  const run = (it?: PaletteItem) => { if (!it) return; onClose(); it.run(); };

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <input ref={input} className="palette-input" value={query} placeholder="Search sessions, folders and actions…" aria-label="Search"
          role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={shown[index] ? `pal-${shown[index]!.id}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(i + 1, shown.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); run(shown[index]); }
            else if (e.key === "Escape") { e.preventDefault(); onClose(); }
          }} />
        <div className="palette-list" id="palette-list" role="listbox">
          {shown.length === 0 && <p className="muted small pad">Nothing matches “{query}”.</p>}
          {shown.map((it, i) => (
            <div key={it.id}>
              {(i === 0 || shown[i - 1]!.group !== it.group) && <div className="palette-group">{it.group}</div>}
              <button id={`pal-${it.id}`} role="option" aria-selected={i === index} className="palette-row"
                ref={(el) => { if (i === index) el?.scrollIntoView({ block: "nearest" }); }}
                onMouseMove={() => setIndex(i)} onClick={() => run(it)}>
                <span className="palette-label">{it.label}</span>
                {it.hint && <span className="palette-hint">{it.hint}</span>}
              </button>
            </div>
          ))}
        </div>
        <div className="palette-foot muted tiny">↑↓ to move · Enter to run · Esc to close</div>
      </div>
    </div>
  );
}
