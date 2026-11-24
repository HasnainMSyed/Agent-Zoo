import { useState, type ReactNode } from "react";
import type { DiffHunk, ToolKind } from "@shared/events";
import type { Item } from "../state";

type ToolItem = Extract<Item, { type: "tool" }>;

const ICONS: Record<ToolKind, string> = {
  shell: "M4 6l4 4-4 4M10 15h6", edit: "M4 16l1-4 8-8 3 3-8 8-4 1z", read: "M4 4h9l3 3v9H4zM7 9h6M7 12h6",
  search: "M9 14a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM13 13l4 4", web: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM3 10h14M10 3c3 3 3 11 0 14M10 3c-3 3-3 11 0 14",
  subagent: "M10 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM4 17c0-3 3-5 6-5s6 2 6 5", todo: "M4 6l2 2 3-3M4 13l2 2 3-3M12 7h5M12 14h5",
  mcp: "M7 3v4M13 3v4M5 7h10v3a5 5 0 0 1-10 0zM10 15v3", other: "M10 4v12M4 10h12",
};

const APPROVAL_LABEL = { allow: "You allowed", allow_always: "Always allowed", deny: "You denied" } as const;

export function Icon({ kind }: { kind: ToolKind }) {
  return <svg className="icon" viewBox="0 0 20 20" aria-hidden="true"><path d={ICONS[kind]} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function DiffView({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <div className="diff" role="table">
      {hunks.map((h, hi) => {
        let oldN = h.oldStart, newN = h.newStart;
        return (
          <div key={hi} className="hunk">
            {h.lines.map((line, li) => {
              const sign = line[0];
              const cls = sign === "+" ? "add" : sign === "-" ? "del" : "same";
              const o = sign === "+" ? "" : oldN++;
              const n = sign === "-" ? "" : newN++;
              return (
                <div key={li} className={`dl ${cls}`} role="row">
                  <span className="ln">{o}</span><span className="ln">{n}</span>
                  <span className="sign">{sign === " " ? "" : sign}</span><code>{line.slice(1) || " "}</code>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** A diff built from an edit's input, used before the tool has run (approvals, pending edits). */
export function inputDiff(input: Record<string, unknown>): DiffHunk[] | null {
  if (typeof input.old_string === "string" && typeof input.new_string === "string") {
    const lines = [...input.old_string.split("\n").map((l) => "-" + l), ...input.new_string.split("\n").map((l) => "+" + l)];
    return [{ oldStart: 1, newStart: 1, lines }];
  }
  if (typeof input.content === "string") return [{ oldStart: 0, newStart: 1, lines: input.content.split("\n").map((l) => "+" + l) }];
  return null;
}

function countChanges(hunks: DiffHunk[]) {
  let add = 0, del = 0;
  for (const h of hunks) for (const l of h.lines) { if (l[0] === "+") add++; else if (l[0] === "-") del++; }
  return { add, del };
}

function Output({ text, error }: { text: string; error?: boolean }) {
  const lines = text.split("\n");
  const [all, setAll] = useState(lines.length <= 14);
  return (
    <div className={`output ${error ? "error" : ""}`}>
      <pre>{all ? text : lines.slice(0, 12).join("\n")}</pre>
      {!all && <button className="more" onClick={() => setAll(true)}>Show all {lines.length} lines</button>}
    </div>
  );
}

function Status({ ok }: { ok?: boolean }) {
  if (ok === undefined) return <span className="status running"><span className="spinner" />Running</span>;
  return ok ? <span className="status ok">Done</span> : <span className="status failed">Failed</span>;
}

export function ToolCard({ item, renderChildren }: { item: ToolItem; renderChildren: (items: Item[]) => ReactNode }) {
  const { tool, title, input, result, ok } = item;
  const failed = ok === false;
  const autoOpen = failed || tool === "edit" || tool === "subagent" || tool === "todo" || (tool === "shell" && ok !== undefined);
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? autoOpen;

  let meta: ReactNode = null;
  let body: ReactNode = null;

  if (tool === "shell") {
    const command = String(input.command ?? "");
    if (command && command !== title) meta = <code className="cmd">{command}</code>;
    if (result?.kind === "shell") {
      const out = [result.stdout, result.stderr].filter(Boolean).join("\n");
      body = out ? <Output text={out} error={!!result.stderr && !result.stdout} /> : <div className="empty">No output</div>;
    } else if (item.live) {
      body = <Output text={item.live} />;
    }
  } else if (tool === "edit") {
    const hunks = result?.kind === "edit" ? result.hunks : inputDiff(input);
    if (hunks) {
      const c = countChanges(hunks);
      meta = <span className="changes"><span className="add">+{c.add}</span> <span className="del">−{c.del}</span></span>;
      body = <DiffView hunks={hunks} />;
    }
  } else if (tool === "read" && result?.kind === "read") {
    meta = <span className="muted">lines {result.startLine}–{result.startLine + Math.max(result.numLines - 1, 0)} of {result.totalLines}</span>;
    body = <pre className="file">{result.content.split("\n").map((l, i) => <div key={i}><span className="ln">{result.startLine + i}</span>{l}</div>)}</pre>;
  } else if (tool === "todo") {
    const todos = Array.isArray(input.todos) ? (input.todos as { content?: string; status?: string }[]) : [];
    body = <ul className="todos">{todos.map((t, i) => <li key={i} data-status={t.status}>{t.content}</li>)}</ul>;
  } else if (tool === "subagent") {
    body = <div className="children">{renderChildren(item.children)}</div>;
    meta = <span className="muted">{item.children.filter((c) => c.type === "tool").length} steps</span>;
  }
  if (failed && result?.kind === "text") body = <Output text={result.text} error />;
  else if (!body && result?.kind === "text" && result.text) body = <Output text={result.text} />;

  return (
    <div className={`tool tool-${tool} ${failed ? "is-failed" : ""} ${ok === undefined ? "is-running" : ""}`}>
      <button className="tool-head" onClick={() => setOpen(!isOpen)} aria-expanded={isOpen} disabled={!body}>
        <Icon kind={tool} />
        <span className="tool-title">{title}</span>
        {meta && <span className="tool-meta">{meta}</span>}
        {item.approval && <span className={`approval-badge ${item.approval === "deny" ? "denied" : ""}`}>{APPROVAL_LABEL[item.approval]}</span>}
        <Status ok={ok} />
        {body && <svg className={`chev ${isOpen ? "open" : ""}`} viewBox="0 0 20 20" aria-hidden="true"><path d="M7 8l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>}
      </button>
      {isOpen && body && <div className="tool-body">{body}</div>}
    </div>
  );
}
