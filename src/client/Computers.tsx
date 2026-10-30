import { useEffect, useState } from "react";
import { MenuButton } from "./ui.js";
import { pickMachine, pickedMachine } from "./local.js";
import { Icon } from "./icons.js";

/**
 * Your other computers, for the open-source edition (Arun, 2026-10-30: "lets also add support for multi machine for coding and
 * crew"). Settings › Computer & coding tools › Your computers: add one with a link to paste in its Friday, see which are linked
 * now, take one away; and on another computer, paste that link to use it from here (local/computers.ts, local/join.ts).
 * The new session's box says which computer it runs on once there is more than one (ComputerPill).
 */

export interface LinkedComputer {
  id: string;
  name: string;
  at: number;
  seen: number;
  connected: boolean;
  tools: { tool: string; name: string; loggedIn?: boolean | null }[];
  platform: string;
}
interface State {
  computers: LinkedComputer[];
  joined: { hub: { name: string; connected: boolean; address?: string; since?: number } | null; error?: string } | null;
  error?: string;
}

const call = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
  const r = await fetch(path, { credentials: "same-origin", ...init, headers: { "Content-Type": "application/json", "x-friday-local": "1", ...init.headers } });
  const b = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(b.error || "Couldn't reach Friday.");
  return b;
};

/** The computers linked now, as the places a session can run, refreshed while something shows them. */
export function useComputers(every = 8_000): { id: string; label: string }[] {
  const [list, setList] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    let gone = false;
    const read = () => void call<{ machines: { id: string; label: string }[] }>("/api/machines").then((r) => !gone && setList(r.machines), () => {});
    read();
    const t = setInterval(read, every);
    return () => ((gone = true), clearInterval(t));
  }, [every]);
  return list;
}

/**
 * Where a new session runs: this computer, or one of your others linked now. Shown only once there is another; the pick is this
 * browser's (local.ts pickMachine), so the folders and tools offered beside it are that computer's. `onPick`: the folder picked
 * was the other computer's, so it goes.
 */
export function ComputerPill({ here = "This computer", onPick }: { here?: string; onPick?: () => void }) {
  const computers = useComputers();
  const [on, setOn] = useState(pickedMachine);
  useEffect(() => {
    const sync = () => setOn(pickedMachine());
    addEventListener("friday:machine", sync);
    return () => removeEventListener("friday:machine", sync);
  }, []);
  // The one picked went away (removed, or not linked now): back to this computer, rather than every start failing there.
  useEffect(() => {
    if (on && computers.length && !computers.some((c) => c.id === on)) pickMachine("");
  }, [on, computers]);
  if (!computers.length && !on) return null;
  const current = computers.find((c) => c.id === on);
  const choose = (id: string) => {
    if (id === on) return;
    pickMachine(id);
    onPick?.();
  };
  return (
    <MenuButton
      className="cw-drop cw-computer"
      label={`Runs on ${current?.label ?? here}. Choose another computer`}
      text={current?.label ?? here}
      mark={<Icon name="server" size={13} />}
      above
      width={260}
      items={() => [
        { heading: "Runs on" },
        { label: here, icon: "server", checked: !on, onSelect: () => choose("") },
        ...computers.map((c) => ({ label: c.label, icon: "server" as const, checked: c.id === on, live: true, onSelect: () => choose(c.id) })),
      ]}
    />
  );
}

/** Settings › Computer & coding tools › Your computers. */
export function ComputersSettings() {
  const [state, setState] = useState<State | null>(null);
  const [link, setLink] = useState<{ link: string; until: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [typing, setTyping] = useState(false);
  const read = () => void call<State>("/api/computers").then(setState, () => {});
  useEffect(() => {
    read();
    const t = setInterval(read, 5_000);
    return () => clearInterval(t);
  }, []);
  // A computer paired with the link on screen: it has done its work.
  const count = state?.computers.length ?? 0;
  const [had, setHad] = useState<number | null>(null);
  useEffect(() => {
    if (had !== null && count > had) setLink(null);
    setHad(count);
  }, [count]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!link) return;
    const t = setTimeout(() => setLink(null), Math.max(0, link.until - Date.now()));
    return () => clearTimeout(t);
  }, [link]);
  if (!state) return null;

  const add = async () => {
    setError("");
    setCopied(false);
    try {
      const r = await call<{ link?: string; until?: number; error?: string }>("/api/computers/code", { method: "POST" });
      if (r.error || !r.link) return setError(r.error ?? "Couldn't make a link.");
      setLink({ link: r.link, until: r.until ?? Date.now() + 600_000 });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async (id: string) => setState(await call<State>(`/api/computers/${id}`, { method: "DELETE" }).catch(() => state));
  const join = async (link = paste.trim()) => {
    setBusy(true);
    setError("");
    try {
      const r = await call<State["joined"]>("/api/computers/join", { method: "POST", body: JSON.stringify({ link }) });
      if (r?.error) setError(r.error);
      else (setPaste(""), setTyping(false));
      read();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // One press: the link from the clipboard, where Copy link on the other computer put it. A clipboard that can't be read, or
  // holds something else, opens a field to paste it into (`typing`, with the hooks above).
  const fromClipboard = async () => {
    const text = await navigator.clipboard?.readText().catch(() => "");
    if (text?.trim().startsWith("friday://computer")) return void join(text.trim());
    setTyping(true);
  };
  const leave = async () => {
    await call("/api/computers/join", { method: "DELETE" }).catch(() => {});
    read();
  };
  const hub = state.joined?.hub ?? null;
  // The ones ready to work there: signed in, not only installed.
  const tools = (c: LinkedComputer) => c.tools.filter((t) => t.loggedIn === true).map((t) => t.name);

  return (
    <div className="set-card computers-set">
      <div className="set-row">
        <div className="set-text">
          <div className="set-label">Your computers</div>
          <div className="muted small">Run coding tools and teammates on your other computers from here, over Wi-Fi or Tailscale. Nothing goes through Friday's servers.</div>
        </div>
        {!link && (
          <button type="button" className="btn small" onClick={() => void add()}>
            Add a computer
          </button>
        )}
      </div>
      {link && (
        <div className="computers-link">
          <ol className="computers-steps small">
            <li>On the other computer, open Friday › Settings › Computer & coding tools.</li>
            <li>Under Your computers, paste this link where it says “Use this computer from another Friday”.</li>
          </ol>
          <div className="computers-link-row">
            <code className="computers-link-text" title={link.link}>
              {link.link}
            </code>
            <button type="button" className="btn small" onClick={() => void navigator.clipboard.writeText(link.link).then(() => setCopied(true), () => {})}>
              {copied ? "Copied" : "Copy link"}
            </button>
            <button type="button" className="link-btn small" onClick={() => setLink(null)}>
              Done
            </button>
          </div>
          <span className="muted small">It works once, for ten minutes, and carries this computer's certificate, which the other one checks.</span>
        </div>
      )}
      {state.computers.length > 0 && (
        <ul className="computers-list" aria-label="Your other computers">
          {state.computers.map((c) => (
            <li key={c.id}>
              <span className={`computers-dot ${c.connected ? "on" : ""}`} aria-hidden />
              <span className="computers-name">{c.name}</span>
              <span className="muted small computers-tools">{c.connected ? tools(c).join(" · ") || "No coding tool signed in" : "Not connected"}</span>
              <button type="button" className="link-btn small" onClick={() => void remove(c.id)} aria-label={`Remove ${c.name}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="computers-join">
        <div className="set-row">
          <div className="set-text">
            <div className="set-label">{hub ? `Used from ${hub.name}` : "Use this computer from another Friday"}</div>
            <div className="muted small">
              {hub ? (
                <span className="computers-status">
                  <span className={`computers-dot ${hub.connected ? "on" : ""}`} aria-hidden />
                  {hub.connected ? `Linked${hub.address ? ` at ${hub.address}` : ""}. Its agents and teammates can run here.` : "Reconnecting…"}
                </span>
              ) : (
                "Let your main computer's Friday run agents and teammates here. Copy the link from Add a computer there, then paste it here."
              )}
            </div>
          </div>
          {hub ? (
            <button type="button" className="btn small" onClick={() => void leave()}>
              Stop
            </button>
          ) : (
            !typing && (
              <button type="button" className="btn small" disabled={busy} onClick={() => void fromClipboard()}>
                {busy ? "Connecting…" : "Paste link"}
              </button>
            )
          )}
        </div>
        {!hub && typing && (
          <div className="computers-paste">
            <input className="input" autoFocus placeholder="friday://computer?…" value={paste} onChange={(e) => setPaste(e.target.value)} onKeyDown={(e) => (e.key === "Enter" && paste.trim() ? void join() : e.key === "Escape" ? setTyping(false) : undefined)} aria-label="Link from the other computer" spellCheck={false} />
            <button type="button" className="btn small primary" disabled={!paste.trim() || busy} onClick={() => void join()}>
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        )}
      </div>
      {(error || state.error || state.joined?.error) && <p className="phone-error small">{error || state.joined?.error || state.error}</p>}
    </div>
  );
}
