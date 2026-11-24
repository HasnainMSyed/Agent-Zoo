import { useEffect, useRef } from "react";
import type { PermissionOption } from "@shared/events";
import type { Item } from "../state";
import { DiffView, Icon, inputDiff } from "./ToolCard";

type PermissionItem = Extract<Item, { type: "permission" }>;

const RESOLVED: Record<PermissionOption["id"], string> = { allow: "Allowed once", allow_always: "Always allowed", deny: "Denied" };

export function ApprovalCard({ item, onDecide }: { item: PermissionItem; onDecide: (d: PermissionOption["id"]) => void }) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!item.decision) first.current?.focus(); }, [item.decision]);

  if (item.decision) {
    return <div className={`approval-done ${item.decision === "deny" ? "denied" : ""}`}><Icon kind={item.tool} />{item.title}<span>{RESOLVED[item.decision]}</span></div>;
  }
  const diff = item.diff ?? (item.tool === "edit" ? inputDiff(item.input) : null);
  const command = item.tool === "shell" ? String(item.input.command ?? "") : null;
  return (
    <div className="approval" role="alertdialog" aria-label={`Approve ${item.title}`}>
      <div className="approval-head"><Icon kind={item.tool} /><div><strong>{item.name} wants to run</strong><span>{item.title}</span></div></div>
      {command && <pre className="approval-cmd">$ {command}</pre>}
      {diff && <DiffView hunks={diff} />}
      {!command && !diff && <pre className="approval-cmd">{JSON.stringify(item.input, null, 2)}</pre>}
      {item.reason && <p className="approval-reason">{item.reason}</p>}
      <div className="approval-actions">
        {item.options.map((o, i) => (
          <button key={o.id} ref={i === 0 ? first : undefined} className={o.id === "deny" ? "btn-ghost" : i === 0 ? "btn-primary" : "btn-secondary"} onClick={() => onDecide(o.id)}>{o.label}</button>
        ))}
      </div>
    </div>
  );
}
