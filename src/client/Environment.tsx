import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { SessionState } from "../session/projection.js";
import type { EnvironmentInfo, ToolVersion } from "../runner/environment.js";
import { MAIN_LANE } from "../types.js";
import { Icon } from "./icons.js";
import { connectThisComputer, hostApi } from "./local.js";
import { isLocal } from "./edition.js";
import { openSettings } from "./openSettings.js";
import { localServers, useBackgroundTasks, useLocalServers, usePreviewInfo } from "./Preview.js";
import { openInPreview } from "./previewBus.js";
import type { Identity } from "./storage.js";
import { Switch } from "./ui.js";
import { placeCard, useDismiss } from "./ui.js";

/**
 * The session's environment, at the end of its status bar where Commands was (Arun, 2026-10-18; the command palette is still
 * ⌘⇧P): the computer the agents work on, as a name and a dot, and a panel of what it is, in plain words and short (Arun,
 * 2026-10-19: "confusing and so much jargon"): what is running, each server by its address with a stop; the project's tools
 * as chips (one missing, or not the version the project asks for, marked); the install step to run once or each time an
 * agent starts; and the secrets handed to everything the agents run. Its system is in the title's tooltip. As Codex, Cursor and Claude Code show a cloud environment, for a folder on somebody's own computer: whoever's machine
 * it is can change it; everyone else in the session sees it, never a variable's value (runner/environment.ts).
 */

type Answer = { environment?: EnvironmentInfo; error?: string };

/** A folder as it reads at a glance: home as ~, and a long path kept to its start and its last two folders. */
function shortPath(p: string): string {
  const home = p.replace(/^\/Users\/[^/]+|^\/home\/[^/]+|^C:\\Users\\[^\\]+/i, "~");
  const parts = home.split(/[\\/]/);
  return home.length <= 44 || parts.length <= 4 ? home : `${parts.slice(0, 2).join("/")}/…/${parts.slice(-2).join("/")}`;
}

/** Major versions, for "the project asks for Node 20 and this has 22". */
const major = (v: string | null | undefined) => (v ? v.replace(/^[^\d]*/, "").split(".")[0] : "");
const mismatch = (t: ToolVersion) => !!t.wants && !!t.version && /^\D*\d/.test(t.wants) && !/[x*^~<>=|]/.test(t.wants.replace(/^v/, "")) && major(t.wants) !== major(t.version);

export function EnvironmentButton({ state, me, sid, invite, identity, onOpen }: { state: SessionState; me: string; sid: string; invite: string; identity: Identity; /** Opens a panel: Tasks, where the setup command's output is read, or the Preview. */ onOpen: (tab: "overview" | "preview") => void }) {
  const lane = state.engines[MAIN_LANE] ? MAIN_LANE : (Object.keys(state.engines)[0] ?? MAIN_LANE);
  const engine = state.engines[lane];
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const online = !!engine?.online;
  const name = engine?.hostName ? (engine.hostId === me ? "Your computer" : `${engine.hostName.split(/\s+/)[0]}'s computer`) : state.upload ? "Uploaded folder" : "No computer";
  const title = engine ? `${online ? "Connected" : "Offline"}: where this session's agents work. Open the environment` : state.upload ? "This session works in a folder uploaded to Friday" : "No computer is connected to this session";
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`stb-item stb-env ${open ? "on" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Environment: ${name}${engine ? (online ? ", connected" : ", offline") : ""}`}
      >
        <i className={`stb-env-dot ${engine ? (online ? "on" : "off") : "none"}`} aria-hidden="true" />
        <Icon name="server" size={13} />
        <span className="stb-env-label">Environment</span>
      </button>
      {open && <Panel anchor={btn} close={() => setOpen(false)} {...{ state, me, sid, invite, identity, lane, onOpen }} />}
    </>
  );
}

function Panel({ anchor, close, state, me, sid, invite, identity, lane, onOpen }: { anchor: RefObject<HTMLButtonElement | null>; close: () => void; state: SessionState; me: string; sid: string; invite: string; identity: Identity; lane: string; onOpen: (tab: "overview" | "preview") => void }) {
  const pop = useRef<HTMLDivElement>(null);
  useDismiss(pop, close, anchor.current);
  const engine = state.engines[lane];
  // Whoever's computer it is can change what it keeps; everyone else reads it.
  const mine = !!engine && engine.hostId === me && !!engine.cwd;
  const cwd = mine ? engine.cwd : null;
  const [info, setInfo] = useState<EnvironmentInfo | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");
  const [setup, setSetup] = useState("");
  const [auto, setAuto] = useState(false);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [busy, setBusy] = useState("");
  /** Its setup, tools and secrets, folded under one line as Claude's card keeps to the computer, the folder and the branch. */
  const [more, setMore] = useState(false);
  const preview = usePreviewInfo(identity, cwd, null, 5000);
  const { tasks, stop } = useBackgroundTasks(identity, cwd, 5000);
  // Every web server for this project the computer says is listening, whoever started it (runner/ports.ts).
  const found = useLocalServers(identity, cwd, 5000);

  const look = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/repo?op=environment&lane=${encodeURIComponent(lane)}&invite=${encodeURIComponent(invite)}`, { credentials: "same-origin" }).then((x) => x.json() as Promise<{ output?: string; error?: string }>);
      // A Friday app from before Environment answers in words, not JSON: its computer can't say yet.
      let a: Answer;
      try {
        a = r.output ? (JSON.parse(r.output) as Answer) : { error: r.error };
      } catch {
        a = { error: /Unknown request/i.test(r.output ?? "") ? "Update the Friday app on that computer to see its environment here." : (r.output ?? "The computer didn't answer.").slice(0, 200) };
      }
      if (a.environment) {
        setInfo(a.environment);
        setSetup(a.environment.saved.setup);
        setAuto(a.environment.saved.autoSetup);
        setErr("");
      } else setErr(a.error ?? "The computer didn't answer.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (engine) void look();
    else setLoading(false);
  }, [lane, engine?.hostId]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (change: { setup?: string; autoSetup?: boolean; vars?: Record<string, string | null> }, said: string) => {
    if (!cwd) return;
    setBusy("save");
    setNote("");
    try {
      const r = await hostApi<{ saved: EnvironmentInfo["saved"] }>(identity, "/api/runner/env.save", { method: "POST", body: JSON.stringify({ cwd, ...change }) });
      setInfo((i) => (i ? { ...i, saved: r.saved } : i));
      setNote(said);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  // The whole set goes back each time, the ones not changed as null: the page never holds a value.
  const varsWith = (edit: (v: Record<string, string | null>) => void) => {
    const v: Record<string, string | null> = Object.fromEntries((info?.saved.vars ?? []).map((k) => [k, null]));
    edit(v);
    return v;
  };
  const addVar = async () => {
    const k = newName.trim();
    if (!k || !newValue) return;
    await save({ vars: varsWith((v) => (v[k] = newValue)) }, `${k} saved. Commands started from now on have it.`);
    setNewName("");
    setNewValue("");
  };
  const removeVar = (k: string) => save({ vars: varsWith((v) => delete v[k]) }, `${k} removed.`);
  const runSetup = async () => {
    if (!cwd) return;
    setBusy("setup");
    setNote("");
    try {
      if (setup.trim() !== (info?.saved.setup ?? "")) await hostApi(identity, "/api/runner/env.save", { method: "POST", body: JSON.stringify({ cwd, setup }) });
      await hostApi(identity, "/api/runner/env.setup", { method: "POST", body: JSON.stringify({ cwd }) });
      setNote("Setup is running. Its output is in Tasks.");
      onOpen("overview");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const r = anchor.current?.getBoundingClientRect();
  if (!r) return null;
  const place = placeCard(r, more ? 380 : 300, { want: more ? 520 : 240, min: 160, prefer: "above" });
  const m = info?.machine;
  const changed = setup.trim() !== (info?.saved.setup ?? "");
  const whose = engine ? (engine.hostId === me ? "Your computer" : `${engine.hostName.split(/\s+/)[0]}'s computer`) : "";
  // What runs here: each server by its address (the preview's, one a task printed, one found listening), then the other
  // commands Friday runs in the background by what they run. A server opens in Preview; anything running can be stopped.
  const servers = localServers(preview, tasks, found.filter((f) => f.here));
  const serving = new Set(servers.map((x) => x.command));
  const stopServer = async (x: (typeof servers)[number]) => {
    setNote("");
    try {
      if (x.preview && cwd) await hostApi(identity, "/api/runner/preview.stop", { method: "POST", body: JSON.stringify({ cwd }) });
      else if (x.stop && "task" in x.stop) await stop(x.stop.task);
      else if (x.stop && "port" in x.stop && cwd) {
        const a = await hostApi<{ stopped: boolean; error?: string }>(identity, "/api/runner/servers.stop", { method: "POST", body: JSON.stringify({ cwd, port: x.stop.port }) });
        if (!a.stopped) setNote(a.error ?? "Couldn't stop it.");
      }
    } catch (e) {
      setNote(/not found|unknown|404/i.test((e as Error).message) ? "Update Friday to stop servers from here." : (e as Error).message);
    }
  };
  const others = tasks.filter((t) => !(t.running && serving.has(t.command)));
  const toolsOff = info?.tools.filter((t) => !t.version || mismatch(t)).length ?? 0;
  const specs = m ? `${m.name} · ${m.os} · ${m.memoryGb} GB memory · ${m.cpus} cores. Commands run on it directly, with its network.` : "";

  // The folder as Claude's environment card says it (Arun, 2026-10-23: "i want our environment pop over to be like claudes"):
  // its name, then where it is.
  const folder = info?.folder ?? engine?.cwd ?? "";
  const folderName = folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
  const where = shortPath(folder.slice(0, Math.max(0, folder.length - folderName.length)).replace(/[\\/]+$/, "") || "/");
  const machine = engine ? (engine.hostId === me ? "This computer" : `${engine.hostName.split(/\s+/)[0]}'s computer`) : state.upload ? "Uploaded folder" : "No computer";

  return createPortal(
    <div ref={pop} className={`env-pop env-compact ${more ? "more" : ""}`} style={{ ...place, maxHeight: place.maxHeight }} role="dialog" aria-label="Environment">
      <div className="env-c-head">
        <span>Environment</span>
        <span className="env-head-acts">
          {engine && (
            <button type="button" className="icon-btn tiny" title="Check again" aria-label="Check again" onClick={() => void look()} disabled={loading}>
              <Icon name="refresh" size={13} />
            </button>
          )}
          <button type="button" className="icon-btn tiny" title="Close" aria-label="Close" onClick={close}>
            <Icon name="x" size={13} />
          </button>
        </span>
      </div>
      <ul className="env-c-rows">
        <li {...(specs ? { title: specs } : {})}>
          <Icon name="server" size={14} />
          <span className="env-c-main">{machine}</span>
          {engine && !engine.online && <span className="env-c-side env-c-warn">Offline</span>}
        </li>
        {engine && folder && (
          <li title={folder}>
            <Icon name="folder" size={14} />
            <span className="env-c-main">{folderName}</span>
            <span className="env-c-sub">· {where}</span>
          </li>
        )}
        {engine?.branch && (
          <li title={engine.branch}>
            <Icon name="gitBranch" size={14} />
            <span className="env-c-main env-mono">{engine.branch}</span>
          </li>
        )}
        {!engine && (
          <li className="env-c-empty">
            {state.upload ? "This session works on a folder uploaded to Friday. Connect a computer to run a dev server or your own tools." : isLocal() && !window.fridayDesktop ? "No agent has started on this computer yet." : "No computer is connected yet. Connect one and the agents work on it."}{" "}
            {/* Nothing answers "Connect this computer" in the local edition's browser (2026-10-28 QA). */}
            {(window.fridayDesktop || !isLocal()) && (
              <button type="button" className="link-btn" onClick={() => (window.fridayDesktop ? openSettings("computer") : connectThisComputer())}>
                {window.fridayDesktop ? "Open Computer & coding tools" : "Connect this computer"}
              </button>
            )}
          </li>
        )}
        {/* What is running here, a line each: a server opens in Preview, and anything running can be stopped. */}
        {mine &&
          servers.map((x) => {
            const addr = x.url.replace(/^https?:\/\//, "");
            return (
              <li key={x.url}>
                <i className={`stb-env-dot ${x.ready ? "on" : "none"}`} aria-hidden="true" />
                <button type="button" className="env-c-main env-c-link env-mono" title={`${x.command}. Open in Preview`} onClick={() => (onOpen("preview"), openInPreview(x.url, sid), close())}>
                  {addr}
                </button>
                {(x.preview || x.stop) && (
                  <button type="button" className="env-run-stop" title={`Stop ${addr}`} aria-label={`Stop ${addr}`} onClick={() => void stopServer(x)}>
                    <Icon name="stop" size={11} />
                  </button>
                )}
              </li>
            );
          })}
        {mine &&
          others
            .filter((t) => t.running)
            .map((t) => (
              <li key={t.id} title={t.command}>
                <i className="stb-env-dot on" aria-hidden="true" />
                <span className="env-c-main env-mono">{t.command}</span>
                <button type="button" className="env-run-stop" title="Stop it" aria-label={`Stop ${t.command}`} onClick={() => void stop(t.id)}>
                  <Icon name="stop" size={11} />
                </button>
              </li>
            ))}
      </ul>
      {engine && (
        <button type="button" className="env-c-more" aria-expanded={more} onClick={() => setMore((v) => !v)}>
          <Icon name="settings" size={13} />
          <span>Setup and secrets</span>
          {toolsOff > 0 && <span className="env-h-warn">{toolsOff === 1 ? "1 tool to check" : `${toolsOff} tools to check`}</span>}
          <Icon name={more ? "chevronDown" : "chevronRight"} size={13} />
        </button>
      )}
      {engine && more && (
        <div className="env-body">
          {loading && !info && (
            <p className="env-empty">
              <span className="spinner tiny" /> Checking {whose.toLowerCase()}…
            </p>
          )}
          {err && !info && <p className="env-empty error small">{err}</p>}
            {info && (
              <>
                {info.tools.length > 0 && (
                  <section>
                    <h4>
                      <Icon name="box" size={12} /> Tools{toolsOff ? <span className="env-h-warn">{toolsOff === 1 ? "1 needs a look" : `${toolsOff} need a look`}</span> : null}
                    </h4>
                    <ul className="env-tools">
                      {info.tools.map((t) => (
                        <li key={t.name} className={!t.version ? "missing" : mismatch(t) ? "warn" : ""} title={!t.version ? `${t.name} isn't installed on this computer` : mismatch(t) ? `The project asks for ${t.wants}; this computer has ${t.version}` : `${t.name} ${t.version}`}>
                          <span>{t.name}</span>
                          <b>{t.version ? major(t.version) || t.version : "missing"}</b>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {(mine || info.saved.setup) && (
                  <section>
                    <h4>
                      <Icon name="terminal" size={12} /> Install step
                    </h4>
                    {mine ? (
                      <>
                        <div className="env-setup env-field">
                          <span className="env-prompt" aria-hidden="true">$</span>
                          <input
                            className="env-input env-mono"
                            value={setup}
                            onChange={(e) => setSetup(e.target.value)}
                            placeholder={info.tools.some((t) => t.name === "pnpm") ? "pnpm install" : info.tools.some((t) => t.name === "Python") ? "pip install -r requirements.txt" : "npm install"}
                            aria-label="Install command"
                            spellCheck={false}
                            onKeyDown={(e) => e.key === "Enter" && changed && void save({ setup }, "Saved.")}
                          />
                          {changed && (
                            <button type="button" className="btn small" onClick={() => void save({ setup }, "Saved.")} disabled={busy === "save"}>
                              Save
                            </button>
                          )}
                          <button type="button" className="btn small" title="Run it now" onClick={() => void runSetup()} disabled={!setup.trim() || busy === "setup"}>
                            <Icon name="play" size={11} /> Run
                          </button>
                        </div>
                        <div className="env-check">
                          <span>
                            Run before every agent starts
                            <small>So each agent begins with what the project needs installed.</small>
                          </span>
                          <Switch on={auto} label="Run before every agent starts" disabled={!setup.trim() && !info.saved.setup} onChange={(v) => (setAuto(v), void save({ setup, autoSetup: v }, v ? "It runs each time an agent starts." : "It runs only when you press Run."))} />
                        </div>
                      </>
                    ) : (
                      <p className="env-line env-mono">{info.saved.setup}</p>
                    )}
                  </section>
                )}

                {(mine || info.saved.vars.length > 0) && (
                  <section>
                    <h4>
                      <Icon name="key" size={12} /> Secrets
                    </h4>
                    {info.saved.vars.length > 0 && (
                      <ul className="env-vars">
                        {info.saved.vars.map((k) => (
                          <li key={k}>
                            <code>{k}</code>
                            <span className="env-hidden" aria-label="Value hidden">••••••</span>
                            {mine && (
                              <button type="button" className="icon-btn tiny" title={`Remove ${k}`} aria-label={`Remove ${k}`} onClick={() => void removeVar(k)} disabled={busy === "save"}>
                                <Icon name="trash" size={12} />
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {mine && (
                      <form
                        className="env-add"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void addVar();
                        }}
                      >
                        <input className="env-input env-mono" value={newName} onChange={(e) => setNewName(e.target.value.replace(/[^A-Za-z0-9_]/g, "").toUpperCase())} placeholder="API_KEY" aria-label="Name" spellCheck={false} />
                        <input className="env-input env-mono" type="password" value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder="Value" aria-label="Value" autoComplete="off" />
                        <button type="submit" className="btn small" aria-label="Add" title="Add" disabled={!newName.trim() || !newValue || busy === "save"}>
                          <Icon name="plus" size={12} />
                        </button>
                      </form>
                    )}
                    <p className="env-line env-quiet env-small env-safe">
                      <Icon name="key" size={11} /> They stay on {engine.hostId === me ? "this computer" : whose.toLowerCase()} and are never sent to Friday.
                      {info.envFiles.length > 0 && ` Also read from ${info.envFiles.map((f) => f.file).join(", ")}.`}
                    </p>
                  </section>
                )}
              </>
            )}
        </div>
      )}
      {note && (
        <p className="env-note" role="status">
          {note}
        </p>
      )}
    </div>,
    document.body,
  );
}
