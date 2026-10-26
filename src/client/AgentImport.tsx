import { useEffect, useState } from "react";
import type { AgentView } from "../agents.js";
import type { FoundAgent } from "../runner/agent-files.js";
import { ENGINE_NAMES } from "../types.js";
import { Dialog } from "./AgentDialogs.js";
import { api } from "./api.js";
import { EngineMark } from "./BrandMarks.js";
import { hostApi } from "./local.js";
import { loadRecentFolders, type Identity } from "./storage.js";

/**
 * Bring in agents from your own Claude Code, Cursor and Codex.
 *
 * Your computer reads the agent files it has (yours, and those of the folders
 * you have worked in) and lists them here. Nothing is sent to Friday until you
 * press the button, and only the ones you tick. They arrive as private agents
 * with no connections and no web search, and importing the same file again
 * updates the agent it made instead of adding another.
 */
const SOURCES = ["claude", "cursor", "codex"] as const;

export function AgentImport({ identity, existing, onClose, onDone }: { identity: Identity; existing: AgentView[]; onClose: () => void; onDone: (agents: AgentView[], summary: string) => void }) {
  const [found, setFound] = useState<FoundAgent[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const have = new Set(existing.map((a) => (a as AgentView & { imported?: { key: string } }).imported?.key).filter(Boolean));

  useEffect(() => {
    let live = true;
    hostApi<{ found: FoundAgent[] }>(identity, "/api/runner/agents.discover", { method: "POST", body: JSON.stringify({ roots: loadRecentFolders() }) }).then(
      (r) => live && setFound(r.found),
      (e: Error) =>
        live &&
        (setFound([]),
        setError(
          // An older desktop app does not know this request yet: it needs the new version, not a reconnect.
          /Unknown request/i.test(e.message)
            ? "This version of the Friday desktop app can't read agents yet. Update the app, then try again."
            : "Friday couldn't reach your computer. Connect it from the new session page, then try again.",
        )),
    );
    return () => {
      live = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (key: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const add = async () => {
    const items = (found ?? []).filter((f) => picked.has(f.key)).map(({ source, key, name, description, instructions }) => ({ source, key, name, description, instructions }));
    if (!items.length || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<{ agents: AgentView[]; created: number; updated: number }>(identity, "/api/agents/import", { method: "POST", body: JSON.stringify({ items }) });
      const parts = [r.created ? `${r.created} added` : "", r.updated ? `${r.updated} updated` : ""].filter(Boolean);
      onDone(r.agents, `${parts.join(", ")} · private to you`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      className="si-dialog"
      title="Import agents"
      sub="From the Claude Code, Cursor and Codex on this computer. Tick the ones you want; they come in private, with no connections."
      onClose={onClose}
      onSubmit={() => void add()}
      actions={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!picked.size || busy}>
            {busy ? "Importing…" : picked.size ? `Import ${picked.size}` : "Import"}
          </button>
        </>
      }
    >
      {found === null ? (
        <p className="muted small">Looking on this computer…</p>
      ) : found.length === 0 ? (
        <p className="muted small">{error || "Nothing to import: no Claude Code agents in ~/.claude/agents, no Codex prompts in ~/.codex, and no Cursor rules in the folders you have used. Once you have some, they show up here."}</p>
      ) : (
        <div className="si-list">
          {SOURCES.map((src) => {
            const list = found.filter((f) => f.source === src);
            if (!list.length) return null;
            return (
              <section key={src}>
                <div className="si-group">
                  <span className="ai-src">
                    <EngineMark tool={src} size={14} /> {ENGINE_NAMES[src]} <span className="muted">· {list.length}</span>
                  </span>
                </div>
                <ul>
                  {list.map((f) => (
                    <li key={f.key}>
                      <label className={`si-row ${picked.has(f.key) ? "on" : ""}`}>
                        <input type="checkbox" checked={picked.has(f.key)} onChange={() => toggle(f.key)} />
                        <span className="si-text">
                          <span className="si-name">
                            {f.name}
                            <span className="chip-mini">{f.scope === "user" ? "Yours" : "This project"}</span>
                            {have.has(f.key) && <span className="chip-mini">Added · will update</span>}
                          </span>
                          <span className="si-desc" title={f.path}>
                            {f.description}
                            {f.note ? ` · ${f.note}` : ""}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      {found !== null && found.length > 0 && error && <p className="form-error">{error}</p>}
    </Dialog>
  );
}
