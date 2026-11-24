import { useEffect, useRef, useState, type ReactNode } from "react";
import { Picker, relTime, Segmented } from "./ui.js";
import { CopyMark } from "./SettingsOutside.js";
import { SettingsGroup, SettingsRow } from "@/components/dass";
import { Button } from "@/components/ui/button";
import { call, versions, type LinkedComputer, type State } from "./Computers.js";
import { MachinesMap } from "./MachinesMap.js";
import { NearbyLink } from "./NearbyLink.js";

// Settings › Computer › Your computers, apart from Computers.tsx: the new session's Runs on line and the Crew draw RunsOn and
// useComputers with the first screen, and this page (about 15 KB) only loads with Settings, or when Runs on › Add a computer… opens.

/** Settings › Computer › Your computers. */
/** How a computer is added (add-computer.ts): over SSH, with one command pasted there, or in its own Friday app. */
type AddHow = "nearby" | "ssh" | "command" | "app";
const ADD_HOW: [AddHow, string][] = [
  ["nearby", "Nearby"],
  ["ssh", "SSH"],
  ["command", "Command"],
  ["app", "Link"],
];

export function ComputersSettings({ adding = false, onDone }: { /** Opened from Runs on › Add a computer: only the adding, started at once. */ adding?: boolean; onDone?: () => void } = {}) {
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
  // Opened to add one (RunsOn): straight to its first way, as Settings' Add a computer button does, once the list is read.
  const started = useRef(false);
  const addNow = useRef<(way: AddHow) => void>(() => {});
  useEffect(() => {
    if (!adding || !state || started.current) return;
    started.current = true;
    addNow.current("nearby");
  }, [adding, state]);
  if (!state) return null;

  // A code for the way picked: one command to paste there, or the link its Friday app takes. Over SSH makes its own when it runs.
  const add = async (way: AddHow) => {
    setHow(way);
    setError("");
    setSetting({ busy: false });
    setLink(null);
    setLinked("");
    // Nearby (NearbyLink) makes its code when Link is pressed, as Over SSH does when it runs: one made for another way stops now.
    if (way === "nearby") return void call("/api/computers/code", { method: "DELETE" }).catch(() => {});
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
  addNow.current = (way) => void add(way);
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
    onDone?.();
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

  return (
    // One group of Settings › Computer: your others, and this one used from another's (Arun, 2026-11-04: "design this better").
    <Group adding={adding}>
      {!adding && (
        <SettingsRow label="Your computers" hint="Run agents on your other computers over Wi-Fi or Tailscale.">
          {!how && (
            <Button type="button" variant="outline" size="sm" onClick={() => void add("nearby")}>
              Add a computer
            </Button>
          )}
        </SettingsRow>
      )}
      {/* The map of them: what each has now and how it links to this one (spec 09 step 1). */}
      {!adding && !how && <MachinesMap state={state} />}
      {/* Three ways in (add-computer.ts): a machine Friday reaches over SSH is set up from here; any other takes one command, or
          the link in its own Friday app. */}
      {how && (
        <div className="computers-add">
          <div className="computers-add-head">
            <Segmented value={how} options={ADD_HOW} onChange={(w) => void add(w)} className="computers-add-how" />
            {/* In the dialog its close button is the way out (Computers.tsx AddComputer); in Settings, this. */}
            {!adding && (
              <button type="button" className="link-btn small" onClick={done}>
                {finished ? "Done" : "Cancel"}
              </button>
            )}
          </div>
          {linked && !setting.said && <p className="small computers-said ok">{linked} is linked. It's in the list below.</p>}
          {how === "nearby" && <NearbyLink />}
          {how === "ssh" && (
            <div className="computers-add-body">
              <p className="muted small">For an always-on Mac or Linux machine. Friday signs in with your own SSH, installs itself there and keeps running as a service. It needs Node.js 22 and git.</p>
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
              <p className="muted small">Paste this in a terminal on the other machine. It runs Friday there with nothing to open, and stays linked while it runs. It needs Node.js 22.</p>
              <div className="computers-link-row">
                <Segmented value={shell} options={[["unix", "Mac or Linux"], ["windows", "Windows"]]} onChange={setShell} className="computers-shell" />
              </div>
              <div className="computers-link-row">
                <code className="computers-link-text" title={shell === "unix" ? link.unix : link.windows}>
                  {shell === "unix" ? link.unix : link.windows}
                </code>
                <CopyMark text={(shell === "unix" ? link.unix : link.windows) ?? ""} label="the command" />
              </div>
              <span className="muted small computers-foot">Works once, for ten minutes. To keep it after a restart, use SSH.</span>
            </div>
          )}
          {how === "app" && link && (
            <div className="computers-add-body">
              <p className="muted small">On the other computer, open Friday › Settings › Other computers, and paste this under “Use this computer from another Friday”.</p>
              <div className="computers-link-row">
                <code className="computers-link-text" title={link.link}>
                  {link.link}
                </code>
                <CopyMark text={link.link} label="the link" />
              </div>
              <span className="muted small computers-foot">Works once, for ten minutes. It carries this computer's certificate, which the other one checks.</span>
            </div>
          )}
        </div>
      )}
      {!adding && state.computers.length > 0 && (
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
              {/* Its coding tools are on the map above; only what stops it is said here. */}
              <span className={`small computers-tools${c.problem ? " bad" : " muted"}`} title={c.problem ?? ""}>
                {c.connected ? "" : (c.problem ?? "Not connected")}
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
      {!adding && <div className="computers-join">
        <SettingsRow
          label={hub ? `Used from ${hub.name}` : "Use this computer from another Friday"}
          hint={
              hub ? (
                <span className="computers-status">
                  <span className={`computers-dot ${hub.connected ? "on" : ""}`} aria-hidden />
                  <span>
                    {hub.connected ? `Linked${hub.address ? ` at ${hub.address}` : ""}${hub.version ? ` · ${versions(hub.version, state.joined?.version)}` : ""}. Its agents can run here.` : hub.problem ? hub.problem.said : "Reconnecting…"}
                    {/* Why it can't link, and when it last tried: "Reconnecting…" used to say neither, for good (2026-11-04 linking test). */}
                    {!hub.connected && hub.tried ? ` Last tried ${relTime(hub.tried) === "now" ? "just now" : `${relTime(hub.tried)} ago`}.` : ""}
                  </span>
                </span>
              ) : (
                "Paste the link from Add a computer on your main computer."
              )
          }
        >
          {hub ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void (hub.problem?.repair ? leave().then(() => setTyping(true)) : leave())}>
              {hub.problem?.repair ? "Pair again" : "Stop"}
            </Button>
          ) : (
            !typing && (
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void fromClipboard()}>
                {busy ? "Connecting…" : "Paste link"}
              </Button>
            )
          )}
        </SettingsRow>
        {!hub && typing && (
          <div className="computers-paste">
            <input className="input" autoFocus placeholder="friday://computer?…" value={paste} onChange={(e) => setPaste(e.target.value)} onKeyDown={(e) => (e.key === "Enter" && paste.trim() ? void join() : e.key === "Escape" ? setTyping(false) : undefined)} aria-label="Link from the other computer" spellCheck={false} />
            <button type="button" className="btn small primary" disabled={!paste.trim() || busy} onClick={() => void join()}>
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        )}
      </div>}
      {/* Said once: a removal there is already the line under "Used from". */}
      {(error || state.error || (state.joined?.error && state.joined.error !== hub?.problem?.said)) && <p className="phone-error small">{error || (state.joined?.error !== hub?.problem?.said ? state.joined?.error : "") || state.error}</p>}
    </Group>
  );
}

/** Settings' group, or, adding from Runs on, just its contents inside the dialog that has its own title. */
function Group({ adding, children }: { adding: boolean; children: ReactNode }) {
  return adding ? <div className="computers-set computers-adding">{children}</div> : <SettingsGroup title="Other computers" className="computers-set">{children}</SettingsGroup>;
}
