import { useState } from "react";
import type { UsageLimits } from "@shared/commands";

export const AGENT_NAMES = { claude: "Claude Code", codex: "Codex", grok: "Grok" } as const;

export function timeAgo(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function resetsIn(epochSec?: number): string | undefined {
  if (!epochSec) return undefined;
  const mins = Math.round((epochSec * 1000 - Date.now()) / 60000);
  if (mins <= 0) return "resets soon";
  return mins < 60 ? `resets in ${mins} min` : mins < 1440 ? `resets in ${Math.floor(mins / 60)} h ${mins % 60} min` : `resets in ${Math.round(mins / 1440)} days`;
}

/** How the session is paid for, without ever showing a key. */
export function billingLine(u?: UsageLimits): string | undefined {
  if (!u) return undefined;
  const parts: string[] = [];
  if (u.billing === "api_key") parts.push(`API key${u.keySource ? ` (${u.keySource})` : ""}, billed per token`);
  else if (u.billing === "subscription") parts.push(`${u.plan ?? "Subscription"}`);
  else if (u.plan) parts.push(u.plan);
  if (u.endpoint) parts.push(`via ${u.endpoint}`);
  return parts.join(" · ") || undefined;
}

export function LimitBars({ usage, compact }: { usage?: UsageLimits; compact?: boolean }) {
  if (!usage?.windows.length) return null;
  return (
    <div className={`limits ${compact ? "compact" : ""}`}>
      {usage.windows.map((w) => (
        <div key={w.label} className="limit" title={resetsIn(w.resetsAt)}>
          <div className="limit-label"><span>{w.label}</span><span className="limit-pct">{w.usedPct}%</span></div>
          <div className="limit-track"><div className={`limit-fill ${w.usedPct >= 90 ? "high" : w.usedPct >= 70 ? "mid" : ""}`} style={{ width: `${Math.min(100, w.usedPct)}%` }} /></div>
          {!compact && resetsIn(w.resetsAt) && <div className="limit-reset">{resetsIn(w.resetsAt)}</div>}
        </div>
      ))}
    </div>
  );
}

/** A small ↻ button that re-reads plan limits; spins while it works. */
export function RefreshUsage({ agent, label }: { agent?: UsageLimits["agent"]; label?: string }) {
  const [busy, setBusy] = useState(false);
  const run = () => { if (busy) return; setBusy(true); window.agents.refreshUsage(agent).catch(() => {}).finally(() => setBusy(false)); };
  return (
    <button className={`refresh-usage ${busy ? "busy" : ""}`} onClick={run} disabled={busy} title={agent ? "Refresh this agent's usage" : "Refresh usage for all agents"}>
      <span className="ru-icon" aria-hidden="true">↻</span>{label ?? (busy ? "Refreshing…" : "Refresh")}
    </button>
  );
}

/** The right panel's usage section for one agent. */
export function UsageDetails({ agent, usage, sessionCost }: { agent: UsageLimits["agent"]; usage?: UsageLimits; sessionCost?: number }) {
  const billing = billingLine(usage);
  return (
    <div className="usage-details">
      {billing && <div className="billing">{billing}</div>}
      <LimitBars usage={usage} />
      {agent === "grok" && !usage?.windows.length && <p className="muted small">Reading Grok's plan limits from its /usage screen… If they don't appear, type /usage in the Terminal tab.</p>}
      {agent !== "grok" && !usage?.windows.length && <p className="muted small">Limits appear after the agent's first reply.</p>}
      {sessionCost !== undefined && <div className="session-cost"><span className="muted">This session</span><strong>${sessionCost.toFixed(2)}</strong></div>}
      <div className="usage-foot">
        {usage?.updatedAt ? <span className="muted tiny">Updated {timeAgo(usage.updatedAt)}</span> : <span />}
        <RefreshUsage agent={agent} />
      </div>
    </div>
  );
}
