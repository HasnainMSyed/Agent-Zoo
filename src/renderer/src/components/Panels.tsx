// Graphical versions of Claude Code's menu-style commands: /mcp, /status, /context, and the
// permission mode (Shift+Tab in its terminal interface). Data comes straight from the running
// Claude process through its control protocol, so the panels show exactly what Claude sees.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CODEX_MODES, PERMISSION_MODES, type PanelKind } from "@shared/commands";
import type { AgentId } from "@shared/events";

type Json = Record<string, any>;

const TITLES: Record<PanelKind, string> = { mcp: "MCP servers", status: "Status", context: "Context", mode: "Permission mode" };
const REQUEST: Record<Exclude<PanelKind, "mode">, string> = { mcp: "mcp_status", status: "get_status", context: "get_context_usage" };

const cleanError = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

const modesFor = (agent: AgentId) => (agent === "codex" ? CODEX_MODES : PERMISSION_MODES);
export const modeLabel = (mode: string | undefined, agent: AgentId = "claude") =>
  modesFor(agent).find((m) => m.id === mode)?.label ?? (mode === "manual" ? "Ask before edits" : mode);

export function CommandPanel({ kind, sessionId, mode, onClose, onTerminal, agent = "claude" }: {
  kind: PanelKind; sessionId: string; mode?: string; onClose: () => void; agent?: AgentId;
  /** Opens the Terminal view and types a command there (for things only Claude's own interface can do, like signing in). */
  onTerminal: (typed: string) => void;
}) {
  const [data, setData] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    if (kind === "mode") return;
    setError("");
    window.agents.query(sessionId, REQUEST[kind]).then(setData).catch((e) => setError(cleanError(e)));
  }, [kind, sessionId]);
  useEffect(() => { setData(null); load(); }, [load]);

  /** Runs a change, then reloads the panel so it shows the result. */
  const act = async (key: string, subtype: string, payload: Json, close = false) => {
    setBusy(key); setError("");
    try { await window.agents.query(sessionId, subtype, payload); if (close) onClose(); else load(); }
    catch (e) { setError(cleanError(e)); }
    finally { setBusy(null); }
  };

  let body: ReactNode;
  if (kind === "mode") body = <ModeList agent={agent} mode={mode} busy={busy} onPick={(m) => act(m, "set_permission_mode", { mode: m }, true)} />;
  else if (!data && !error) body = <p className="muted small">Asking Claude…</p>;
  else if (data && kind === "status") body = <StatusView data={data} />;
  else if (data && kind === "context") body = <ContextView data={data} />;
  else if (data && kind === "mcp") body = <McpView agent={agent} data={data} busy={busy} act={act} onTerminal={onTerminal} />;

  return (
    <div className={`picker panel panel-${kind}`} role="dialog" aria-label={TITLES[kind]}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <div className="picker-head">
        <strong>{kind === "mode" && agent === "codex" ? "Approvals" : TITLES[kind]}</strong>
        <span className="panel-actions">
          {kind !== "mode" && <button onClick={load} aria-label="Refresh" title="Refresh">↻</button>}
          <button onClick={onClose} aria-label="Close">×</button>
        </span>
      </div>
      {error && <p className="panel-error" role="alert">{error}</p>}
      <div className="panel-body">{body}</div>
    </div>
  );
}

function ModeList({ agent, mode, busy, onPick }: { agent: AgentId; mode?: string; busy: string | null; onPick: (mode: string) => void }) {
  const current = mode === "manual" ? "default" : mode ?? (agent === "codex" ? "auto" : "default");
  return (
    <div className="picker-list" role="listbox" aria-label="Permission modes">
      {agent === "codex" && <p className="muted small">Applies from your next message.</p>}
      {modesFor(agent).map((m) => (
        <button key={m.id} role="option" aria-selected={m.id === current} className={`picker-row ${m.id === "bypassPermissions" || m.id === "full" ? "danger" : ""}`}
          disabled={busy !== null} onClick={() => onPick(m.id)}>
          <span>{m.label}{busy === m.id ? " …" : ""}</span><small>{m.description}</small>
        </button>
      ))}
    </div>
  );
}

function StatusView({ data }: { data: Json }) {
  const sections: Json[] = Array.isArray(data.sections) ? data.sections : [];
  if (!sections.length) return <p className="muted small">Claude didn't report any status.</p>;
  return (
    <div className="status-sections">
      {sections.map((sec, i) => (
        <section key={i}>
          <h3>{sec.title}</h3>
          <dl>{(sec.rows ?? []).map((r: Json, j: number) => <div key={j} className="status-row"><dt>{r.label}</dt><dd>{String(r.value)}</dd></div>)}</dl>
        </section>
      ))}
    </div>
  );
}

// A fixed palette for context categories, so the bar reads the same in every skin.
const CTX_COLORS = ["#d97757", "#5b8def", "#2fbf71", "#c678dd", "#f5a524", "#22b8cf", "#e5484d", "#a3a3a3"];

function ContextView({ data }: { data: Json }) {
  const cats: Json[] = Array.isArray(data.categories) ? data.categories : [];
  const max: number = data.maxTokens || 1;
  const used = cats.filter((c) => c.kind === "used" && c.tokens > 0);
  const buffer = cats.find((c) => c.kind === "buffer");
  const deferred = cats.filter((c) => c.kind === "deferred" && c.tokens > 0);
  const pct = (n: number) => (n / max) * 100;
  const pctLabel = (n: number) => { const p = pct(n); return p < 1 && n > 0 ? "<1%" : `${Math.round(p)}%`; };
  return (
    <div className="ctx-panel">
      <div className="ctx-total"><strong>{fmt(data.totalTokens ?? 0)}</strong> of {fmt(max)} tokens used <span className="muted">({data.percentage ?? Math.round(pct(data.totalTokens ?? 0))}%)</span></div>
      <div className="ctx-bar" role="img" aria-label={`${data.percentage ?? 0}% of the context window in use`}>
        {used.map((c, i) => <span key={c.id ?? c.name} style={{ width: `${pct(c.tokens)}%`, background: CTX_COLORS[i % CTX_COLORS.length] }} title={`${c.name}: ${fmt(c.tokens)}`} />)}
        <span className="ctx-free" />
        {buffer && <span className="ctx-buffer" style={{ width: `${pct(buffer.tokens)}%` }} title={`${buffer.name}: ${fmt(buffer.tokens)}`} />}
      </div>
      <ul className="ctx-legend">
        {used.map((c, i) => (
          <li key={c.id ?? c.name}><span className="swatch" style={{ background: CTX_COLORS[i % CTX_COLORS.length] }} />{c.name}<span className="ctx-num">{fmt(c.tokens)} · {pctLabel(c.tokens)}</span></li>
        ))}
        {buffer && <li><span className="swatch ctx-buffer" />{buffer.name}<span className="ctx-num">{fmt(buffer.tokens)} · {pctLabel(buffer.tokens)}</span></li>}
      </ul>
      {deferred.length > 0 && (
        <p className="muted tiny">Loaded only when needed, not counted: {deferred.map((c) => `${c.name.replace(/\s*\(deferred\)/i, "")} (${fmt(c.tokens)})`).join(", ")}</p>
      )}
    </div>
  );
}

const MCP_ORDER = ["connected", "pending", "needs-auth", "failed", "disabled"];
const MCP_LABEL: Record<string, string> = { connected: "Connected", pending: "Connecting", "needs-auth": "Needs sign-in", failed: "Failed", disabled: "Off" };

/** "plugin:engineering:slack" -> name "slack", from "engineering plugin". */
function serverName(full: string): { name: string; from?: string } {
  const m = /^plugin:([^:]+):(.+)$/.exec(full);
  return m ? { name: m[2]!, from: `${m[1]} plugin` } : { name: full };
}

function McpView({ agent, data, busy, act, onTerminal }: {
  agent: AgentId; data: Json; busy: string | null; act: (key: string, subtype: string, payload: Json) => void; onTerminal: (typed: string) => void;
}) {
  const codex = agent === "codex";
  const servers: Json[] = Array.isArray(data.mcpServers) ? [...data.mcpServers] : [];
  if (!servers.length) return <p className="muted small">No MCP servers are set up. Add one with <code>{codex ? "codex" : "claude"} mcp add</code> in a terminal.</p>;
  servers.sort((a, b) => MCP_ORDER.indexOf(a.status) - MCP_ORDER.indexOf(b.status) || a.name.localeCompare(b.name));
  const counts = MCP_ORDER.map((s) => [s, servers.filter((x) => x.status === s).length] as const).filter(([, n]) => n);
  return (
    <>
      <p className="mcp-summary">
        {counts.map(([s, n]) => <span key={s} className={`mcp-pill ${s}`}>{n} {MCP_LABEL[s]!.toLowerCase()}</span>)}
        {codex && <button className="btn-small mcp-reload" disabled={busy !== null} onClick={() => act("reload", "mcp_reconnect", {})}>{busy === "reload" ? "Reloading…" : "Reload servers"}</button>}
      </p>
      <ul className="mcp-list">
        {servers.map((s) => {
          const { name, from } = serverName(s.name);
          const tools = Array.isArray(s.tools) ? s.tools.length : undefined;
          const key = s.name;
          return (
            <li key={key} className="mcp-row">
              <span className={`mcp-dot ${s.status}`} aria-hidden="true" />
              <div className="mcp-main">
                <div className="mcp-name">{name}<span className="muted"> · {MCP_LABEL[s.status] ?? s.status}{tools !== undefined ? ` · ${tools} tools` : ""}</span></div>
                <div className="mcp-meta">{[from ?? s.scope, s.transport].filter(Boolean).join(" · ")}{s.error ? ` · ${s.error}` : ""}</div>
              </div>
              <div className="mcp-buttons">
                {codex ? null : busy === key ? <span className="muted small">…</span> : <>
                  {s.status === "needs-auth" && <button onClick={() => onTerminal("/mcp\r")} title="Sign-in happens in Claude's own interface">Sign in</button>}
                  {s.status === "failed" && <button onClick={() => act(key, "mcp_reconnect", { serverName: s.name })}>Retry</button>}
                  {s.status === "disabled"
                    ? <button onClick={() => act(key, "mcp_toggle", { serverName: s.name, enabled: true })}>Turn on</button>
                    : <button onClick={() => act(key, "mcp_toggle", { serverName: s.name, enabled: false })}>Turn off</button>}
                </>}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
