// The Files pane: the session's folder as a tree, and the picked file in an editor (CodeMirror).
// Files the agent changes update on screen; your unsaved edits are never overwritten without asking.
// Wide panes show the tree and the file side by side; narrow ones show one at a time.

import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { classHighlighter } from "@lezer/highlight";
import { PaneFrame } from "./ShellPane";

type Content = Awaited<ReturnType<typeof window.agents.files.read>>;
interface Entry { name: string; dir: boolean }
/** Per session: which folders are open, what's in them, and the file being shown. */
interface View { open: string[]; dirs: Record<string, Entry[]>; file: string | null; showTree: boolean }
const FRESH: View = { open: [""], dirs: {}, file: null, showTree: true };

const DIMMED = new Set([".git", "node_modules", "dist", "out", "build", ".next", "target", "__pycache__", ".venv", "venv"]);
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const cleanError = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** The editor: CodeMirror with line numbers, search, folding and the file's language. */
function CodeEditor({ path, text, onChange, onSave }: { path: string; text: string; onChange: (t: string) => void; onSave: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lang = useRef(new Compartment());
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(), highlightActiveLineGutter(), foldGutter(), drawSelection(), highlightActiveLine(), history(),
          indentOnInput(), bracketMatching(), search(), highlightSelectionMatches(), syntaxHighlighting(classHighlighter),
          keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { handlers.current.onSave(); return true; } }, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          lang.current.of([]),
          EditorView.updateListener.of((u) => { if (u.docChanged) handlers.current.onChange(u.state.doc.toString()); }),
          EditorView.lineWrapping,
        ],
      }),
    });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  // A newer copy from disk replaces the text (the pane only sends one when there are no unsaved edits).
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== text) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
  }, [text]);

  // The language loads on demand, from the file name.
  useEffect(() => {
    const desc = LanguageDescription.matchFilename(languages, path.split("/").pop() ?? path);
    if (!desc) return;
    let live = true;
    desc.load().then((support) => { if (live) view.current?.dispatch({ effects: lang.current.reconfigure(support) }); }).catch(() => {});
    return () => { live = false; };
  }, [path]);

  return <div className="code-editor" ref={host} />;
}

export function FilesPane({ visible, sessionId, folder, refreshKey, width, setWidth, onHide }: {
  visible: boolean; sessionId: string | null; folder: string; refreshKey: unknown;
  width: number; setWidth: (w: number) => void; onHide: () => void;
}) {
  const [views, setViews] = useState<Record<string, View>>({});
  const v: View = (sessionId && views[sessionId]) || FRESH;
  const setView = useCallback((patch: (cur: View) => Partial<View>) => {
    if (!sessionId) return;
    setViews((prev) => { const cur = prev[sessionId] ?? FRESH; return { ...prev, [sessionId]: { ...cur, ...patch(cur) } }; });
  }, [sessionId]);
  const [error, setError] = useState("");
  // The open file: what's on disk (content), what's in the editor (text), and whether the disk copy moved on.
  const [doc, setDoc] = useState<{ key: string; content: Content; text: string; dirty: boolean; changedOnDisk: boolean } | null>(null);
  const docKey = sessionId && v.file ? `${sessionId}:${v.file}` : null;

  const loadDir = useCallback(async (rel: string) => {
    if (!sessionId) return;
    try { const list = await window.agents.files.list(sessionId, rel); setView((cur) => ({ dirs: { ...cur.dirs, [rel]: list } })); }
    catch (err) { setError(cleanError(err)); }
  }, [sessionId, setView]);

  // Open folders load when shown, again after the agent finishes a turn (refreshKey), and on Refresh.
  const refreshAll = useCallback(() => { setError(""); v.open.forEach((d) => loadDir(d)); }, [v.open, loadDir]);
  useEffect(() => { if (visible && sessionId) refreshAll(); }, [visible, sessionId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const openFile = useCallback(async (rel: string) => {
    if (!sessionId) return;
    setView(() => ({ file: rel, showTree: false }));
    try {
      const content = await window.agents.files.read(sessionId, rel);
      setDoc({ key: `${sessionId}:${rel}`, content, text: content.kind === "text" ? content.text : "", dirty: false, changedOnDisk: false });
    } catch (err) { setError(cleanError(err)); }
  }, [sessionId, setView]);

  // Switching sessions shows that session's file again.
  useEffect(() => { if (!docKey) setDoc(null); else if (doc?.key !== docKey && v.file) openFile(v.file); }, [docKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // While showing, look for changes on disk every couple of seconds (agents edit files as they work).
  useEffect(() => {
    if (!visible || !sessionId || !v.file || !doc || doc.key !== docKey || doc.changedOnDisk) return;
    const file = v.file;
    const t = setInterval(async () => {
      const st = await window.agents.files.stat(sessionId, file).catch(() => null);
      if (!st || Math.abs(st.mtime - doc.content.mtime) <= 1) return;
      if (doc.dirty) setDoc((d) => (d && d.key === docKey ? { ...d, changedOnDisk: true } : d));
      else openFile(file);
    }, 2000);
    return () => clearInterval(t);
  }, [visible, sessionId, v.file, doc, docKey, openFile]);

  const save = useCallback(async (force = false) => {
    if (!sessionId || !v.file || !doc || doc.content.kind !== "text") return;
    try {
      const { mtime } = await window.agents.files.write(sessionId, v.file, doc.text, force ? undefined : doc.content.mtime);
      setDoc((d) => (d && d.content.kind === "text" ? { ...d, dirty: false, changedOnDisk: false, content: { ...d.content, mtime, text: d.text, size: new Blob([d.text]).size } } : d));
    } catch (err) {
      const msg = cleanError(err);
      if (/CHANGED_ON_DISK/.test(msg)) setDoc((d) => (d ? { ...d, changedOnDisk: true } : d));
      else setError(msg);
    }
  }, [sessionId, v.file, doc]);

  const toggleDir = (rel: string) => {
    if (v.open.includes(rel)) setView((cur) => ({ open: cur.open.filter((d) => d !== rel && !d.startsWith(rel + "/")) }));
    else { setView((cur) => ({ open: [...cur.open, rel] })); loadDir(rel); }
  };

  const renderDir = (rel: string, depth: number): React.ReactNode => {
    const list = v.dirs[rel];
    const pad = { paddingLeft: 10 + depth * 14 };
    if (!list) return <div className="ft-row muted" style={pad}>Loading…</div>;
    if (!list.length) return <div className="ft-row muted" style={pad}>Empty</div>;
    return list.map((e) => {
      const path = join(rel, e.name);
      const open = e.dir && v.open.includes(path);
      return (
        <div key={path} role="none">
          <button role="treeitem" className={`ft-row ${e.dir ? "dir" : "file"} ${path === v.file ? "on" : ""} ${DIMMED.has(e.name) || e.name.startsWith(".") ? "dim" : ""}`}
            style={pad} title={path} aria-expanded={e.dir ? open : undefined}
            onClick={() => (e.dir ? toggleDir(path) : openFile(path))}>
            <span className={`ft-icon ${open ? "open" : ""}`} aria-hidden="true">{e.dir ? "›" : ""}</span>
            <span className="ft-name">{e.name}</span>
          </button>
          {open && renderDir(path, depth + 1)}
        </div>
      );
    });
  };

  const current = doc && doc.key === docKey ? doc : null;
  const name = v.file?.split("/").pop();
  return (
    <PaneFrame hidden={!visible} label="Files" width={width} setWidth={setWidth} head={<>
      <strong>Files</strong>
      <span className="pane-spacer" />
      {current?.dirty && <button className="btn-small primary" onClick={() => save()} title="Save (Ctrl+S)">Save</button>}
      <button className="icon-btn" onClick={refreshAll} aria-label="Refresh" title="Refresh">↻</button>
      <button className="icon-btn" onClick={onHide} aria-label="Hide files" title="Hide files">×</button>
    </>}>
      {!sessionId ? <p className="muted small pad">Open a session to see its files.</p> : (
        <div className={`files-split ${v.file ? "has-file" : ""} ${v.showTree ? "tree-on" : ""}`}>
          <div className="file-tree" role="tree" aria-label={`Files in ${folder}`}>
            <div className="ft-root" title={folder}>{folder.split("/").filter(Boolean).pop() ?? folder}</div>
            {renderDir("", 0)}
          </div>
          {v.file && (
            <div className="file-view">
              <div className="file-bar">
                <button className="icon-btn tree-toggle" onClick={() => setView((cur) => ({ showTree: !cur.showTree }))} aria-label="Show the file list" title="Show the file list">☰</button>
                <span className="file-path" title={v.file}>{v.file}{current?.dirty ? " •" : ""}</span>
                {current && <span className="muted tiny">{fmtSize(current.content.size)}</span>}
                <button className="icon-btn" onClick={() => window.agents.files.reveal(sessionId, v.file!)} aria-label="Show in the file manager" title="Show in the file manager">⤴</button>
                <button className="icon-btn" onClick={() => { setView(() => ({ file: null, showTree: true })); setDoc(null); }} aria-label="Close the file" title="Close the file">×</button>
              </div>
              {current?.changedOnDisk && (
                <div className="file-banner" role="alert">
                  <span>This file changed on disk while you were editing it.</span>
                  <button className="btn-small" onClick={() => openFile(v.file!)}>Load theirs</button>
                  <button className="btn-small" onClick={() => save(true)}>Keep mine</button>
                </div>
              )}
              {!current ? <p className="muted small pad">Opening…</p>
                : current.content.kind === "text" ? (
                  <CodeEditor path={v.file} text={current.dirty ? current.text : current.content.text}
                    onChange={(t) => setDoc((d) => (d && d.key === docKey && d.content.kind === "text" ? { ...d, text: t, dirty: t !== d.content.text } : d))}
                    onSave={() => save()} />
                ) : current.content.kind === "image" ? (
                  <div className="file-image"><img src={current.content.dataUrl} alt={name} /></div>
                ) : <p className="muted small pad">{current.content.kind === "binary" ? "This file isn't text, so it can't be shown here." : "This file is too big to open here."}</p>}
            </div>
          )}
        </div>
      )}
      {error && <div className="file-banner error" role="alert"><span>{error}</span><button className="icon-btn" onClick={() => setError("")} aria-label="Dismiss">×</button></div>}
    </PaneFrame>
  );
}
