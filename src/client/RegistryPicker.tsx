import { useEffect, useState } from "react";
export type RegistryRow = { id: string; name: string; version: string; description: string; how: "npm" | "download" | "uvx"; website?: string };

/**
 * The ACP registry's agents, to pick one for "Other ACP agent": searched by name, installed with one press into Friday's own folder
 * on this computer (a download checked against its SHA-256, or an npm package), and set as the agent's command.
 */
export function RegistryPicker({ registry }: { registry: { load: () => Promise<RegistryRow[]>; add: (id: string) => Promise<void> } }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<RegistryRow[] | null>(null);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!open || rows) return;
    registry.load().then(setRows, (e) => (setRows([]), setNote((e as Error).message)));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open)
    return (
      <p className="mb-reg-open">
        <button type="button" className="link-btn" onClick={() => setOpen(true)}>
          Choose one from the ACP registry
        </button>
      </p>
    );
  const words = q.trim().toLowerCase();
  const shown = (rows ?? []).filter((r) => !words || `${r.name} ${r.id} ${r.description}`.toLowerCase().includes(words));
  const how = (r: RegistryRow) => (r.how === "download" ? "Download" : r.how === "npm" ? "npm package" : "Needs uv");
  return (
    <div className="mb-reg">
      <input className="mb-acp-input mb-reg-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the ACP registry" aria-label="Search the ACP registry" spellCheck={false} autoFocus />
      {!rows ? (
        <p className="mb-reg-note">
          <span className="spinner tiny" /> Loading the registry…
        </p>
      ) : (
        <ul className="mb-reg-list" aria-label="Agents in the ACP registry">
          {shown.map((r) => (
            <li key={r.id} className="mb-reg-row">
              <span className="mb-reg-text">
                <span className="mb-reg-name">
                  {r.name} <span className="mb-reg-ver">{r.version}</span>
                </span>
                {r.description && <span className="mb-reg-desc">{r.description}</span>}
              </span>
              <span className="mb-reg-how">{how(r)}</span>
              <button
                type="button"
                className="btn small"
                disabled={!!adding}
                onClick={() => {
                  setAdding(r.id);
                  setNote("");
                  registry
                    .add(r.id)
                    .then(
                      () => setOpen(false),
                      (e) => setNote((e as Error).message),
                    )
                    .finally(() => setAdding(""));
                }}
              >
                {adding === r.id ? <span className="spinner tiny" /> : null} {adding === r.id ? "Installing" : "Add"}
              </button>
            </li>
          ))}
          {rows.length > 0 && !shown.length && <li className="mb-reg-note">Nothing in the registry is called that.</li>}
        </ul>
      )}
      {note && (
        <p className="mb-acp-note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
