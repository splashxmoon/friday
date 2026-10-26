import { useRef, useState } from "react";
import type { Member } from "../types.js";
import { Icon } from "./icons.js";
import type { SavedCommandRow } from "./Shortcuts.js";
import { useConfirm, useDismiss } from "./ui.js";

/**
 * Where a team's own `/commands` are made and put away.
 *
 * Writing one is a name and some words. It can be yours alone or the whole workspace's, and the list says which, so nobody
 * is surprised to find a teammate's shortcut in their box.
 */
export function CommandsDialog({ commands, me, seed, onClose, onChanged }: { commands: SavedCommandRow[]; me: Member; seed?: string; onClose: () => void; onChanged: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  const [ask, confirmUI] = useConfirm();
  const [name, setName] = useState("");
  const [text, setText] = useState(seed ?? "");
  const [scope, setScope] = useState<"personal" | "workspace">("workspace");
  const [editing, setEditing] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const call = async (method: "POST" | "DELETE", url: string, body?: unknown) => {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        setErr(j.error ?? "Couldn't save the command. Try again.");
        return false;
      }
      onChanged();
      window.dispatchEvent(new Event("friday:commands"));
      return true;
    } finally {
      setBusy(false);
    }
  };
  const reset = () => (setName(""), setText(""), setEditing(null), setScope("workspace"));
  const save = async () => {
    if (await call("POST", "/api/commands", { name, text, scope, ...(editing ? { id: editing } : {}) })) reset();
  };

  return (
    <div className="overlay">
      {confirmUI}
      <div className="modal cmds-dialog" role="dialog" aria-modal="true" aria-label="Your commands" ref={ref}>
        <div className="pop-head">
          <h2>Commands</h2>
          <button type="button" className="icon-btn tiny" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        </div>
        <p className="muted small cmds-lead">Type / in the message box to run one. It writes its words there for you to read and change before sending.</p>

        <div className="cmds-form">
          <div className="cmds-name">
            <span>/</span>
            <input value={name} maxLength={30} placeholder="release-notes" aria-label="Command name" onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} />
          </div>
          <textarea value={text} rows={4} maxLength={4000} placeholder="Write the release notes for everything merged since the last tag, the way we write them: short, in the past tense, grouped by area." aria-label="What the command says" onChange={(e) => setText(e.target.value)} />
          <div className="cmds-row">
            <div className="cmds-scope" role="radiogroup" aria-label="Who can use it">
              <button type="button" role="radio" aria-checked={scope === "workspace"} className={scope === "workspace" ? "on" : ""} onClick={() => setScope("workspace")}>
                Everyone
              </button>
              <button type="button" role="radio" aria-checked={scope === "personal"} className={scope === "personal" ? "on" : ""} onClick={() => setScope("personal")}>
                Just me
              </button>
            </div>
            <span className="cmds-grow" />
            {editing && (
              <button type="button" className="btn ghost small" onClick={reset}>
                Cancel
              </button>
            )}
            <button type="button" className="btn primary small" disabled={busy || !name || !text.trim()} onClick={() => void save()}>
              {editing ? "Save changes" : "Save command"}
            </button>
          </div>
          {err && <p className="cmds-err">{err}</p>}
        </div>

        {commands.length > 0 && (
          <ul className="cmds-list">
            {commands.map((c) => {
              const mine = c.ownerId === me.id;
              return (
                <li key={c.id}>
                  <div className="cmds-item">
                    <div className="cmds-item-main">
                      <span className="cmds-item-name">/{c.name}</span>
                      <span className="cmds-item-meta">
                        {c.scope === "workspace" ? "Everyone" : "Just you"}
                        {!mine && ` · ${c.ownerName}`}
                      </span>
                    </div>
                    <div className="cmds-item-text">{c.text}</div>
                  </div>
                  {mine && (
                    <span className="cmds-item-tools">
                      <button type="button" className="icon-btn tiny" aria-label={`Edit /${c.name}`} title="Edit" onClick={() => (setEditing(c.id), setName(c.name), setText(c.text), setScope(c.scope))}>
                        <Icon name="pencil" size={14} />
                      </button>
                      <button type="button" className="icon-btn tiny" aria-label={`Delete /${c.name}`} title="Delete" onClick={() => ask({ title: `Delete /${c.name}?`, body: c.scope === "workspace" ? "Everyone in the workspace loses it." : undefined, action: "Delete command", onConfirm: () => void call("DELETE", `/api/commands/${c.id}`) })}>
                        <Icon name="trash" size={14} />
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
