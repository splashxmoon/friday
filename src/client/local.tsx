import { useCallback, useEffect, useRef, useState } from "react";
import type { MachineInfo } from "../runner/local-api.js";
import { ENGINE_NAMES, type EngineTool } from "../types.js";
import { api } from "./api.js";
import { openOutside } from "./openOutside.js";
import type { Identity } from "./storage.js";

/**
 * The machine a coding agent runs on.
 *
 * Either Friday is running on it — the desktop app, or localhost in a browser —
 * or the desktop app on it linked it to a hosted Friday. Both answer the
 * same questions through the same API, so everything above this file is written
 * once: "ask my machine".
 */

export interface LocalTool {
  tool: EngineTool;
  name: string;
  path: string | null;
  /** null when the CLI can't say. */
  loggedIn: boolean | null;
  /** "claude-app": the Claude Code bundled inside the Claude desktop app. */
  source: "cli" | "claude-app" | null;
  /** The app is installed but the command-line agent Friday drives is not. */
  app?: boolean;
  /** Installed, but it can't run on this computer, and why (Kilo's ACP on Windows). */
  unavailable?: string;
  /** Its accounts on that computer, when it has more than one (Claude Code, Codex: runner/accounts.ts). */
  accounts?: { id: string; label: string; loggedIn: boolean | null; out?: boolean; outUntil?: number | null }[];
}

export interface LinkStatus {
  linked: boolean;
  connected: boolean;
  machine?: MachineInfo;
  tools?: LocalTool[];
  since?: number;
}

export type MachineMode = "checking" | "local" | "linked" | "none";

export interface MachineState {
  mode: MachineMode;
  tools: LocalTool[];
  home: string;
  machine?: MachineInfo;
  /** A machine linked from this browser, whether or not it's the one in use. */
  link?: { connected: boolean; machine?: MachineInfo };
  /** Friday is running on this computer, so it could be used instead. */
  hereAvailable?: boolean;
}

const LINK_KEY = "mpa.link";
const PREFER_KEY = "mpa.machine";

export function linkToken(): string {
  try {
    return localStorage.getItem(LINK_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setLinkToken(token: string): void {
  noMachine = null;
  try {
    if (token) localStorage.setItem(LINK_KEY, token);
    else localStorage.removeItem(LINK_KEY);
  } catch {
    // Private mode: the link just won't be remembered between visits.
  }
}

/** Which machine to use when both this one and a linked one are available. */
export function machinePref(): "local" | "link" {
  try {
    return localStorage.getItem(PREFER_KEY) === "link" ? "link" : "local";
  } catch {
    return "local";
  }
}

export function setMachinePref(p: "local" | "link"): void {
  try {
    localStorage.setItem(PREFER_KEY, p);
  } catch {
    // Not remembering the choice is survivable; the default is this computer.
  }
}

/**
 * Calls the computer API. The headers say which machine to use: this one (only
 * honoured when the server really is yours), the linked one holding that token,
 * and which to prefer when both are possible. The custom header also forces a
 * CORS preflight the server never answers, which keeps other websites out.
 */
const ON_MACHINE_KEY = "mpa.onMachine";

/** Which of this person's always-on machines this browser works on, by id; "" for this computer (or the linked one). */
export function pickedMachine(): string {
  try {
    return localStorage.getItem(ON_MACHINE_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Work on one of your always-on machines from now on in this browser, or "" to come back to this computer. */
export function pickMachine(id: string): void {
  try {
    if (id) localStorage.setItem(ON_MACHINE_KEY, id);
    else localStorage.removeItem(ON_MACHINE_KEY);
  } catch {
    // Not remembered between visits; this visit still uses it.
  }
  shared = null;
  noMachine = null;
  window.dispatchEvent(new Event("friday:machine"));
}

/** The headers that say which machine a request is for: an always-on machine picked by id, this one, or the linked one. */
export const hostHeaders = (): Record<string, string> => {
  const token = linkToken();
  const on = pickedMachine();
  return { "x-friday-local": "1", "x-friday-prefer": machinePref(), ...(token ? { "x-friday-link": token } : {}), ...(on ? { "x-friday-machine": on } : {}) };
};

/**
 * The server said this account has no machine (the last look's 200 { linked: false }). Until a look says otherwise, or a
 * link or machine changes, calls that need a machine are not sent: each one would only come back refused, and those
 * refusals buried real permission failures in the server's numbers.
 */
let noMachine: { id: string } | null = null;

export const hostApi = <T,>(identity: Identity, path: string, init: RequestInit = {}) => {
  if (noMachine?.id === identity.id && path.startsWith("/api/runner/")) {
    return Promise.reject(Object.assign(new Error("No machine is connected."), { name: "NoMachine" })) as Promise<T>;
  }
  return api<T>(identity, path, {
    ...init,
    headers: { ...hostHeaders(), ...init.headers },
  });
};

export const linkApi = <T,>(identity: Identity, path: string, init: RequestInit = {}) => {
  const token = linkToken();
  return api<T>(identity, path, { ...init, headers: { ...(token ? { "x-friday-link": token } : {}), ...init.headers } });
};

/**
 * Link this computer to the Friday the window is showing.
 *
 * Written once because it was written twice: the page does it on load and the
 * badge does it on a press, and the two drifted — one adopted the link the app
 * was already running, the other made a second one nothing would answer on.
 *
 * Only desktop-link.ts calls it (linkNow), so every way the page links this computer obeys signing out's hold.
 *
 * The order matters. What the app is already running wins, because its runner
 * is connected with that token; then what this browser remembers, if the
 * server still knows it; and only then a new one.
 */
export async function linkThisComputer(identity: Identity, onToken?: (token: string) => void): Promise<void> {
  const link = window.fridayDesktop?.link;
  if (!link) throw new Error("This only works in the Friday desktop app.");

  let token = (await window.fridayDesktop?.linkedToken?.(location.origin).catch(() => "")) || "";
  if (token && token !== linkToken()) setLinkToken(token);
  if (!token) token = linkToken();
  if (token) {
    const s = await linkApi<{ linked: boolean; mine?: boolean }>(identity, "/api/link/status", { signal: deadline(LINK_MS) }).catch(() => null);
    // Another account's link (a second login on this computer) drives nothing for this one: a new link, not that one again.
    // Only when the server says so: a status call that failed or timed out (the server restarting, a slow network) says
    // nothing about the token, and making a new one restarted the runner and every coding tool running on this computer.
    if (s && (!s.linked || s.mine === false)) token = "";
  }
  if (!token) {
    const r = await api<{ token: string }>(identity, "/api/link/new", { method: "POST", body: "{}" });
    token = r.token;
    setLinkToken(token);
  }
  // Said before it is handed over: signing out forgets every token an attempt got this far with, even one a later attempt
  // has since replaced in this browser's memory.
  onToken?.(token);
  const r = await link({ server: location.origin, token });
  if (!r.ok) throw new Error(r.error ?? "This computer couldn't be connected.");
}

/**
 * Asking about a machine has to end.
 *
 * These calls go to a server that is itself waiting on somebody's computer,
 * and a computer that is asleep, gone or busy never answers. Without a
 * deadline the promise simply never settles, and the UI waiting on it says
 * "looking for your computer" for the rest of the session. A machine that
 * cannot answer in a few seconds is, for the purpose of the next click,
 * absent — and saying so is what lets someone press Connect.
 */
export const TOOLS_MS = 7000;
const LINK_MS = 5000;
export const deadline = (ms: number): AbortSignal | undefined => {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    // An older engine without it: no deadline is still better than no call.
    return undefined;
  }
};

/**
 * What this account last found, so it is not found again from nothing.
 *
 * A machine that was connected a minute ago is almost certainly connected
 * now, and starting from "looking for your computer" every time the page
 * loads makes a stable thing look precarious. So the last good answer is kept
 * and shown at once, and the real check runs behind it and corrects it. Per
 * account, because whose machine it is is part of the answer.
 */
const CACHE_KEY = (id: string) => `mpa.machine.${id}${pickedMachine() ? `.${pickedMachine()}` : ""}`;

function remembered(id: string): MachineState | null {
  try {
    const raw = id ? localStorage.getItem(CACHE_KEY(id)) : null;
    if (!raw) return null;
    const v = JSON.parse(raw) as MachineState & { at?: number };
    // A week is long enough that a machine retired in the meantime is not
    // still being claimed, and short enough to cover any normal absence.
    if (!v.at || Date.now() - v.at > 7 * 24 * 60 * 60_000) return null;
    return { mode: v.mode, tools: v.tools ?? [], home: v.home ?? "", machine: v.machine, hereAvailable: v.hereAvailable };
  } catch {
    return null;
  }
}

/** Which coding tools this account's computer last said it has, for a list that only needs to know which to show first; null when not known. */
export function installedOn(identity: Identity): ((t: EngineTool) => boolean) | null {
  const m = remembered(identity.id);
  if (!m || !m.tools.length) return null;
  return (t) => m.tools.some((x) => x.tool === t && !!x.path);
}

function remember(id: string, state: MachineState | null): void {
  try {
    if (!id) return;
    if (!state) return localStorage.removeItem(CACHE_KEY(id));
    localStorage.setItem(CACHE_KEY(id), JSON.stringify({ ...state, link: undefined, at: Date.now() }));
  } catch {
    // Private mode, or a full store: the check still runs, it just starts cold.
  }
}

type ToolsAnswer = { tools: LocalTool[]; home: string; machine?: MachineInfo; where?: "local" | "linked" };
/** One look at the computer: what answered, the link, and (for a linked one) whether this computer could also run things. */
type Probe = { answer: ToolsAnswer | null; link: LinkStatus | null; here: Promise<boolean> | null };

/** Why the server last refused this computer, in its words, when it said why. */
let lastRefusal = "";
export const machineRefusal = () => lastRefusal;

/** One look at the computer, exported for tests; the page goes through useMachine. */
export async function probe(identity: Identity): Promise<Probe> {
  // The server decides which machine answers and says which one it was, so
  // the UI can never name a different machine from the one doing the work.
  // A machine on an older version, or a reply that isn't the list, can leave `tools` out: that is no tools, not a blank app.
  let timedOut = false;
  noMachine = null;
  const ask = () =>
    hostApi<ToolsAnswer & { linked?: false }>(identity, "/api/runner/tools", { signal: deadline(TOOLS_MS) })
      .then((a) => {
        lastRefusal = "";
        if (a?.linked === false) return (noMachine = { id: identity.id }), null;
        return a ? { ...a, tools: Array.isArray(a.tools) ? a.tools : [] } : null;
      })
      .catch((e: Error) => {
        timedOut ||= e.name === "TimeoutError" || e.name === "AbortError";
        // The server's own reason, kept for a Connect that would otherwise only say the computer didn't answer.
        lastRefusal = /another account|Sign in/i.test(e.message) ? e.message : "";
        return null;
      });
  let [answer, link] = await Promise.all([
    ask(),
    linkToken() ? linkApi<LinkStatus>(identity, "/api/link/status", { signal: deadline(LINK_MS) }).catch(() => null) : Promise.resolve(null),
  ]);
  // Nothing answered, but the app itself is holding a link: this browser's
  // token is a stale one from a previous launch, and the server rightly
  // refuses it. Adopting the app's own token is the difference between a
  // badge that says "not connected" beside a connected machine — forever,
  // since nothing else ever replaces that token — and one that corrects
  // itself on the next look.
  if (!answer) {
    const mine = (await window.fridayDesktop?.linkedToken?.(location.origin).catch(() => "")) || "";
    if (mine && mine !== linkToken()) {
      setLinkToken(mine);
      [answer, link] = await Promise.all([ask(), linkApi<LinkStatus>(identity, "/api/link/status", { signal: deadline(LINK_MS) }).catch(() => null)]);
    }
  }
  // Slow, not absent: a server just started, or a computer just woken, can take longer than the deadline to answer the first
  // time. Read as "not connected", nothing looked again until the window was focused much later. Once more, then it stands.
  if (!answer && timedOut) answer = await ask();
  // Whether *this* machine is also an option matters when switching, not when finding out if anything works, so it is
  // asked alongside and waited for separately.
  const here =
    answer && answer.where === "linked"
      ? api<{ linked?: false }>(identity, "/api/runner/tools", { headers: { "x-friday-local": "1" }, signal: deadline(TOOLS_MS) }).then(
          (a) => a?.linked !== false,
          () => false,
        )
      : null;
  return { answer, link, here };
}

/**
 * The last look, shared by every part of the page that asks.
 *
 * A dozen places show the computer, and each one mounting asked it again: the tools check signs in to each CLI, which takes
 * seconds, and opening a page could start several of them at once. A look started in the last 20 seconds, finished or still
 * going, is the answer for anyone who arrives now; refresh() always looks again.
 */
let shared: { id: string; at: number; p: Promise<Probe> } | null = null;
/** After a look that found a coding tool's sign-in not known yet: when to look again, from that look (one per entry). */
export const UNKNOWN_LOOKS_MS = [3_000, 7_000];
const LOOK_MS = 20_000;

function look(identity: Identity, maxAge: number): Promise<Probe> {
  if (shared && shared.id === identity.id && Date.now() - shared.at < maxAge) return shared.p;
  const p = probe(identity);
  shared = { id: identity.id, at: Date.now(), p };
  return p;
}

/** Which machine is available, if any. */
export function useMachine(identity: Identity): { state: MachineState; refresh: () => void } {
  // Start from what this account last saw rather than from nothing.
  const [state, setState] = useState<MachineState>(() => remembered(identity.id) ?? { mode: "checking", tools: [], home: "" });
  const [n, setN] = useState(0);
  // How old a shared look the next one may reuse: a fresh mount takes a recent one, refresh() never does.
  const maxAge = useRef(LOOK_MS);
  const lastCheck = useRef(0);
  /** How many follow-up looks this run of unknown sign-ins has had (UNKNOWN_LOOKS_MS). */
  const followedUp = useRef(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      const { answer, link, here } = await look(identity, maxAge.current);
      if (!live) return;
      lastCheck.current = Date.now();
      const linkInfo = link ? { connected: !!link.connected, machine: link.machine } : undefined;
      if (!answer) {
        remember(identity.id, null);
        return setState({ mode: "none", tools: [], home: "", link: linkInfo });
      }
      const mode = answer.where === "linked" ? "linked" : "local";
      // Say what is known now rather than holding the whole answer back for a
      // question nobody has asked yet: whether *this* machine is also an
      // option matters when switching, not when finding out if anything works.
      const found: MachineState = { mode, tools: answer.tools, home: answer.home, machine: answer.machine, link: linkInfo };
      setState(found);
      remember(identity.id, found);
      // A sign-in check slower than the server waits (Claude Code's takes two or three seconds on Windows) comes back unknown,
      // which reads as "ready". The server finishes it in the background, so look once more when it will have the answer.
      // Every copy of this sets the same timer off the same look, so they share the one that follows.
      // Soon at first (the quick check gave up at 1.5 s and the real one is usually done a second or two later), then once
      // more for a slow one.
      const unknown = answer.tools.some((t) => t.path && t.loggedIn == null);
      const after = UNKNOWN_LOOKS_MS[followedUp.current];
      if (unknown && after !== undefined) {
        followedUp.current++;
        setTimeout(() => live && ((maxAge.current = 1_000), setN((x) => x + 1)), after);
      } else if (!unknown) followedUp.current = 0;
      if (mode === "local") {
        if (live) setState((cur) => ({ ...cur, hereAvailable: true }));
        return;
      }
      const hereAvailable = (await here) ?? false;
      if (live) setState((cur) => ({ ...cur, hereAvailable }));
    })();
    return () => {
      live = false;
    };
  }, [identity, n]);

  const refresh = useCallback(() => ((maxAge.current = 0), setN((x) => x + 1)), []);

  // The desktop app linking itself is the computer becoming available: look
  // straight away rather than waiting for the next focus or poll. Once, for every copy of this that hears it.
  useEffect(() => {
    // Each copy of this hears the same event at the same moment: a look a quarter of a second old is that one, shared; any
    // older one is from before the computer connected, and taking it said "not connected" for the next two seconds.
    const linked = () => ((maxAge.current = 250), setN((x) => x + 1));
    addEventListener("friday:linked", linked);
    // Another machine picked (pickMachine): what it has, at once, rather than this one's for half a minute.
    const switched = () => {
      setState(remembered(identity.id) ?? { mode: "checking", tools: [], home: "" });
      maxAge.current = 0;
      setN((x) => x + 1);
    };
    addEventListener("friday:machine", switched);
    return () => {
      removeEventListener("friday:linked", linked);
      removeEventListener("friday:machine", switched);
    };
  }, [identity.id]);

  // Coming back to the window is the moment people expect it to be current:
  // the computer may have woken, signed in, or gone while this sat in the back.
  // Not on every flick between windows, though — that is a request per glance. And one look for the whole page, not one per
  // part of it that shows the computer: they all take the look that the first of them starts.
  useEffect(() => {
    const again = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastCheck.current < 30_000) return;
      maxAge.current = 30_000;
      setN((x) => x + 1);
    };
    document.addEventListener("visibilitychange", again);
    addEventListener("focus", again);
    return () => {
      document.removeEventListener("visibilitychange", again);
      removeEventListener("focus", again);
    };
  }, []);

  return { state, refresh };
}

export function toolLabel(t: LocalTool): string {
  if (!t.path) return "not installed";
  const from = t.source === "claude-app" ? "from the Claude app" : "installed";
  return t.loggedIn === false ? `${from} · not logged in` : t.loggedIn ? `${from} · logged in` : from;
}

/** The installer for the visitor's computer (the site picks Windows or Mac), not a GitHub page. */
export const RELEASES = "https://www.tryfridaywork.com/download";

/** Open "Connect this computer" (AlwaysOn.tsx's ConnectThisComputer, mounted by the app): Friday from a browser, no app. */
export const connectThisComputer = () => window.dispatchEvent(new Event("friday:connect-computer"));

/**
 * No computer to work on yet. The desktop app connects the computer it runs on by itself, so in the app that is what is
 * happening. In a browser, this computer is connected with one command in a terminal (or the app, for those who want it).
 */
export function NoMachine({ className = "muted small" }: { className?: string }) {
  if (typeof window !== "undefined" && window.fridayDesktop?.link) return <p className={className}>Friday’s desktop app connects this computer on its own. This updates once it has.</p>;
  // The app first: it connects the computer by itself, where the other way is Node 20 and a command in a terminal, which a
  // first run on Solo could not get past (Arun, 2026-10-24: UX gaps).
  return (
    <div className={`no-machine ${className}`}>
      <span>Your coding tools run on your computer. The desktop app connects it by itself.</span>
      <span className="no-machine-actions">
        <button type="button" className="btn small primary" onClick={() => openOutside(RELEASES)}>
          Get the desktop app
        </button>
        <button type="button" className="link-btn" onClick={connectThisComputer}>
          or connect with a terminal
        </button>
      </span>
    </div>
  );
}

/**
 * Which machine the work goes to, and how to change it.
 *
 * Worth its own line because "my other laptop is signed into a different Claude
 * account" is invisible otherwise: the limit, the login and the repos all come
 * from whichever machine is connected, so it says which one that is.
 */
export function MachineLine({ identity, state, refresh }: { identity: Identity; state: MachineState; refresh: () => void }) {
  const name = state.machine?.name ?? (state.mode === "linked" ? "your connected computer" : "this computer");
  const disconnect = async () => {
    await linkApi(identity, "/api/link/forget", { method: "POST", body: "{}" }).catch(() => {});
    setLinkToken("");
    setMachinePref("local");
    refresh();
  };

  return (
    <div className="machine-line">
      <span className="engine-dot" aria-hidden />
      <span className="machine-name">
        Working on <strong>{name}</strong>
        <span className="muted small"> · {state.mode === "linked" ? "linked" : "this computer"}</span>
      </span>
      {state.mode === "linked" && state.hereAvailable && (
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            setMachinePref("local");
            refresh();
          }}
        >
          Use this computer
        </button>
      )}
      {state.mode === "local" && state.link?.connected && (
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            setMachinePref("link");
            refresh();
          }}
        >
          Use {state.link.machine?.name ?? "the connected machine"}
        </button>
      )}
      {/* In the desktop app this computer is the app's own link, kept by it until you sign out: a Disconnect here would only
          be undone by the app a minute later, so signing out is how it is disconnected. A runner started from a terminal
          (a browser's link) is still disconnected from here. */}
      {state.mode === "linked" &&
        (typeof window !== "undefined" && window.fridayDesktop?.link ? (
          <span className="muted small">Friday’s desktop app keeps this computer connected until you sign out.</span>
        ) : (
          <button type="button" className="link-btn" onClick={() => void disconnect()}>
            Disconnect
          </button>
        ))}
    </div>
  );
}

/**
 * The other half of a CLI sign-in: the page the CLI opened finishes it by itself, and the card notices once the tool is signed in.
 */
export function LoginCode({ tool, url }: { tool: string; url: string }) {
  const name = ENGINE_NAMES[tool as EngineTool] ?? tool;
  return (
    <div className="login-code">
      <p className="muted small">
        <span className="spinner tiny" /> Finish signing in to {name} in the page that opened — this card updates by itself when you're done.{" "}
        <button type="button" className="link-btn" onClick={() => openOutside(url)}>
          Open it again
        </button>
      </p>
    </div>
  );
}

/** Shown when the chosen CLI isn't signed in: one click opens its login on that machine. */
export function LoginNotice({ identity, tool, onRecheck }: { identity: Identity; tool: LocalTool; onRecheck: () => void }) {
  const [state, setState] = useState<"idle" | "opening" | "link" | "opened" | "manual">("idle");
  const [command, setCommand] = useState("");
  // The sign-in page the CLI printed. A link beats a terminal window.
  const [url, setUrl] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState("");

  const open = async () => {
    setState("opening");
    setErr("");
    try {
      const r = await hostApi<{ opened?: boolean; command: string; url?: string }>(identity, "/api/runner/login", {
        method: "POST",
        body: JSON.stringify({ tool: tool.tool }),
      });
      setCommand(r.command);
      if (r.url) {
        setUrl(r.url);
        setState("link");
      } else setState(r.opened ? "opened" : "manual");
    } catch (e) {
      setErr((e as Error).message);
      setState("idle");
    }
  };

  /** Sign out on that machine, optionally straight into signing back in. */
  const signOut = async (thenIn: boolean) => {
    setState("opening");
    setErr("");
    try {
      await hostApi(identity, "/api/runner/logout", { method: "POST", body: JSON.stringify({ tool: tool.tool }) });
      setConfirming(false);
      if (thenIn) return void open();
      setState("idle");
      onRecheck();
    } catch (e) {
      setErr((e as Error).message);
      setState("idle");
    }
  };

  // Signed in: the account can be changed from here, which is the fix for
  // "it's using the wrong Claude account on that machine".
  if (tool.loggedIn === true) {
    return (
      <div className="auth-line">
        <span>
          <strong>{tool.name}</strong> is signed in{tool.source === "claude-app" ? " (the copy inside the Claude app)" : ""}.
        </span>
        {confirming ? (
          <>
            <span className="muted small">Signing out affects every use of {tool.name} on that machine, not just Friday.</span>
            <button type="button" className="link-btn" disabled={state === "opening"} onClick={() => void signOut(false)}>
              Sign out
            </button>
            <button type="button" className="link-btn" disabled={state === "opening"} onClick={() => void signOut(true)}>
              Sign out and sign in again
            </button>
            <button type="button" className="link-btn" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" className="link-btn" onClick={() => setConfirming(true)}>
              Sign out
            </button>
            <button type="button" className="link-btn" disabled={state === "opening"} onClick={() => void open()}>
              Sign in again
            </button>
          </>
        )}
        {state === "link" && <LoginCode tool={tool.tool} url={url} />}
        {state === "opened" && (
          <span className="muted small">
            A terminal opened on that machine — finish there, then{" "}
            <button type="button" className="link-btn" onClick={onRecheck}>
              check again
            </button>
            .
          </span>
        )}
        {state === "manual" && <pre className="engine-cmd">{command}</pre>}
        {err && <span role="alert" className="error small">{err}</span>}
      </div>
    );
  }

  if (tool.loggedIn !== false) return null;

  return (
    <div className="login-notice">
      <p>
        <strong>{tool.name} isn't logged in on that machine.</strong>{" "}
        {tool.source === "claude-app"
          ? "The Claude Code inside the Claude app signs in separately from the app itself. Sign in once with your Claude account and Friday can use it."
          : "Sign in once with your own account. Friday never sees it."}
      </p>
      {state === "link" && <LoginCode tool={tool.tool} url={url} />}
      {state === "opened" && <p className="muted small">A terminal window opened on that machine. Finish signing in there, then check again.</p>}
      {state === "manual" && <pre className="engine-cmd">{command}</pre>}
      <div className="lane-form-actions">
        {state !== "opened" && (
          <button type="button" className="btn primary small" disabled={state === "opening"} onClick={() => void open()}>
            {state === "opening" ? <span className="spinner" /> : null} Sign in to {tool.name}
          </button>
        )}
        <button type="button" className="btn ghost small" onClick={onRecheck}>
          Check again
        </button>
      </div>
      {err && <p role="alert" className="error small">{err}</p>}
    </div>
  );
}
