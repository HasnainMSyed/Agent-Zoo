// The Settings page: a local profile, each agent's sign-in, appearance, mascots and defaults.
// Nothing here leaves the computer; sign-in and sign-out run each agent's own command.

import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import type { AgentId } from "@shared/events";
import { PERMISSION_MODES, type AccountInfo, type UsageLimits } from "@shared/commands";
import { AGENT_COLOR_DEFAULTS, type Settings } from "../settings";
import { packFor, type MascotPack } from "../mascots";
import type { MascotState } from "../state";
import { Mascot } from "./Mascot";
import { AGENT_NAMES, LimitBars } from "./Usage";
import { TerminalView, clearTerminalBuffer } from "./TerminalView";

const AGENTS: AgentId[] = ["claude", "codex", "grok"];
const SECTIONS = [["profile", "Profile"], ["accounts", "Agents & accounts"], ["appearance", "Appearance"], ["mascots", "Mascots"], ["defaults", "New sessions"], ["about", "About"]] as const;

export const initials = (name: string) => name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

function Choice<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => <button key={v} role="radio" aria-checked={v === value} onClick={() => onChange(v)}>{text}</button>)}
    </div>
  );
}

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <div className="set-row"><div className="set-label"><span>{title}</span>{hint && <small>{hint}</small>}</div><div className="set-control">{children}</div></div>;
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button className="toggle" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}><span /></button>;
}

/** Runs an agent's sign-in or sign-out in a small terminal, then refreshes the account cards. */
function AccountTerminal({ agent, action, onDone }: { agent: AgentId; action: "login" | "logout"; onDone: () => void }) {
  const [id, setId] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    let mine: string | null = null;
    let alive = true;
    window.agents.accountRun(agent, action).then((tid) => { mine = tid; if (alive) setId(tid); else window.agents.accountClose(tid); });
    const off = window.agents.onEvent((sid, e) => { if (sid === mine && e.kind === "exited") setEnded(true); });
    return () => { alive = false; off(); if (mine) { window.agents.accountClose(mine); clearTerminalBuffer(mine); } };
  }, [agent, action]);
  return (
    <div className="account-term" data-skin={agent}>
      <div className="account-term-head">
        <strong>{action === "login" ? "Sign in to" : "Sign out of"} {AGENT_NAMES[agent]}</strong>
        <span className="muted small">{ended ? "Finished." : "Follow the steps below."}</span>
        <button className="btn-small" onClick={onDone}>{ended ? "Done" : "Cancel"}</button>
      </div>
      {id && <TerminalView sessionId={id} />}
    </div>
  );
}

export function SettingsPage({ settings, onChange, user, version, usage, onClose, packs, onMakeMascot, onPacksChanged }: {
  settings: Settings; onChange: (s: Settings) => void; user: string; version: string;
  usage: Partial<Record<AgentId, UsageLimits>>; onClose: () => void;
  packs: MascotPack[]; onMakeMascot: (description: string) => void; onPacksChanged: () => void;
}) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...settings, [k]: v });
  const [accts, setAccts] = useState<Record<AgentId, AccountInfo> | null>(null);
  const [term, setTerm] = useState<{ agent: AgentId; action: "login" | "logout" } | null>(null);
  const refresh = useCallback(() => { setAccts(null); window.agents.accounts().then(setAccts).catch(() => {}); }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const name = settings.displayName || user || "You";
  const go = (id: string) => document.getElementById(`set-${id}`)?.scrollIntoView({ behavior: settings.reduceMotion ? "auto" : "smooth", block: "start" });

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings sections">
        <div className="settings-title"><h1>Settings</h1><button className="icon-btn" onClick={onClose} aria-label="Close settings" title="Close settings">×</button></div>
        {SECTIONS.map(([id, label]) => <button key={id} onClick={() => go(id)}>{label}</button>)}
      </nav>
      <div className="settings-body">
        <section id="set-profile" className="set-card">
          <h2>Profile</h2>
          <div className="profile-head">
            <span className="avatar big" aria-hidden="true">{initials(name)}</span>
            <div><strong>{name}</strong><span className="muted small">A local profile on this computer. There's no Agent Zoo account; each agent keeps its own sign-in.</span></div>
          </div>
          <Row title="Display name" hint={`Leave empty to use your computer's user name (${user || "unknown"})`}>
            <input className="text-input" value={settings.displayName} placeholder={user} onChange={(e) => set("displayName", e.target.value)} />
          </Row>
        </section>

        <section id="set-accounts" className="set-card">
          <div className="set-card-head"><h2>Agents &amp; accounts</h2><button className="btn-small" onClick={refresh}>Refresh</button></div>
          {term && <AccountTerminal key={`${term.agent}-${term.action}`} agent={term.agent} action={term.action} onDone={() => { setTerm(null); refresh(); }} />}
          <div className="account-list">
            {AGENTS.map((a) => {
              const info = accts?.[a];
              const plan = info?.plan ?? usage[a]?.plan;
              const state = !info ? "checking" : !info.installed ? "missing" : info.signedIn ? "in" : info.signedIn === false ? "out" : "unknown";
              const label = { checking: "Checking…", missing: "Not installed", in: "Signed in", out: "Signed out", unknown: "Unknown" }[state];
              return (
                <div key={a} className="account-card" data-skin={a}>
                  <Mascot pack={packFor(a)} state="idle" size={38} />
                  <div className="account-main">
                    <div className="account-name"><strong>{AGENT_NAMES[a]}</strong><span className={`acct-pill ${state}`}>{label}</span></div>
                    <div className="muted small">{[plan, info?.method, info?.who].filter(Boolean).join(" · ") || (state === "missing" ? `Install the ${a} CLI to use it here.` : "")}</div>
                    {usage[a]?.windows.length ? <LimitBars usage={usage[a]} compact /> : null}
                  </div>
                  {info?.installed && (
                    <div className="account-actions">
                      {info.signedIn
                        ? <button className="btn-small" onClick={() => setTerm({ agent: a, action: "logout" })}>Sign out</button>
                        : <button className="btn-small primary" onClick={() => setTerm({ agent: a, action: "login" })}>Sign in</button>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section id="set-appearance" className="set-card">
          <h2>Appearance</h2>
          <Row title="Theme"><Choice label="Theme" value={settings.theme} onChange={(v) => set("theme", v)} options={[["system", "System"], ["light", "Light"], ["dark", "Dark"]]} /></Row>
          <Row title="Colours" hint="Follow the agent you're working with, or keep one look everywhere">
            <Choice label="Colours" value={settings.skin} onChange={(v) => set("skin", v)} options={[["agent", "Follow agent"], ["claude", "Claude"], ["codex", "Codex"], ["grok", "Grok"]]} />
          </Row>
          <Row title="Agent colours" hint="Used for session dots and agent markers">
            <div className="color-row">
              {AGENTS.map((a) => (
                <label key={a} className="color-pick" title={AGENT_NAMES[a]}>
                  <input type="color" value={settings.agentColors[a]} onChange={(e) => set("agentColors", { ...settings.agentColors, [a]: e.target.value })} />
                  <span>{AGENT_NAMES[a]}</span>
                </label>
              ))}
              <button className="btn-small" onClick={() => set("agentColors", AGENT_COLOR_DEFAULTS)}>Reset</button>
            </div>
          </Row>
          <Row title="Text size"><Choice label="Text size" value={settings.textSize} onChange={(v) => set("textSize", v)} options={[["small", "Small"], ["default", "Default"], ["large", "Large"]]} /></Row>
          <Row title="Reduce motion" hint="Turns off folding animations and mascot movement"><Toggle label="Reduce motion" on={settings.reduceMotion} onChange={(v) => set("reduceMotion", v)} /></Row>
        </section>

        <section id="set-mascots" className="set-card">
          <MascotSettings settings={settings} set={set} packs={packs} onMake={onMakeMascot} onChanged={onPacksChanged} />
        </section>

        <section id="set-defaults" className="set-card">
          <h2>New sessions</h2>
          <Row title="Agent picked first" hint="On a project's start card">
            <Choice label="Default agent" value={settings.defaultAgent} onChange={(v) => set("defaultAgent", v)} options={[["last", "Last used"], ["claude", "Claude"], ["codex", "Codex"], ["grok", "Grok"]]} />
          </Row>
          <Row title="Claude permission mode" hint="What new Claude sessions may do without asking">
            <select className="text-input" value={settings.claudeMode} onChange={(e) => set("claudeMode", e.target.value)}>
              {PERMISSION_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </Row>
        </section>

        <section id="set-about" className="set-card">
          <h2>About</h2>
          <dl className="about">
            <dt>Agent Zoo</dt><dd>{version}</dd>
            {AGENTS.map((a) => (
              <Fragment key={a}><dt>{AGENT_NAMES[a]}</dt><dd>{accts ? (accts[a].installed ? accts[a].version ?? "installed" : "not installed") : "…"}</dd></Fragment>
            ))}
          </dl>
        </section>
      </div>
    </div>
  );
}

const STATES: MascotState[] = ["idle", "thinking", "working", "waiting", "done", "error"];

/** Choose a mascot per agent, preview it in every state, and add your own packs. */
function MascotSettings({ settings, set, packs, onMake, onChanged }: {
  settings: Settings; set: <K extends keyof Settings>(k: K, v: Settings[K]) => void; packs: MascotPack[];
  onMake: (description: string) => void; onChanged: () => void;
}) {
  const [focus, setFocus] = useState<AgentId>("claude");
  const [making, setMaking] = useState<string | null>(null);
  const [error, setError] = useState("");
  const chosen = packFor(focus);
  const pick = (agent: AgentId, id: string) => set("mascots", { ...settings.mascots, [agent]: id });
  const userPacks = packs.filter((p) => p.user);
  const run = async (fn: () => Promise<unknown>) => { setError(""); try { await fn(); onChanged(); } catch (e) { setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e)); } };
  return (
    <>
      <h2>Mascots</h2>
      <Row title="Show mascots"><Toggle label="Show mascots" on={settings.showMascots} onChange={(v) => set("showMascots", v)} /></Row>
      <div className="mascot-agents seg" role="tablist" aria-label="Agent">
        {AGENTS.map((a) => <button key={a} role="tab" aria-checked={a === focus} onClick={() => setFocus(a)}>{AGENT_NAMES[a]}</button>)}
      </div>
      <div className="pack-grid" role="radiogroup" aria-label={`Mascot for ${AGENT_NAMES[focus]}`}>
        {packs.map((p) => (
          <button key={p.id} role="radio" aria-checked={chosen?.id === p.id} className="pack-card" data-skin={focus} onClick={() => pick(focus, p.id)} title={p.description || p.name}>
            <Mascot pack={p} state="idle" size={52} />
            <strong>{p.name}</strong>
            <span className="muted tiny">{p.user ? "Yours" : p.agent ? `Made for ${AGENT_NAMES[p.agent]}` : "Built in"}</span>
          </button>
        ))}
      </div>
      {chosen && (
        <div className="pack-preview" data-skin={focus}>
          {STATES.map((st) => <div key={st} className="pp-state"><Mascot pack={chosen} state={st} size={48} /><span className="muted tiny">{st}</span></div>)}
        </div>
      )}
      <div className="pack-actions">
        {making === null
          ? <button className="btn-small primary" onClick={() => setMaking("")}>✦ Make a mascot…</button>
          : (
            <form className="make-form" onSubmit={(e) => { e.preventDefault(); if (making.trim()) { onMake(making.trim()); setMaking(null); } }}>
              <input className="text-input" autoFocus value={making} onChange={(e) => setMaking(e.target.value)} placeholder="Describe it, e.g. a sleepy pixel cat with a tiny wizard hat" />
              <button className="btn-small primary" type="submit">Make it with Claude</button>
              <button className="btn-small" type="button" onClick={() => setMaking(null)}>Cancel</button>
            </form>
          )}
        <button className="btn-small" onClick={() => run(() => window.agents.mascots.import())}>Import…</button>
        <button className="btn-small" onClick={() => window.agents.mascots.open()}>Open packs folder</button>
      </div>
      {error && <p className="panel-error" role="alert">{error}</p>}
      {userPacks.length > 0 && (
        <div className="user-packs">
          <span className="muted small">Your packs</span>
          {userPacks.map((p) => (
            <span key={p.id} className="user-pack">{p.name}
              <button aria-label={`Remove ${p.name}`} title="Remove this pack" onClick={() => { if (window.confirm(`Remove the mascot pack “${p.name}”? This deletes its folder.`)) run(() => window.agents.mascots.remove(p.id)); }}>×</button>
            </span>
          ))}
        </div>
      )}
      <p className="muted small">“Make a mascot” opens a Claude session in a new pack folder; the mascot appears here when Claude finishes. Packs are an SVG plus a small JSON file; the app animates them.</p>
    </>
  );
}
