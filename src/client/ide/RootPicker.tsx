import { useState } from "react";
import { FridayMark, Icon } from "../icons.js";
import type { Identity } from "../storage.js";
import { errorText, ide } from "./api.js";
import { rememberFolder, loadFolders } from "./store.js";
import { rootName } from "./util.js";

export interface RecentFolder {
  path: string;
  name: string;
  sid?: string;
}

/** What Code shows with no folder open: the folders you have worked in, and a box for a path. */
export function RootPicker({ identity, recent, onOpen }: { identity: Identity; recent: RecentFolder[]; onOpen: (root: string, sid?: string) => void }) {
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const known: RecentFolder[] = [...recent, ...loadFolders().filter((f) => !recent.some((r) => r.path === f.path))];
  const pick = window.fridayDesktop?.pickFolder;

  const open = async (p: string, sid?: string) => {
    const root = p.trim();
    if (!root) return;
    setBusy(true);
    setError("");
    try {
      // The folder is read once, so a mistyped path says so here instead of opening an empty Code.
      await ide(identity, "list", { root, dir: "" });
      rememberFolder(root, rootName(root));
      onOpen(root, sid);
    } catch (e) {
      setError(`Can't open that folder: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ix ix-rootpick">
      <div className="ix-rp-card">
        <span className="ix-rp-mark"><FridayMark size={24} /></span>
        <h2>Open a folder</h2>
        <p>Code works in a folder on this computer. Pick one you've used with an agent, or type its path.</p>
        {known.length > 0 && (
          <ul className="ix-rp-list" aria-label="Recent folders">
            {known.slice(0, 8).map((f) => (
              <li key={f.path}>
                <button type="button" className="ix-rp-row" disabled={busy} onClick={() => void open(f.path, f.sid)}>
                  <Icon name="folder" size={15} />
                  <span className="ix-rp-name">{f.name}</span>
                  <span className="ix-rp-path">{f.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="ix-rp-form"
          onSubmit={(e) => {
            e.preventDefault();
            void open(path);
          }}
        >
          <input className="ix-input solo" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/you/projects/app  or  C:\Users\you\app" aria-label="Folder path" spellCheck={false} autoFocus />
          {pick && (
            <button type="button" className="ix-btn" disabled={busy} onClick={() => void pick().then((p) => { if (p) void open(p); })}>
              Browse…
            </button>
          )}
          <button type="submit" className="ix-btn primary" disabled={busy || !path.trim()}>
            Open
          </button>
        </form>
        {error && <p className="ix-notice bad" role="alert">{error}</p>}
      </div>
    </div>
  );
}
