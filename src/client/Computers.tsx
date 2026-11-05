import { useEffect, useState } from "react";
import { MenuButton, Picker, relTime, Segmented } from "./ui.js";
import { pickMachine, pickedMachine } from "./local.js";
import { Icon } from "./icons.js";
import { CopyMark } from "./SettingsOutside.js";

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
  /** What tells it apart from another of the same name: its system, and its host name or address (computers.ts computerDetail). */
  detail?: string;
  /** The Friday it runs, as it said when it last linked. */
  version?: string;
  /** Why it can't link, when this computer can tell: only pairing it again fixes it. */
  problem?: string;
}
/** Why this computer can't link to the one it is used from (join.ts JoinProblem). */
interface JoinProblem {
  kind: "certificate" | "refused" | "unreachable" | "removed";
  said: string;
  at: number;
  repair: boolean;
}
interface State {
  computers: LinkedComputer[];
  joined: { hub: { name: string; connected: boolean; address?: string; since?: number; tried?: number; problem?: JoinProblem; version?: string } | null; version?: string; error?: string } | null;
  /** The Friday this computer runs. */
  version?: string;
  error?: string;
}

/** "Friday 0.2.11", or both when they differ: an older one there can't do everything this one asks of it. */
const versions = (there: string | undefined, here: string | undefined) => (!there ? "" : here && here !== there ? `Friday ${there} there, ${here} here` : `Friday ${there}`);

const call = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
  const r = await fetch(path, { credentials: "same-origin", ...init, headers: { "Content-Type": "application/json", "x-friday-local": "1", ...init.headers } });
  const b = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(b.error || "Couldn't reach Friday.");
  return b;
};

/** The computers linked now, as the places a session can run, refreshed while something shows them. */
export function useComputers(every = 8_000): { id: string; label: string; detail?: string }[] & { read?: true } {
  const [list, setList] = useState<{ id: string; label: string; detail?: string }[] & { read?: true }>([]);
  useEffect(() => {
    let gone = false;
    // `read` once the list has come back: an empty one then is "none linked now", not "not asked yet".
    const read = () => void call<{ machines: { id: string; label: string; detail?: string }[] }>("/api/machines").then((r) => !gone && setList(Object.assign(r.machines, { read: true as const })), () => {});
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
  // The one picked went away (removed, or not linked now): back to this computer, rather than every start failing there. Also
  // when it was the only one: the page went on asking its tools of it, a red "Forbidden" in the console every few seconds.
  useEffect(() => {
    if (on && computers.read && !computers.some((c) => c.id === on)) pickMachine("");
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
        ...computers.map((c) => ({ label: c.label, ...(c.detail ? { sub: c.detail } : {}), icon: "server" as const, checked: c.id === on, live: true, onSelect: () => choose(c.id) })),
      ]}
    />
  );
}

/** Settings › Computer & coding tools › Your computers. */
/** How a computer is added (add-computer.ts): over SSH, with one command pasted there, or in its own Friday app. */
type AddHow = "ssh" | "command" | "app";
const ADD_HOW: [AddHow, string][] = [
  ["ssh", "Over SSH"],
  ["command", "A command"],
  ["app", "Its Friday app"],
];

export function ComputersSettings() {
  const [state, setState] = useState<State | null>(null);
  const [link, setLink] = useState<{ link: string; until: number; unix?: string; windows?: string } | null>(null);
  /** Adding one: how, the host typed or picked, the hosts in ~/.ssh/config, and how setting it up went. */
  const [how, setHow] = useState<AddHow | null>(null);
  const [host, setHost] = useState("");
  const [hosts, setHosts] = useState<string[]>([]);
  const [setting, setSetting] = useState<{ busy: boolean; said?: string; ok?: boolean }>({ busy: false });
  const [shell, setShell] = useState<"unix" | "windows">(() => (/Win/.test(navigator.platform) ? "windows" : "unix"));
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
  /** Remove asked of one that has teammates or sessions on it: what runs there, to move or leave (2026-11-04 linking test). */
  const [removing, setRemoving] = useState<{ id: string; name: string; teammates: { id: string; name: string }[]; sessions: number } | null>(null);
  /** One being called something else, and what is typed. */
  const [naming, setNaming] = useState<{ id: string; name: string } | null>(null);
  /** The one that linked while adding was open: the panel says so and offers Done, not Cancel. */
  const [linked, setLinked] = useState("");
  // A computer paired with the link on screen: it has done its work. Linked anew, or one paired again in its old row's place.
  const ids = (state?.computers ?? []).map((c) => c.id).join(" ");
  const [had, setHad] = useState<string | null>(null);
  useEffect(() => {
    if (had !== null && state) {
      const fresh = state.computers.find((c) => !had.split(" ").includes(c.id));
      if (fresh) (setLink(null), how && setLinked(fresh.name));
    }
    setHad(ids);
  }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!link) return;
    const t = setTimeout(() => setLink(null), Math.max(0, link.until - Date.now()));
    return () => clearTimeout(t);
  }, [link]);
  if (!state) return null;

  // A code for the way picked: one command to paste there, or the link its Friday app takes. Over SSH makes its own when it runs.
  const add = async (way: AddHow) => {
    setHow(way);
    setError("");
    setSetting({ busy: false });
    setLink(null);
    setLinked("");
    // Over SSH makes its own code when it runs: one made for another way stops working now.
    if (way === "ssh") void call("/api/computers/code", { method: "DELETE" }).catch(() => {});
    if (way === "ssh") return void call<{ hosts: string[] }>("/api/computers/hosts").then((r) => (setHosts(r.hosts), setHost((h) => h || r.hosts[0] || "")), () => {});
    try {
      const r = await call<{ link?: string; until?: number; unix?: string; windows?: string; error?: string }>(way === "command" ? "/api/computers/add" : "/api/computers/code", { method: "POST", ...(way === "command" ? { body: JSON.stringify({ how: "command" }) } : {}) });
      if (r.error || !r.link) return setError(r.error ?? "Couldn't make a link.");
      setLink({ link: r.link, until: r.until ?? Date.now() + 600_000, ...(r.unix ? { unix: r.unix, windows: r.windows ?? r.unix } : {}) });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const overSsh = async () => {
    setSetting({ busy: true, said: `Setting up ${host}: installing Friday there and starting it. This can take a few minutes.` });
    try {
      const r = await call<{ ok: boolean; how?: string; warn?: string; error?: string; linked?: string }>("/api/computers/add", { method: "POST", body: JSON.stringify({ how: "ssh", host }) });
      // Set up and linked (add-computer.ts waits for it), or why it wasn't: set up but can't reach this one is a failure too.
      const service = r.how === "launchd" || r.how === "systemd" ? " as a service that comes back after a restart" : "";
      setSetting(r.ok ? { busy: false, ok: true, said: `${host} is set up${service} and linked${r.linked ? ` as ${r.linked}` : ""}.${r.warn ? ` ${r.warn}` : ""}` } : { busy: false, ok: false, said: r.error ?? "It didn't finish." });
      read();
    } catch (e) {
      setSetting({ busy: false, ok: false, said: (e as Error).message });
    }
  };
  // Cancel, with nothing set up or handed over: the code made for it stops working, and the way in it opened closes again, phone
  // access untouched (audit REST-1). Done, after a command or an SSH set-up, keeps it: the other computer may still be linking.
  const finished = setting.ok || !!linked || (!!link && how !== "app");
  const done = () => {
    if (!finished && !setting.busy) void call("/api/computers/code", { method: "DELETE" }).catch(() => {});
    setHow(null);
    setLink(null);
    setLinked("");
    setSetting({ busy: false });
  };
  // Removed at once when nothing runs there; otherwise what does is said first, with its teammates offered a move to this one.
  const remove = async (c: LinkedComputer, move?: boolean) => {
    if (move === undefined) {
      const uses = await call<{ teammates: { id: string; name: string }[]; sessions: number }>(`/api/computers/${c.id}/uses`).catch(() => ({ teammates: [], sessions: 0 }));
      if (uses.teammates.length || uses.sessions) return setRemoving({ id: c.id, name: c.name, ...uses });
    }
    setRemoving(null);
    setState(await call<State>(`/api/computers/${c.id}${move ? "?move=teammates" : ""}`, { method: "DELETE" }).catch(() => state));
  };
  const rename = async () => {
    if (!naming) return;
    const name = naming.name.trim();
    setNaming(null);
    if (name) setState(await call<State>(`/api/computers/${naming.id}`, { method: "PATCH", body: JSON.stringify({ name }) }).catch((e: Error) => (setError(e.message), state)));
  };
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
          <div className="muted small">Run coding tools and teammates on your other computers from here, straight to them over Wi-Fi or Tailscale.</div>
        </div>
        {!how && (
          <button type="button" className="btn small" onClick={() => void add("ssh")}>
            Add a computer
          </button>
        )}
      </div>
      {/* Three ways in (add-computer.ts): a machine Friday reaches over SSH is set up from here; any other takes one command, or
          the link in its own Friday app. */}
      {how && (
        <div className="computers-add">
          <div className="computers-add-head">
            <Segmented value={how} options={ADD_HOW} onChange={(w) => void add(w)} className="computers-add-how" />
            <button type="button" className="link-btn small" onClick={done}>
              {finished ? "Done" : "Cancel"}
            </button>
          </div>
          {linked && !setting.said && <p className="small computers-said ok">{linked} is linked. It's in the list below.</p>}
          {how === "ssh" && (
            <div className="computers-add-body">
              <p className="muted small">Friday connects with your own SSH (your ~/.ssh/config, keys and ssh-agent), installs Friday there in a folder of its own, and leaves it running as a service, linked to this computer. A Mac or Linux machine with Node.js 22 and git.</p>
              <div className="computers-add-row">
                {hosts.length > 0 && <Picker className="computers-host-pick" value={hosts.includes(host) ? host : ""} label="A host from your SSH config" placeholder="Your SSH hosts" onChange={(h) => setHost(h)} options={hosts.map((h) => ({ value: h, label: h }))} />}
                <input className="input computers-host" value={host} placeholder="user@machine or an alias" spellCheck={false} aria-label="The machine, as ssh takes it" onChange={(e) => setHost(e.target.value)} onKeyDown={(e) => e.key === "Enter" && host.trim() && !setting.busy && void overSsh()} />
                <button type="button" className="btn small primary" disabled={!host.trim() || setting.busy} onClick={() => void overSsh()}>
                  {setting.busy ? "Setting up…" : "Set it up"}
                </button>
              </div>
              {setting.said && <p className={`small computers-said${setting.ok === false ? " bad" : setting.ok ? " ok" : ""}`}>{setting.said}</p>}
            </div>
          )}
          {how === "command" && link?.unix && (
            <div className="computers-add-body">
              <p className="muted small">Paste this in a terminal on the other machine. It needs Node.js 22, runs Friday there with nothing to open, and stays linked while it runs.</p>
              <div className="computers-link-row">
                <Segmented value={shell} options={[["unix", "Mac or Linux"], ["windows", "Windows"]]} onChange={setShell} className="computers-shell" />
              </div>
              <div className="computers-link-row">
                <code className="computers-link-text" title={shell === "unix" ? link.unix : link.windows}>
                  {shell === "unix" ? link.unix : link.windows}
                </code>
                <CopyMark text={(shell === "unix" ? link.unix : link.windows) ?? ""} label="the command" />
              </div>
              <span className="muted small">Its code works once, for ten minutes. To keep it running after a restart, add it over SSH instead.</span>
            </div>
          )}
        </div>
      )}
      {link && how === "app" && (
        <div className="computers-link">
          <ol className="computers-steps small">
            <li>On the other computer, open Friday › Settings › Computer & coding tools.</li>
            <li>Under Your computers, paste this link where it says “Use this computer from another Friday”.</li>
          </ol>
          <div className="computers-link-row">
            <code className="computers-link-text" title={link.link}>
              {link.link}
            </code>
            <CopyMark text={link.link} label="the link" />
          </div>
          <span className="muted small">It works once, for ten minutes, and carries this computer's certificate, which the other one checks.</span>
        </div>
      )}
      {state.computers.length > 0 && (
        <ul className="computers-list" aria-label="Your other computers">
          {state.computers.map((c) => (
            <li key={c.id}>
              <span className={`computers-dot ${c.connected ? "on" : ""}`} aria-hidden />
              <span className="computers-who">
                {naming?.id === c.id ? (
                  <input className="input computers-rename" autoFocus value={naming.name} maxLength={60} aria-label={`A name for ${c.name}`} onChange={(e) => setNaming({ id: c.id, name: e.target.value })} onBlur={() => void rename()} onKeyDown={(e) => (e.key === "Enter" ? void rename() : e.key === "Escape" ? setNaming(null) : undefined)} />
                ) : (
                  <span className="computers-name" title={c.name}>
                    {c.name}
                  </span>
                )}
                {/* What tells it from another of the same name, and when it was last here (2026-11-04 linking test). */}
                <span className="muted small computers-detail" title={versions(c.version, state.version)}>
                  {[c.detail, c.connected ? "" : c.problem ? "" : `last seen ${relTime(c.seen) === "now" ? "just now" : `${relTime(c.seen)} ago`}`, c.version && c.version !== state.version ? versions(c.version, state.version) : ""].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className={`small computers-tools${c.problem ? " bad" : " muted"}`} title={c.problem ?? ""}>
                {c.connected ? tools(c).join(" · ") || "No coding tool signed in" : (c.problem ?? "Not connected")}
              </span>
              <button type="button" className="link-btn small" onClick={() => setNaming({ id: c.id, name: c.name })} aria-label={`Rename ${c.name}`}>
                Rename
              </button>
              <button type="button" className="link-btn small" onClick={() => void remove(c)} aria-label={`Remove ${c.name}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* What runs there, said before it goes: its teammates moved here, or left offline as its, back if it is added again. */}
      {removing && (
        <div className="computers-remove">
          <p className="small">
            {[removing.teammates.length ? `${removing.teammates.map((t) => t.name).join(", ")} ${removing.teammates.length === 1 ? "works" : "work"} on ${removing.name}` : "", removing.sessions ? `${removing.sessions} ${removing.sessions === 1 ? "session's agent runs" : "sessions' agents run"} there` : ""].filter(Boolean).join(", and ")}
            . {removing.teammates.length ? `Move ${removing.teammates.length === 1 ? "it" : "them"} to this computer, or leave ${removing.teammates.length === 1 ? "it" : "them"} offline until ${removing.name} is added again.` : `They stay offline until ${removing.name} is added again.`}
          </p>
          <div className="computers-remove-row">
            <button type="button" className="link-btn small" onClick={() => setRemoving(null)}>
              Cancel
            </button>
            <button type="button" className="btn small" onClick={() => void remove({ id: removing.id, name: removing.name } as LinkedComputer, false)}>
              {removing.teammates.length ? `Remove, leave ${removing.teammates.length === 1 ? "it" : "them"}` : "Remove"}
            </button>
            {removing.teammates.length > 0 && (
              <button type="button" className="btn small primary" onClick={() => void remove({ id: removing.id, name: removing.name } as LinkedComputer, true)}>
                Move here and remove
              </button>
            )}
          </div>
        </div>
      )}
      <div className="computers-join">
        <div className="set-row">
          <div className="set-text">
            <div className="set-label">{hub ? `Used from ${hub.name}` : "Use this computer from another Friday"}</div>
            <div className="muted small">
              {hub ? (
                <span className="computers-status">
                  <span className={`computers-dot ${hub.connected ? "on" : ""}`} aria-hidden />
                  <span>
                    {hub.connected ? `Linked${hub.address ? ` at ${hub.address}` : ""}${hub.version ? ` · ${versions(hub.version, state.joined?.version)}` : ""}. Its agents and teammates can run here.` : hub.problem ? hub.problem.said : "Reconnecting…"}
                    {/* Why it can't link, and when it last tried: "Reconnecting…" used to say neither, for good (2026-11-04 linking test). */}
                    {!hub.connected && hub.tried ? ` Last tried ${relTime(hub.tried) === "now" ? "just now" : `${relTime(hub.tried)} ago`}.` : ""}
                  </span>
                </span>
              ) : (
                "Let your main computer's Friday run agents and teammates here. Copy the link from Add a computer there, then paste it here."
              )}
            </div>
          </div>
          {hub ? (
            <button type="button" className="btn small" onClick={() => void (hub.problem?.repair ? leave().then(() => setTyping(true)) : leave())}>
              {hub.problem?.repair ? "Pair again" : "Stop"}
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
      {/* Said once: a removal there is already the line under "Used from". */}
      {(error || state.error || (state.joined?.error && state.joined.error !== hub?.problem?.said)) && <p className="phone-error small">{error || (state.joined?.error !== hub?.problem?.said ? state.joined?.error : "") || state.error}</p>}
    </div>
  );
}
