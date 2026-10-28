import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PreviewInfo } from "../runner/preview.js";
import { Icon } from "./icons.js";
import { api, uploadFile } from "./api.js";
import type { Send } from "./useSession.js";
import { hostApi, linkToken, useMachine } from "./local.js";
import { addToComposer, describePick, POINT_CANCEL, POINT_SCRIPT, type Pick } from "./point.js";
import { openOutside } from "./openOutside.js";
import { isLocalUrl, takeIosAsk, takePendingPreview, throughFriday, type PreviewTarget } from "./previewBus.js";
import type { Identity } from "./storage.js";
import { MenuButton, type MenuItem } from "./ui.js";
import { IosPreview } from "./IosPreview.js";

/** A server on this machine, as the Local servers menu lists it. */
export interface LocalServer {
  url: string;
  /** What runs it: "npm run dev". */
  command: string;
  ready: boolean;
  /** The project's own preview, as opposed to something the agent left running. */
  preview: boolean;
  /** Running on this computer but not in this project. */
  elsewhere?: boolean;
  /** How it is stopped: the preview's own stop, the background task Friday started, or whatever listens on the port. */
  stop?: { task: string } | { port: number };
}

/**
 * The servers Friday can see running for this folder: the preview's own, and each command the agent left running in the
 * background that printed a local address. One per port, the preview's first.
 * ponytail: only servers Friday started or saw start; one started in a terminal outside Friday needs the runner to list ports.
 */
export function localServers(info: PreviewInfo | null, tasks: { id?: string; command: string; running: boolean; log: string[] }[], found: FoundServer[] = []): LocalServer[] {
  const out: LocalServer[] = [];
  const seen = new Set<string>();
  const add = (s: LocalServer) => {
    const port = new URL(s.url).port || "80";
    if (seen.has(port)) return;
    seen.add(port);
    out.push(s);
  };
  if (info) add({ url: info.url, command: info.command, ready: info.ready, preview: true });
  for (const t of tasks) {
    if (!t.running) continue;
    const said = t.log.join("\n").match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?\/?/gi)?.at(-1);
    if (said) add({ url: said.replace("0.0.0.0", "localhost").replace(/\/$/, ""), command: t.command, ready: true, preview: false, ...(t.id ? { stop: { task: t.id } } : {}) });
  }
  // Then what the computer says is listening, whoever started it: an agent's own shell, a terminal, an agent's copy of the folder.
  for (const f of found) add({ url: f.url, command: f.command, ready: true, preview: false, stop: { port: f.port }, ...(f.here ? {} : { elsewhere: true }) });
  return out;
}

/** A web server the runner found listening on this computer (runner/ports.ts). */
export interface FoundServer {
  port: number;
  url: string;
  pid: number;
  command: string;
  cwd: string | null;
  /** In this project: its folder, a folder inside it, or an agent's copy of it. Otherwise another dev server on the computer. */
  here: boolean;
}

/**
 * Every web server running for `cwd`'s project, found by the runner from the computer's open ports, polled while shown. An
 * older Friday app doesn't know how to look, and says nothing: the list then has what Friday started, as before.
 */
export function useLocalServers(identity: Identity, cwd: string | null, every = 5000): FoundServer[] {
  const [servers, setServers] = useState<FoundServer[]>([]);
  useEffect(() => {
    if (!cwd) return setServers([]);
    let live = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const round = async () => {
      if (!document.hidden) {
        try {
          const r = await hostApi<{ servers?: FoundServer[] }>(identity, `/api/runner/servers.list?cwd=${encodeURIComponent(cwd)}`);
          if (live) setServers(same(r.servers ?? []));
        } catch {
          // Too old to know, or away: what Friday started still lists.
        }
      }
      if (live) t = setTimeout(() => void round(), every);
    };
    void round();
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [identity, cwd, every]);
  return servers;
}

/** A poll's answer is usually the last one again: keep the old object then, so nothing that depends on it draws again for nothing. */
const same =
  <T,>(next: T) =>
  (prev: T): T =>
    JSON.stringify(prev) === JSON.stringify(next) ? prev : next;

/**
 * The project, running.
 *
 * A diff says what changed; this says what it does. The dev server runs on the
 * machine doing the work — so when that machine is this one the frame points
 * straight at it, and when it's someone's linked laptop the bytes come back
 * over the link instead.
 */

type Options = { scripts: string[]; static: boolean };

interface Tab {
  id: string;
  url: string;
  /** Where the page has gone since it was opened: what the address bar shows. */
  seen?: string;
  /** The page didn't come: nothing answered at that address. */
  down?: boolean;
}

/** The title of the page Friday sends back when a previewed server doesn't answer (see /api/preview in app.ts). */
const NOTHING_ANSWERED = "Nothing answered";

type Heard = { source: unknown; origin: string; data: unknown };

/** The origin of a preview served through Friday (a ticket's address), or "" for anything else. */
function previewOriginOf(src: string, here: string): string {
  try {
    const u = new URL(src, here);
    return u.pathname.startsWith("/api/preview/") ? u.origin : "";
  } catch {
    return "";
  }
}

/**
 * What a preview served on its own site (see /api/preview in app.ts), which the panel can't read, says by message: only
 * from the frame showing that tab, and only from the address that tab's preview is on. Anything else: null.
 */
export function fromPreview(e: Heard, frame: Window | null | undefined, src: string, here: string): Record<string, unknown> | null {
  const from = previewOriginOf(src, here);
  const ok = !!frame && !!from && e.source === frame && e.origin === from && !!e.data && typeof e.data === "object";
  return ok ? (e.data as Record<string, unknown>) : null;
}

/** Friday's "Nothing answered" page saying so from a preview on its own site. */
export function nothingAnswered(e: Heard, frame: Window | null | undefined, src: string, here: string): boolean {
  const d = fromPreview(e, frame, src, here);
  return d?.type === "friday-preview" && d.state === "nothing-answered";
}

/** A ticket's link (relative, or absolute on a preview site of its own), as the key it is remembered by: its path. */
export function ticketPath(url: string, here: string): string {
  return new URL(url, here).pathname.replace(/\/$/, "");
}

/** The address a page is really at: a ticket's link, on whichever host, read back as the machine's own address. */
export function addressThrough(url: string, through: Map<string, string>): string {
  const m = url.match(/^(?:https?:\/\/[^/]+)?(\/api\/preview\/[\w-]+)(\/.*)?$/);
  const base = m ? through.get(m[1]!) : undefined;
  return base ? `${base}${m![2] && m![2] !== "/" ? m![2] : ""}` : url;
}

/** What a webview's events carry that a plain Event doesn't declare. */
type ViewEvent = Event & { url?: string; isMainFrame?: boolean; errorCode?: number; validatedURL?: string; title?: string };

/** What Electron's <webview> offers that an iframe cannot: real history. */
interface WebviewEl extends HTMLElement {
  capturePage?: () => Promise<{ toDataURL: () => string }>;
  reload?: () => void;
  goBack?: () => void;
  goForward?: () => void;
  executeJavaScript?: (code: string) => Promise<unknown>;
}

/** "localhost:3000" from an address, or the address as it is. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

let seq = 0;
const nextId = () => `p${(seq += 1)}`;

/**
 * A session's Preview tabs, which one was showing, and the last address asked for from the conversation that it took: per
 * session and in this browser only, as the Terminal keeps its tabs. Coming back to the session (or reloading) opens the same
 * pages again; a tab still following the project is kept as "" and goes on following it.
 */
const PREVIEW = (sid: string) => `friday.preview.${sid}`;
export function savedPreview(sid: string): { tabs: string[]; at: number; took: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(PREVIEW(sid)) ?? "null") as { tabs?: unknown; at?: unknown; took?: unknown } | null;
    const tabs = Array.isArray(v?.tabs) ? v.tabs.filter((u): u is string => typeof u === "string" && (u === "" || /^https?:\/\//i.test(u) || u.startsWith("/api/preview/"))).slice(0, 12) : [];
    return tabs.length ? { tabs, at: Math.min(Math.max(0, Number(v?.at) || 0), tabs.length - 1), took: Number(v?.took) || 0 } : null;
  } catch {
    return null;
  }
}

/** A tab is named by its host, or its last path segment — never the whole URL. */
function label(url: string): string {
  if (!url) return "New tab";
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return u.port ? `${u.hostname}:${u.port}` : (last ?? u.hostname);
  } catch {
    return url.slice(0, 24);
  }
}

/**
 * Whether the preview can open the dev server itself rather than through Friday.
 *
 * A browser on the same machine as the server can, over plain http. The desktop
 * app can whenever the machine it linked is the one it runs on — its window is
 * not a page on Friday's origin, so there is nothing to block and nothing to
 * proxy. Anything else has to go through Friday.
 */
export function loadsDirectly(o: { mode: string; protocol: string; desktop: boolean; ownMachine: boolean }): boolean {
  if (o.mode === "local" && o.protocol === "http:") return true;
  return o.mode === "linked" && o.desktop && o.ownMachine;
}

export function PreviewPanel({
  identity,
  cwd,
  sid,
  invite,
  send,
  onClose,
  bare = false,
  onOutput,
  asNote = false,
  shown: onScreen = true,
  headSlot,
  iosElsewhere,
}: {
  /** Other folders the agents are working in, where the iOS side looks when `cwd` has no Xcode project (ios-folders.ts). */
  iosElsewhere?: string[];
  /** A place in the workbench's header beside the panel's name: the Web / iOS switch goes there rather than above the page. */
  headSlot?: HTMLElement | null;
  /** Showing. Put away in the workbench it is kept, page and all, but asks nothing of the machine until it is shown again. */
  shown?: boolean;
  /** Somebody who isn't telling the agent what to do: pointing at the page leaves a note for the driver instead. */
  asNote?: boolean;
  /** Where the dev server's output is read: the Tasks list, not here. */
  onOutput?: () => void;
  identity: Identity;
  cwd: string | null;
  /**
   * The session, when its code is a folder somebody uploaded.
   *
   * Then the dev server runs on Friday rather than on anybody's machine —
   * which is the only way a session with nothing linked gets a preview at
   * all, and that is exactly the session where a folder was uploaded.
   */
  sid?: string | null;
  /** With these, a screenshot of the page can be handed to the agent. */
  invite?: string;
  send?: Send;
  onClose: () => void;
  bare?: boolean;
}) {
  const { state: machine } = useMachine(identity);
  const [info, setInfo] = useState<PreviewInfo | null>(null);
  // The end of the browser's row of pages, where Web / iOS sits (Arun, 2026-10-24: "move the web and iOS buttons to the right
  // side ... in line with the new tab / tabs section row"). The iOS side has no such row: there it has a line of its own.
  const [kindSlot, setKindSlot] = useState<HTMLElement | null>(null);
  const [options, setOptions] = useState<Options | null>(null);
  const [src, setSrc] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const frame = useRef<HTMLIFrameElement | null>(null);
  /** Every tab's iframe, so a page saying nothing answered is matched to its own tab. */
  const frames = useRef(new Map<string, HTMLIFrameElement>());

  // On this machine the browser can reach the dev server itself, which is the
  // honest version: modules, websockets, hot reload, everything.
  //
  // The desktop app is that case too, even when it is showing Friday on the web:
  // the machine it linked is the one it is running on, so its window can open
  // the dev server itself. Going through Friday instead breaks a site that asks
  // for "/src/main.jsx" from the root of its own address — it arrives as a blank
  // page, which is exactly what a Vite project did.
  const [ownMachine, setOwnMachine] = useState(false);
  useEffect(() => {
    const ask = window.fridayDesktop?.linkedToken;
    if (!ask) return;
    let live = true;
    // The app links its own runner with this page's token, so a link is this computer's unless the app names a different
    // one. Asking for an exact match made a wiped link file read as somebody else's machine, and every localhost page then
    // went through Friday, where a Next or Vite site breaks.
    void ask(location.origin).then(
      (t) => live && setOwnMachine(!t || t === linkToken()),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [machine.mode]);
  const direct = loadsDirectly({ mode: machine.mode, protocol: location.protocol, desktop: !!window.fridayDesktop, ownMachine });
  // An iOS app too, on a Mac in the desktop app whose own machine has this folder: built with Xcode and run in a simulator
  // (IosPreview). Which side was showing is kept per session.
  const mac = (window.fridayDesktop?.platform ?? "") === "darwin" || (!!window.fridayDesktop && /mac/i.test(navigator.userAgent));
  const iosHere = mac && !!cwd && (machine.mode === "local" || (machine.mode === "linked" && ownMachine));
  const kindKey = `friday.preview.kind.${sid ?? cwd ?? ""}`;
  const [kind, setKind] = useState<"web" | "ios">(() => {
    try {
      return localStorage.getItem(kindKey) === "ios" ? "ios" : "web";
    } catch {
      return "web";
    }
  });
  const showKind = (k: "web" | "ios") => {
    setKind(k);
    try {
      localStorage.setItem(kindKey, k);
    } catch {
      /* kept for this visit only */
    }
  };
  // An agent said "Preview: ios" (or Friday Code asked for it): the iOS side, built and run now.
  const [iosAsk, setIosAsk] = useState(0);
  useEffect(() => {
    const take = () => {
      const a = sid ? takeIosAsk(sid) : null;
      if (!a) return;
      showKind("ios");
      // Friday Code builds through its own tool (the runner already has it going); a coding tool's line asks the panel to.
      if (a.run) setIosAsk(a.at);
    };
    // Asked before this panel was there (it opened for the ask), then as it is asked.
    take();
    const h = (e: Event) => {
      const d = (e as CustomEvent<{ sid?: string }>).detail ?? {};
      if (d.sid && d.sid !== sid) return;
      take();
    };
    addEventListener("friday:preview-ios", h);
    return () => removeEventListener("friday:preview-ios", h);
  }, [sid]); // eslint-disable-line react-hooks/exhaustive-deps
  // Here, not on a machine: no cwd to name, because the server knows which
  // folder this session's is.
  const here = !cwd && !!sid;
  const ask = <T,>(what: string, init?: RequestInit) =>
    here ? api<T>(identity, `/api/sessions/${sid}/preview.${what}`, init) : hostApi<T>(identity, `/api/runner/preview.${what}${init ? "" : `?cwd=${encodeURIComponent(cwd ?? "")}`}`, init);

  const look = useCallback(async () => {
    if (!cwd && !here) return;
    try {
      const [s, o] = await Promise.all([ask<{ preview: PreviewInfo | null }>("status"), ask<Options>("options")]);
      setInfo(same(s.preview));
      setOptions(same<Options | null>(o));
    } catch (e) {
      // A session with no folder at all (nothing uploaded, no agent's folder yet) has no project to run, which isn't a fault:
      // the browser stays, for any other page (Arun, 2026-10-26: such a session showed this error in place of its browser).
      if (here && /no uploaded folder/i.test((e as Error).message)) return void setInfo(null);
      setErr((e as Error).message);
    }
  }, [identity, cwd, here, sid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void look();
  }, [look]);

  // The agent started it: look now, not at the next poll.
  useEffect(() => {
    const again = () => void look();
    addEventListener("friday:preview-started", again);
    return () => removeEventListener("friday:preview-started", again);
  }, [look]);

  // While it's coming up, keep asking: dev servers take a few seconds.
  useEffect(() => {
    if (!onScreen || !info || info.ready) return;
    // Not while the window is hidden: nobody is watching it come up, and the next look once it is shown catches up.
    const t = setInterval(() => !document.hidden && void look(), 1500);
    return () => clearInterval(t);
  }, [onScreen, info, look]);

  /**
   * A ticket for a port on the machine doing the work, so its pages come back through Friday (see /api/preview in app.ts).
   * Each ticket's prefix is remembered with the address it stands for, so the bar says "localhost:3000", not the ticket.
   */
  const through = useRef(new Map<string, string>());
  const ticketFor = async (port: number) => {
    const r = await (here
      ? api<{ url: string }>(identity, "/api/preview/ticket", { method: "POST", headers: { "x-friday-here": "1" }, body: JSON.stringify({ port, sid }) })
      : hostApi<{ url: string }>(identity, "/api/preview/ticket", { method: "POST", body: JSON.stringify({ port }) }));
    through.current.set(ticketPath(r.url, location.href), `http://localhost:${port}`);
    return r;
  };
  const addressOf = (url: string): string => addressThrough(url, through.current);
  // Point the frame at it: straight there, or through Friday for a linked machine.
  useEffect(() => {
    let live = true;
    void (async () => {
      if (!info?.ready) return setSrc("");
      if (direct) return setSrc(info.url);
      try {
        const r = await ticketFor(info.port);
        if (live) setSrc(r.url);
      } catch (e) {
        if (live) setErr((e as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [info?.ready, info?.port, direct, identity, here, sid]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (script?: string): Promise<boolean> => {
    setBusy(script ?? "start");
    setErr("");
    try {
      const r = await ask<{ preview: PreviewInfo }>("start", { method: "POST", body: JSON.stringify({ cwd, script }) });
      setInfo(r.preview);
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy("");
    }
  };

  const stop = async () => {
    setBusy("stop");
    try {
      await ask("stop", { method: "POST", body: JSON.stringify({ cwd }) });
      setInfo(null);
      setSrc("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  /**
   * Tabs, because one page is not how anybody looks at a running app: the
   * thing you are building in one, the docs for the thing it is failing on in
   * another. Each keeps its own address; the project's own is where the first
   * one starts, and follows the dev server when that comes up.
   */
  const [saved] = useState(() => (sid ? savedPreview(sid) : null));
  const [tabs, setTabs] = useState<Tab[]>(() => (saved ? saved.tabs.map((url) => ({ id: nextId(), url })) : [{ id: nextId(), url: "" }]));
  const [at, setAt] = useState(saved?.at ?? 0);
  // The `at` of the last address from the conversation this panel opened (previewBus), kept with the tabs.
  const took = useRef(saved?.took ?? 0);
  const [typed, setTyped] = useState("");
  const views = useRef(new Map<string, WebviewEl>());
  const active = tabs[Math.min(at, tabs.length - 1)];
  const desktopView = typeof window !== "undefined" && !!window.fridayDesktop;

  // The first tab follows the project until somebody sends it somewhere else.
  useEffect(() => {
    if (!src) return;
    setTabs((t) => (t[0] && !t[0].url ? [{ ...t[0], url: src }, ...t.slice(1)] : t));
  }, [src]);

  useEffect(() => setTyped(""), [at, active?.url]);

  useEffect(() => {
    if (!sid) return;
    try {
      // Where each page has got to, so a route survives; "" for a tab following the project.
      localStorage.setItem(PREVIEW(sid), JSON.stringify({ tabs: tabs.map((t) => (t.url ? (t.seen ?? t.url) : "")), at, took: took.current }));
    } catch {
      // Private mode: the tabs are still here until the session is left.
    }
  }, [sid, tabs, at]);

  const shown = active?.url ?? "";
  const view = () => (active ? views.current.get(active.id) : undefined);

  const setUrl = (url: string) =>
    setTabs((t) => t.map((tab, i) => (i === Math.min(at, t.length - 1) ? { id: tab.id, url } : tab)));
  const patch = (id: string, p: Partial<Tab>) => setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));

  /**
   * Following a page in the desktop's webview: where it navigated to, for the bar, and whether it came at all. A refused
   * connection fails the load; a server that didn't answer through Friday comes back as Friday's "Nothing answered" page.
   */
  const wired = useRef(new WeakSet<Element>());
  const wire = (id: string, el: WebviewEl) => {
    if (wired.current.has(el)) return;
    wired.current.add(el);
    el.addEventListener("did-navigate", (e: ViewEvent) => patch(id, { seen: e.url, down: false }));
    el.addEventListener("did-navigate-in-page", (e: ViewEvent) => e.isMainFrame && patch(id, { seen: e.url }));
    el.addEventListener("page-title-updated", (e: ViewEvent) => e.title === NOTHING_ANSWERED && patch(id, { down: true }));
    // -3 is a load given up for another one, which is not the page failing.
    el.addEventListener("did-fail-load", (e: ViewEvent) => e.isMainFrame && e.errorCode !== -3 && patch(id, { seen: e.validatedURL, down: true }));
  };

  // A preview on its own site can't be read from here, so its "Nothing answered" page says so (nothingAnswered above).
  useEffect(() => {
    const heard = (e: MessageEvent) => {
      for (const [id, el] of frames.current) if (nothingAnswered(e, el.contentWindow, el.src, location.href)) patch(id, { down: true });
    };
    addEventListener("message", heard);
    return () => removeEventListener("message", heard);
  }, []);

  /**
   * Where an address lands among the tabs. Typed in the bar: this tab. Sent by an agent ("auto"): the tab already on that server
   * (its own port), else an empty tab, else a new one, so an agent opening its page never replaces the one somebody is
   * reading (Arun, 2026-10-19: "coding tools can use the other tabs on the preview panel too"). "new": a tab of its own.
   */
  const place = (url: string, target: PreviewTarget) => {
    if (target === "here") return setUrl(url);
    if (target === "new") return openTab(url);
    const port = (u: string) => {
      try {
        const x = new URL(u);
        return `${x.hostname}:${x.port}`;
      } catch {
        return "";
      }
    };
    const want = port(url);
    const same = tabs.findIndex((t) => !!t.url && (port(t.seen ?? t.url) === want || port(t.url) === want));
    if (same >= 0) {
      setAt(same);
      return setTabs((ts) => ts.map((t, i) => (i === same ? { id: t.id, url } : t)));
    }
    if (!active?.url) return setUrl(url);
    openTab(url);
  };

  const go = (raw: string, target: PreviewTarget = "here") => {
    const t = raw.trim();
    if (!t) return;
    // A bare host, a path on the project, or a whole address: all three are
    // things people type into a bar like this.
    const guess = /^[a-z][\w+.-]*:\/\//i.test(t) ? t : t.startsWith("/") && src ? new URL(t, src).toString() : `http://${t}`;
    try {
      const url = new URL(guess).toString();
      setTyped("");
      // An address on the machine doing the work that this page can't reach itself (a hosted Friday showing a linked machine, a
      // folder running here) goes through Friday: a coding tool's "it's up at localhost:3000" has to open all the same.
      if (isLocalUrl(url) && !direct) {
        const port = Number(new URL(url).port) || 80;
        void ticketFor(port).then(
          (r) => place(throughFriday(url, r.url), target),
          (e) => setErr((e as Error).message),
        );
        return;
      }
      place(url, target);
    } catch {
      // Not an address: leave the view where it is rather than blanking it.
    }
  };

  const reload = () => {
    if (active?.down) patch(active.id, { down: false });
    const v = view();
    if (v?.reload) return v.reload();
    if (frame.current) frame.current.src = frame.current.src;
  };
  // An address somebody pressed in the conversation opens here, in this
  // browser. It may have been pressed before this panel existed, so it waits
  // in previewBus; and again for a panel that was already open.
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    const show = () => {
      const p = sid ? takePendingPreview(sid, took.current) : null;
      if (!p) return;
      took.current = p.at;
      goRef.current(p.url, p.tab ?? "auto");
    };
    show();
    addEventListener("friday:preview-open", show);
    return () => removeEventListener("friday:preview-open", show);
  }, []);

  // Point at something in the page and it lands in the message box, described.
  const [pointing, setPointing] = useState(false);
  const [pointNote, setPointNote] = useState("");
  // A note being written on something picked in the page (asNote), and its draft.
  const [picked, setPicked] = useState<Pick | null>(null);
  const [note, setNote] = useState("");
  const [noting, setNoting] = useState(false);
  const sendNote = async () => {
    if (!picked || !note.trim() || !send) return;
    setNoting(true);
    const r = await send({ type: "suggest", text: `${note.trim()}\n\n${describePick(picked)}` });
    setNoting(false);
    if (!r.ok) return setPointNote(/can't make suggestions/.test(r.error ?? "") ? "This session's owner hasn't let viewers leave notes. Ask them to turn on suggestions for viewers." : (r.error ?? "That note didn't send. Try again."));
    setPicked(null);
    setNote("");
    setPointNote("Sent to whoever is driving. They can turn it into a task for the agent.");
  };
  const run = (code: string): Promise<unknown> => {
    const v = view();
    if (v?.executeJavaScript) return v.executeJavaScript(code);
    // An iframe can be reached into only when the page is on this origin.
    const el = frame.current;
    const win = el?.contentWindow as (Window & { eval?: (c: string) => unknown }) | null | undefined;
    try {
      if (!win?.eval) throw new Error("no frame");
      return Promise.resolve(win.eval(code));
    } catch {
      // A preview on a site of its own carries Friday's point bridge (pointBridge in point.ts): ask it by message instead.
      const to = el ? previewOriginOf(el.src, location.href) : "";
      if (!win || !to || (code !== POINT_SCRIPT && code !== POINT_CANCEL)) return Promise.reject(new Error("cross-origin"));
      const cancel = code === POINT_CANCEL;
      const id = Math.random().toString(36).slice(2);
      win.postMessage({ type: "friday-point", id, cancel }, to);
      if (cancel) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        let ready = false;
        const heard = (e: MessageEvent) => {
          const d = fromPreview(e, win, el!.src, location.href);
          if (d?.type !== "friday-point" || d.id !== id) return;
          if (d.ready) return void (ready = true);
          removeEventListener("message", heard);
          resolve(d.pick ?? null);
        };
        addEventListener("message", heard);
        // No bridge answering (a page that isn't HTML, still loading): say so rather than wait for a click that does nothing.
        setTimeout(() => !ready && (removeEventListener("message", heard), reject(new Error("cross-origin"))), 2000);
      });
    }
  };
  const point = async () => {
    if (pointing) {
      setPointing(false);
      void run(POINT_CANCEL).catch(() => {});
      return;
    }
    setPointNote("");
    setPointing(true);
    try {
      const got = (await run(POINT_SCRIPT)) as Pick | null;
      // Somebody who isn't the one telling the agent what to do (a designer, a PM, a teammate watching) leaves a note on it
      // instead, which goes to whoever is driving as a suggestion pinned to that element.
      if (got && asNote && send) setPicked(got);
      else if (got) {
        addToComposer(describePick(got));
        setPointNote("Added to your message.");
      }
    } catch {
      setPointNote("Friday couldn't reach into this page to point at it. Wait for it to finish loading and try again, or use the desktop app.");
    } finally {
      setPointing(false);
    }
  };
  const back = () => view()?.goBack?.();
  const forward = () => view()?.goForward?.();

  const openTab = (url = "") => {
    setTabs((t) => [...t, { id: nextId(), url }]);
    setAt(tabs.length);
  };
  const closeTab = (id: string) => {
    views.current.delete(id);
    setTabs((t) => {
      const left = t.filter((x) => x.id !== id);
      const next = left.length ? left : [{ id: nextId(), url: src }];
      setAt((i) => Math.min(i, next.length - 1));
      return next;
    });
  };

  // The actions belong to the preview, not to the panel: in the tabbed shell
  // the header is the tab strip, so they move into a bar above the frame.
  /**
   * What the page looks like, to the agent. Only the desktop's webview can be captured: an iframe of somebody else's
   * origin is a black box to the page around it, so the button is there only where it works.
   */
  const [shooting, setShooting] = useState(false);
  const shoot = async () => {
    const view = views.current.get(tabs[at]?.id ?? "");
    if (!view?.capturePage || !sid || !invite || !send) return;
    setShooting(true);
    setErr("");
    try {
      const image = await view.capturePage();
      const att = await uploadFile(sid, invite, identity.id, { url: image.toDataURL(), mediaType: "image/png", filename: "preview.png" });
      const r = await send({ type: "instruct", text: "Here is what the preview shows right now.", attachments: [att] });
      if (!r.ok) setErr(r.error ?? "Couldn't send the screenshot. Try again.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setShooting(false);
    }
  };
  const canShoot = desktopView && !!sid && !!invite && !!send;

  // What runs on this machine, for the Local servers menu: the preview's server and what the agent left running.
  const { tasks, stop: stopTask } = useBackgroundTasks(identity, here || !onScreen ? null : cwd, 5000);
  const found = useLocalServers(identity, here || !onScreen ? null : cwd, 5000);
  const servers = localServers(info, tasks, found);
  const ours = servers.filter((x) => !x.elsewhere);
  const others = servers.filter((x) => x.elsewhere);
  // Stopping one from its row: the preview's own stop, Friday's background task, or (runner/ports.ts) what listens on the port.
  const stopServer = async (s: LocalServer) => {
    setErr("");
    try {
      if (s.preview) return void (await stop());
      if (s.stop && "task" in s.stop) return void (await stopTask(s.stop.task));
      if (s.stop && "port" in s.stop && cwd) {
        const r = await hostApi<{ stopped: boolean; error?: string }>(identity, "/api/runner/servers.stop", { method: "POST", body: JSON.stringify({ cwd, port: s.stop.port }) });
        if (!r.stopped) setErr(r.error ?? "Couldn't stop it.");
      }
    } catch (e) {
      // A runner from before the stop button: it can list servers but not stop them.
      setErr(/not found|unknown|404/i.test((e as Error).message) ? "Update Friday to stop servers from here." : (e as Error).message);
    }
  };
  const serverItem = (s: LocalServer): MenuItem => {
    const label = s.url.replace(/^https?:\/\//, "");
    return {
      label,
      title: s.command,
      icon: "server",
      ...(s.ready ? { live: true } : { hint: "Starting" }),
      checked: !!shown && (s.preview && !!src ? shown === src : shown.replace(/\/$/, "") === s.url),
      onSelect: () => (s.preview && src ? setUrl(src) : go(s.url)),
      ...(s.preview || s.stop ? { action: { icon: "stop" as const, label: `Stop ${label}`, disabled: s.preview && busy === "stop", onSelect: () => void stopServer(s) } } : {}),
    };
  };
  const serverItems = (): MenuItem[] =>
    servers.length
      ? [
          ...(ours.length ? [{ heading: "Running here" } as MenuItem, ...ours.map(serverItem)] : [{ node: <p className="bw-servers-none">Nothing is running in this project yet.</p>, height: 40 } as MenuItem]),
          ...(others.length ? [{ heading: "Elsewhere on this computer" } as MenuItem, ...others.map(serverItem)] : []),
        ]
      : [{ node: <p className="bw-servers-none">Nothing is running yet.</p>, height: 40 }];
  // Starting and stopping the project's own server, from the same menu that lists what runs.
  const serverMenu = (): MenuItem[] => [
    ...serverItems(),
    ...(info
      ? []
      : options && (options.scripts.length || options.static)
        ? [
            { heading: "Start" } as MenuItem,
            ...options.scripts.map((sc): MenuItem => ({ label: `npm run ${sc}`, icon: "play", disabled: !!busy, onSelect: () => void start(sc) })),
            ...(options.static ? [{ label: "Serve the folder", icon: "file" as const, disabled: !!busy, onSelect: () => void start() }] : []),
          ]
        : []),
  ];
  // The page in the person's own browser: the address on the machine when the page can reach it, else the one through Friday.
  // On this computer the machine's own address ("localhost:5173") is one the person's browser reaches too; through Friday the
  // page is a ticket's path, which only means something whole, with this page's origin in front of it.
  // Where the page is now, not where the tab started: a link followed inside the preview is the page that opens.
  const openShown = () => {
    const page = active?.seen || shown || info?.url || "";
    if (!page) return;
    const own = addressOf(page);
    void openOutside(direct || (/^https?:\/\/localhost[:/]/i.test(own) && (machine.mode === "local" || ownMachine)) ? own : new URL(page, location.href).href).then(
      (ok) => !ok && setPointNote("Couldn't open it in your browser. Copy the address from the bar instead."),
    );
  };

  /**
   * The ways to run the project. The first script is the one the project means for this (dev before start before preview):
   * it is the one primary, at the end of the row; the others are there as plain buttons.
   */
  const starts = (then?: (ok: boolean) => void) => (
    <>
      {options?.static && (
        <button type="button" className="btn ghost small" disabled={!!busy} onClick={() => void start().then(then)}>
          {busy === "start" ? <span className="spinner" /> : <Icon name="file" size={13} />} Serve the folder
        </button>
      )}
      {[...(options?.scripts ?? [])].reverse().map((s, i, all) => (
        <button key={s} type="button" className={`btn small ${i === all.length - 1 ? "primary" : "ghost"}`} disabled={!!busy} onClick={() => void start(s).then(then)}>
          {busy === s ? <span className="spinner" /> : <Icon name="play" size={13} />} npm run {s}
        </button>
      ))}
    </>
  );


  const webBody = (
    <>
      <div className="preview-body">
        {err ? (
          <div className="preview-note">
            <p className="error small">{err}</p>
            <button className="btn ghost small" onClick={() => void look()}>
              Try again
            </button>
          </div>
        ) : (
          <>
            {/* The browser is always here — tabs, the plus, the address bar —
                whether or not the project's server is up: somebody who wants
                another page, or a different address, shouldn't have to wait
                for it. The server's own state is shown inside the empty tab. */}
            <div className="bw-tabs" role="tablist" aria-label="Pages">
              {tabs.map((t, i) => (
                <span key={t.id} className={`bw-tab ${i === at ? "on" : ""}`}>
                  <button type="button" role="tab" aria-selected={i === at} className="bw-tab-name" title={addressOf(t.seen ?? t.url) || "New tab"} onClick={() => setAt(i)}>
                    {label(addressOf(t.seen ?? t.url))}
                  </button>
                  {tabs.length > 1 && (
                    <button type="button" className="bw-tab-x" aria-label={`Close ${label(addressOf(t.seen ?? t.url))}`} onClick={() => closeTab(t.id)}>
                      <Icon name="x" size={10} />
                    </button>
                  )}
                </span>
              ))}
              <button type="button" className="icon-btn tiny" title="New tab" aria-label="New tab" onClick={() => openTab()}>
                <Icon name="plus" size={13} />
              </button>
              {iosHere && <span className="bw-kinds" ref={setKindSlot} />}
            </div>

            <form
              className="browser-bar"
              onSubmit={(e) => {
                e.preventDefault();
                go(typed);
              }}
            >
              <button type="button" className="icon-btn tiny" title="Back" aria-label="Back" onClick={back} disabled={!desktopView}>
                <Icon name="navBack" size={15} />
              </button>
              <button type="button" className="icon-btn tiny" title="Forward" aria-label="Forward" onClick={forward} disabled={!desktopView}>
                <Icon name="navForward" size={15} />
              </button>
              <button type="button" className="icon-btn tiny" title="Reload" aria-label="Reload" onClick={reload}>
                <Icon name="navReload" size={15} />
              </button>
              <button type="button" className={`icon-btn tiny ${pointing ? "on" : ""}`} title={pointing ? "Stop pointing (Esc)" : asNote ? "Leave a note on something in the page" : "Point at something in the page"} aria-label={asNote ? "Leave a note on something in the page" : "Point at something in the page"} aria-pressed={pointing} onClick={() => void point()}>
                <Icon name="navPoint" size={15} />
              </button>
              <input
                className="browser-url"
                value={typed || addressOf(active?.seen ?? shown)}
                spellCheck={false}
                aria-label="Address"
                placeholder="localhost:3000, or a URL"
                onChange={(e) => setTyped(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
              />
              {src && shown !== src && (
                <button type="button" className="icon-btn tiny" title="Back to the project" aria-label="Back to the project" onClick={() => setUrl(src)}>
                  <Icon name="play" size={13} />
                </button>
              )}
              {/* The page's own tools, together at the end of the address bar: what the agent sees, the servers (switch, start,
                  stop), stopping this one, and opening the page in your own browser. */}
              {canShoot && info && (
                <button type="button" className="icon-btn tiny" title="Send a screenshot of this page to the agent" aria-label="Send a screenshot to the agent" onClick={() => void shoot()} disabled={!src || shooting}>
                  <Icon name="eye" size={15} />
                </button>
              )}
              <span className="bw-servers">
                <MenuButton label="Local servers" items={serverMenu} icon="server" className="icon-btn tiny" end width={300} />
                {ours.length > 0 && <i className="bw-servers-n" aria-hidden>{ours.length}</i>}
              </span>
              {info && (
                <button type="button" className="icon-btn tiny" title={`Stop ${info.command}`} aria-label="Stop the preview's server" onClick={() => void stop()} disabled={busy === "stop"}>
                  <Icon name="stop" size={14} />
                </button>
              )}
              <button type="button" className="icon-btn tiny" title="Open in your browser" aria-label="Open in your browser" onClick={openShown} disabled={!shown && !info?.url}>
                <Icon name="external" size={15} />
              </button>
            </form>

            {picked && (
              <form
                className="bw-pin"
                onSubmit={(e) => {
                  e.preventDefault();
                  void sendNote();
                }}
              >
                <label className="bw-pin-label" htmlFor="bw-pin-note">
                  Note on <code>{picked.selector}</code>
                  {picked.text ? <span className="muted"> “{picked.text.slice(0, 60)}”</span> : null}
                </label>
                <textarea
                  id="bw-pin-note"
                  autoFocus
                  rows={2}
                  maxLength={2000}
                  placeholder="What should change here?"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setPicked(null);
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void sendNote();
                  }}
                />
                <div className="bw-pin-actions">
                  <button type="button" className="btn ghost small" onClick={() => setPicked(null)}>
                    Cancel
                  </button>
                  <button type="submit" className="btn primary small" disabled={noting || !note.trim()}>
                    {noting ? "Sending…" : "Send to the driver"}
                  </button>
                </div>
              </form>
            )}
            {pointNote && <p className="bw-note muted small">{pointNote}</p>}

            {/* Every tab stays mounted: a page reloaded each time you glance at
                another one is not a tab, it is a bookmark. */}
            {tabs.map((t, i) => {
              // A tab with nothing to show yet has no page; its place is held by
              // the note below until there is one.
              if (!(t.url || src)) return null;
              // A page that didn't come keeps its frame (folded away, still loading what it is told to) under the note below.
              const place = `preview-frame ${i === at ? (t.down ? "down" : "") : "away"}`;
              return desktopView ? (
                <webview
                  key={t.id}
                  ref={(el: WebviewEl | null) => {
                    if (!el) return;
                    views.current.set(t.id, el);
                    wire(t.id, el);
                  }}
                  className={place}
                  src={t.url || src}
                  // Its own cookie jar, never Friday's, even when the preview is on Friday's address (desktop/main.ts holds every webview to it).
                  partition="persist:preview"
                />
              ) : (
                <iframe
                  key={t.id}
                  ref={(el) => {
                    if (el) frames.current.set(t.id, el);
                    else frames.current.delete(t.id);
                    if (i === at) frame.current = el;
                  }}
                  className={place}
                  src={t.url || src}
                  title="Preview"
                  sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
                  onLoad={(e) => {
                    // Friday's own "Nothing answered" page on this origin can be read; on a preview site of its own it says so once
                    // loaded (the listener above), after this has cleared it.
                    try {
                      patch(t.id, { down: e.currentTarget.contentDocument?.title === NOTHING_ANSWERED });
                    } catch {
                      patch(t.id, { down: false });
                    }
                  }}
                />
              );
            })}

            {active?.down && (
              <div className="preview-note preview-down" role="status">
                <p className="preview-down-title">Nothing is running at {hostOf(addressOf(active.seen ?? (active.url || src)))}</p>
                <p className="muted small">
                  A dev server a coding tool starts can stop when the tool's command ends.{" "}
                  {options?.scripts.length || options?.static ? "Start it here and Friday keeps it running." : "Start it again, then reload."}
                </p>
                <div className="preview-starts">
                  <button type="button" className="btn ghost small" onClick={reload}>
                    <Icon name="refresh" size={13} /> Reload
                  </button>
                  {starts((ok) => ok && setUrl(""))}
                </div>
              </div>
            )}

            {!(active?.url || src) &&
              (
              info ? (
                <div className="preview-note">
                  <p className="muted small">
                    <span className="spinner tiny" /> Starting {info.command}…
                  </p>
                  {/* What the server prints lives in the Tasks list, with the other
                      things that are running; here it was a wall of text over a page
                      that was about to appear. */}
                  {onOutput && (
                    <button type="button" className="link-btn" onClick={onOutput}>
                      See what it's printing in Tasks
                    </button>
                  )}
                </div>
              ) : (
                <div className="preview-note">
                  <p className="muted small">Run this project and watch it here, or type an address above. Friday only starts scripts the project already declares.</p>
                  <div className="preview-starts">
                    {starts()}
                    {options && !options.scripts.length && !options.static && <p className="muted small">No dev/start/preview script in package.json, and no index.html to serve.</p>}
                  </div>
                </div>
              ))}
          </>
        )}
      </div>

      {!direct && src && <p className="preview-foot muted small">Served through Friday from {machine.machine?.name ?? "that machine"}. A dev server with live reload works best opened there directly.</p>}
    </>
  );

  const kinds = iosHere && (
    <div className={`preview-kind ${kind === "web" && kindSlot ? "in-row" : ""}`} role="tablist" aria-label="What to preview">
      <button type="button" role="tab" aria-selected={kind === "web"} className={kind === "web" ? "on" : ""} title="The web page" onClick={() => showKind("web")}>
        <Icon name="globe" size={12} />
        Web
      </button>
      <button type="button" role="tab" aria-selected={kind === "ios"} className={kind === "ios" ? "on" : ""} title="The iOS app, in a simulator" onClick={() => showKind("ios")}>
        <Icon name="phone" size={12} />
        iOS
      </button>
    </div>
  );
  const body = iosHere ? (
    <>
      {kind === "web" && kindSlot ? createPortal(kinds, kindSlot) : <div className="preview-kind-row">{kinds}</div>}
      {kind === "ios" ? <IosPreview identity={identity} cwd={cwd!} {...(iosElsewhere ? { elsewhere: iosElsewhere } : {})} runAsk={iosAsk} shown={onScreen} sid={sid} {...(invite ? { invite } : {})} {...(send ? { send } : {})} /> : webBody}
    </>
  ) : (
    webBody
  );

  if (bare)
    return (
      <>
        {/* No bar above the frame: its buttons are in the address bar, and which command runs it is in the server menu. */}
        {body}
      </>
    );

  return (
    <aside className="doc-panel preview-panel" aria-label="Preview">
      <div className="doc-head">
        <Icon name="play" size={15} />
        <span className="doc-title">Preview</span>
        <span className="doc-actions">
          {info && (
            <>
              <button className="icon-btn tiny" title="Reload" aria-label="Reload preview" onClick={reload} disabled={!src}>
                <Icon name="refresh" size={15} />
              </button>
              <a className="icon-btn tiny" href={info.url} target="_blank" rel="noopener" title={`Open ${info.url} on that machine`} aria-label="Open on that machine">
                <Icon name="external" size={15} />
              </a>
              <button className="icon-btn tiny" title="Stop" aria-label="Stop preview" onClick={() => void stop()} disabled={busy === "stop"}>
                <Icon name="stop" size={14} />
              </button>
            </>
          )}
          <button className="icon-btn tiny" title="Close" aria-label="Close preview" onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        </span>
      </div>

      {body}
    </aside>
  );
}

/**
 * The dev server for this session's folder, kept up to date.
 *
 * For the Tasks list, which shows it beside everything else that is running.
 * Quiet when there is no folder to ask about, and when nothing has been
 * started: the answer is then null and nothing is drawn.
 */
/** How often a quiet machine is asked about its dev server and background tasks: nothing starting, nothing running. */
const IDLE_POLL_MS = 15_000;

export function usePreviewInfo(identity: Identity, cwd: string | null, sid: string | null | undefined, every = 2000): PreviewInfo | null {
  const [info, setInfo] = useState<PreviewInfo | null>(null);
  useEffect(() => {
    const here = !cwd && !!sid;
    if (!cwd && !here) return;
    let live = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      clearTimeout(t);
      let busy = true;
      try {
        const r = here
          ? await api<{ preview: PreviewInfo | null }>(identity, `/api/sessions/${sid}/preview.status`)
          : await hostApi<{ preview: PreviewInfo | null }>(identity, `/api/runner/preview.status?cwd=${encodeURIComponent(cwd ?? "")}`);
        if (live) setInfo(same(r.preview));
        busy = !!r.preview && !r.preview.ready;
      } catch {
        // Asking again in a moment is the whole plan.
      }
      // Often while a server is coming up; once it is up, or there is none, now and then: each look is a round trip through
      // the hosted server to this computer, and an open session asked every few seconds all day. Not while the window is
      // hidden; it asks again when it is shown (below).
      if (live) t = setTimeout(() => !document.hidden && void look(), busy ? every : IDLE_POLL_MS);
    };
    void look();
    // Asked at once when the window is shown again, or when something here started or stopped a server.
    const now = () => !document.hidden && void look();
    document.addEventListener("visibilitychange", now);
    window.addEventListener("friday:preview", now);
    window.addEventListener("friday:preview-started", now);
    return () => {
      live = false;
      clearTimeout(t);
      document.removeEventListener("visibilitychange", now);
      window.removeEventListener("friday:preview", now);
      window.removeEventListener("friday:preview-started", now);
    };
  }, [identity, cwd, sid, every]);
  return info;
}

/** What the agent has left running on the machine, polled the way the dev server is. Empty where there is no machine to ask. */
export interface BackgroundTask {
  id: string;
  command: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  running: boolean;
  stopped?: boolean;
  log: string[];
}

export function useBackgroundTasks(identity: Identity, cwd: string | null, every = 3000): { tasks: BackgroundTask[]; stop: (id: string) => Promise<void> } {
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const look = useCallback(async () => {
    if (!cwd) return;
    try {
      const r = await hostApi<{ tasks: BackgroundTask[] }>(identity, `/api/runner/background.list?cwd=${encodeURIComponent(cwd)}`);
      setTasks(same(r.tasks ?? []));
      return (r.tasks ?? []).some((x) => x.running);
    } catch {
      // A machine that is too old to know, or away: nothing to show, and the next look tries again.
      return false;
    }
  }, [identity, cwd]);
  useEffect(() => {
    if (!cwd) return setTasks([]);
    let live = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    // Often while one is running, now and then when none is (see usePreviewInfo); a hidden window only waits.
    const round = async () => {
      const running = document.hidden ? false : await look();
      if (live) t = setTimeout(() => void round(), running ? every : IDLE_POLL_MS);
    };
    void round();
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [cwd, every, look]);
  const stop = useCallback(
    async (id: string) => {
      if (!cwd) return;
      try {
        await hostApi(identity, "/api/runner/background.stop", { method: "POST", body: JSON.stringify({ cwd, id }) });
      } finally {
        await look();
      }
    },
    [identity, cwd, look],
  );
  return { tasks, stop };
}
