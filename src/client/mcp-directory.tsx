import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ConnectionView } from "../runner/connections.js";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon, type IconName } from "./icons.js";
import { hostApi } from "./local.js";
import { CATEGORIES, MCP_CATALOG, type CatalogEntry, type Category } from "./mcp-catalog.js";
import { openOutside } from "./openOutside.js";
import type { Identity } from "./storage.js";

/**
 * The directory of services on the MCP servers page (Arun, 2026-11-17: "i want to add support for all of these btw.... like what
 * we had before... gmail, slack, github, linear, figma, stripe, etc, go all out for this"): the hosted edition's catalogue
 * (mcp-catalog.ts, every address checked with a real MCP handshake), connected from this computer for every coding tool here.
 *
 * - Most sign in with OAuth: the provider's page opens in the browser and comes back to this Friday (runner/connections.ts
 *   startSignin, app.ts /api/mcp/signed-in); the page follows until it's back.
 * - A few won't let an app register itself (Google, Slack, GitHub, HubSpot, Box, Zendesk, PagerDuty): the person registers
 *   one, in a few steps said here with the address to give it, and signs in with that. GitHub takes a personal access token too.
 * - A few take a key, and a few run on this computer (Figma's desktop server): their address can be changed.
 */

/** Where to register an app of your own, for a provider that won't register Friday by itself. */
const OWN_APP: Record<string, { where: string; how: string }> = {
  GOOGLE: { where: "https://console.cloud.google.com/apis/credentials", how: "Create an OAuth client ID of type Web application, add the address below as an authorised redirect URI, and turn on the Gmail or Calendar API for the project." },
  SLACK: { where: "https://api.slack.com/apps", how: "Create an app, add the address below under OAuth & Permissions as a redirect URL, then copy its client ID and secret from Basic Information." },
  GITHUB: { where: "https://github.com/settings/developers", how: "Make a new OAuth App with the address below as its callback URL. Or paste a personal access token instead, below." },
  HUBSPOT: { where: "https://developers.hubspot.com/", how: "Create an app, add the address below as a redirect URL, and copy its client ID and secret." },
  BOX: { where: "https://app.box.com/developers/console", how: "Create a Custom App using OAuth 2.0 with the address below as its redirect URI." },
  ZENDESK: { where: "https://support.zendesk.com/hc/en-us/articles/4408845965210", how: "In Admin Center, under Apps and integrations, add an OAuth client with the address below as its redirect URL." },
  PAGERDUTY: { where: "https://developer.pagerduty.com/", how: "Register an OAuth app with the address below as its redirect URL." },
};

const trim = (u: string) => u.replace(/\/+$/, "");
/** The server from a directory entry, when it's here: by the entry it came from, or its address. */
export const serverFor = (e: CatalogEntry, servers: ConnectionView[]) => servers.find((s) => s.catalog === e.id) ?? servers.find((s) => s.url && trim(s.url) === trim(e.url));

/** The service's own mark: its logo from its own site, the drawn mark until that loads or when it won't. */
export function ServiceMark({ entry, size = 20 }: { entry: CatalogEntry; size?: number }) {
  const sources = useMemo(() => [...(entry.logo ? [entry.logo] : []), ...(entry.domain ? [`https://${entry.domain}/favicon.ico`, `https://www.google.com/s2/favicons?domain=${entry.domain}&sz=64`] : [])], [entry]);
  const [step, setStep] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const src = sources[step];
  return (
    <span className="mdir-mark" style={{ width: size + 14, height: size + 14 }}>
      {(!src || !loaded) && <Icon name={entry.mark} size={size - 2} />}
      {src && (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          referrerPolicy="no-referrer"
          className={`${entry.invertLogo ? "mdir-invert" : ""}${loaded ? " loaded" : ""}`}
          onLoad={() => setLoaded(true)}
          onError={() => (setLoaded(false), setStep((n) => n + 1))}
        />
      )}
    </span>
  );
}

type Phase = { kind: "idle" } | { kind: "waiting"; url: string; since: number } | { kind: "busy" } | { kind: "error"; text: string };

/** One service's sheet: sign in, an app of your own, a key, or an address; and how it went. */
function ServiceSheet({ identity, entry, servers, builtIn, onClose, onChanged }: { identity: Identity; entry: CatalogEntry; servers: ConnectionView[]; /** Friday has its own app with this provider: one click, an app of one's own folded away. */ builtIn: boolean; onClose: () => void; onChanged: () => Promise<ConnectionView[]> }) {
  const here = serverFor(entry, servers);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [token, setToken] = useState("");
  const [url, setUrl] = useState(entry.url);
  const [copied, setCopied] = useState(false);
  const redirect = `${location.origin}/api/mcp/signed-in`;
  const [useOwn, setUseOwn] = useState(false);
  const own = entry.needsClient && (!builtIn || useOwn) ? OWN_APP[entry.needsClient] : undefined;
  const waitingFor = useRef(0);
  /** Connected, and asked to sign in or give its key again: the way in shows under what it has. */
  const [redo, setRedo] = useState(false);

  // While its sign-in is open in the browser, the list is read every two seconds until the server is back, for five minutes.
  useEffect(() => {
    if (phase.kind !== "waiting") return;
    const since = phase.since;
    waitingFor.current = since;
    const t = setInterval(async () => {
      const list = await onChanged().catch(() => null);
      const s = list && serverFor(entry, list);
      if (s?.status && s.status.at >= since) {
        clearInterval(t);
        if (s.status.ok) setRedo(false);
        setPhase(s.status.ok ? { kind: "idle" } : { kind: "error", text: s.status.error ?? "It didn't answer after signing in." });
      }
      if (Date.now() - since > 5 * 60_000) (clearInterval(t), setPhase({ kind: "error", text: "The sign-in didn't come back. Start it again." }));
    }, 2000);
    return () => clearInterval(t);
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const post = <T,>(op: string, body: unknown) => hostApi<T>(identity, `/api/runner/${op}`, { method: "POST", body: JSON.stringify(body) });
  const signIn = async (client?: { id: string; secret: string }) => {
    setPhase({ kind: "busy" });
    try {
      const r = await post<{ authorizeUrl: string }>("connections.signin", { url: entry.url, name: entry.id, catalog: entry.id, ...(here ? { id: here.id } : {}), ...(client ? { clientId: client.id, clientSecret: client.secret } : {}) });
      void openOutside(r.authorizeUrl);
      setPhase({ kind: "waiting", url: r.authorizeUrl, since: Date.now() });
    } catch (e) {
      setPhase({ kind: "error", text: (e as Error).message });
    }
  };
  /** Added with a key, or with nothing (a server on this computer), as a remote server. */
  const addDirect = async (key?: string) => {
    setPhase({ kind: "busy" });
    try {
      const transport = /\/sse\/?(\?|$)/i.test(url) ? "sse" : "http";
      if (here) await post("connections.remove", { id: here.id });
      const r = await post<{ server: ConnectionView }>("connections.add", { draft: { name: entry.id, transport, url: url.trim(), ...(key ? { headers: { Authorization: `Bearer ${key.trim()}` } } : {}), needs: [], catalog: entry.id }, values: {} });
      await onChanged();
      if (r.server.status?.ok) setRedo(false);
      setPhase(r.server.status?.ok ? { kind: "idle" } : { kind: "error", text: r.server.status?.error ?? "It didn't answer." });
    } catch (e) {
      setPhase({ kind: "error", text: (e as Error).message });
    }
  };

  const st = here?.status;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="mdir-sheet sm:max-w-[480px]">
        <DialogHeader>
          <div className="mdir-sheet-head">
            <ServiceMark entry={entry} size={26} />
            <div>
              <DialogTitle>{entry.name}</DialogTitle>
              <DialogDescription>{entry.blurb}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {here && (
          <Manage
            identity={identity}
            server={here}
            name={entry.name}
            onChanged={onChanged}
            onGone={onClose}
            again={st?.ok && !redo && phase.kind !== "waiting" ? { label: entry.auth === "oauth" && !entry.local ? "Sign in again" : entry.auth === "token" ? "Change its key" : "Connect again", run: () => (entry.auth === "oauth" && !entry.local ? void signIn() : setRedo(true)) } : undefined}
          />
        )}

        {here && st?.ok && !redo && phase.kind !== "waiting" ? null : phase.kind === "waiting" ? (
          <div className="mdir-wait" role="status">
            <span className="spinner tiny" aria-hidden /> Finish signing in to {entry.name} in your browser. This updates by itself.
            <button type="button" className="link-btn" onClick={() => void openOutside(phase.url)}>
              Open it again
            </button>
          </div>
        ) : entry.local ? (
          <form
            className="mdir-form"
            onSubmit={(e) => {
              e.preventDefault();
              void addDirect(token || undefined);
            }}
          >
            <p className="mdir-note">It runs on this computer: start it first, then connect.</p>
            <label className="mdir-field">
              <span>Address</span>
              <input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
            </label>
            {entry.auth === "token" && (
              <label className="mdir-field">
                <span>Key{entry.tokenOptional ? " (optional)" : ""}</span>
                <input type="password" autoComplete="off" value={token} placeholder={entry.tokenHint ?? "Paste its key"} onChange={(e) => setToken(e.target.value)} />
              </label>
            )}
            <Button type="submit" disabled={phase.kind === "busy" || !url.trim()}>
              {phase.kind === "busy" ? "Connecting…" : here ? "Connect again" : "Connect"}
            </Button>
          </form>
        ) : entry.auth === "token" ? (
          <form
            className="mdir-form"
            onSubmit={(e) => {
              e.preventDefault();
              void addDirect(token || undefined);
            }}
          >
            <label className="mdir-field">
              <span>Key{entry.tokenOptional ? " (optional)" : ""}</span>
              <input type="password" autoComplete="off" value={token} placeholder="Paste its key" onChange={(e) => setToken(e.target.value)} />
            </label>
            {entry.tokenHint && <p className="mdir-note">{entry.tokenHint}</p>}
            <Button type="submit" disabled={phase.kind === "busy" || (!entry.tokenOptional && !token.trim())}>
              {phase.kind === "busy" ? "Connecting…" : here ? "Connect again" : "Connect"}
            </Button>
          </form>
        ) : entry.auth === "none" ? (
          <Button disabled={phase.kind === "busy"} onClick={() => void addDirect()}>
            {phase.kind === "busy" ? "Connecting…" : here ? "Connect again" : "Connect"}
          </Button>
        ) : own ? (
          <form
            className="mdir-form"
            onSubmit={(e) => {
              e.preventDefault();
              void signIn({ id: clientId.trim(), secret: secret.trim() });
            }}
          >
            <p className="mdir-note">
              {entry.name} doesn't let apps register themselves, so it signs in with an app of yours.{" "}
              <button type="button" className="link-btn" onClick={() => void openOutside(own.where)}>
                Register one
              </button>
              : {own.how}
            </p>
            <label className="mdir-field">
              <span>Redirect address</span>
              <span className="mdir-copy">
                <code>{redirect}</code>
                <button type="button" className="link-btn" onClick={() => void navigator.clipboard?.writeText(redirect).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </span>
            </label>
            <label className="mdir-field">
              <span>Client ID</span>
              <input value={clientId} autoComplete="off" spellCheck={false} onChange={(e) => setClientId(e.target.value)} />
            </label>
            <label className="mdir-field">
              <span>Client secret</span>
              <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
            </label>
            <Button type="submit" disabled={phase.kind === "busy" || !clientId.trim()}>
              {phase.kind === "busy" ? "Opening…" : `Sign in to ${entry.name}`}
            </Button>
            {entry.needsClient === "GITHUB" && (
              <div className="mdir-or">
                <span>Or a personal access token</span>
                <span className="mdir-copy">
                  <input type="password" autoComplete="off" placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} />
                  <Button type="button" variant="outline" size="sm" disabled={!token.trim() || phase.kind === "busy"} onClick={() => void addDirect(token)}>
                    Connect
                  </Button>
                </span>
              </div>
            )}
          </form>
        ) : (
          <div className="mdir-form">
            {entry.localhostOnly && <p className="mdir-note">{entry.name} signs in apps that run on your own computer, as Friday does here.</p>}
            <Button disabled={phase.kind === "busy"} onClick={() => void signIn()}>
              {phase.kind === "busy" ? "Opening…" : here?.signedIn ? `Sign in to ${entry.name} again` : `Sign in to ${entry.name}`}
            </Button>
            {entry.needsClient && builtIn && (
              <button type="button" className="link-btn mdir-more" onClick={() => setUseOwn(true)}>
                Use an app of your own instead
              </button>
            )}
          </div>
        )}

        {phase.kind === "error" && phase.text !== st?.error && (
          <p className="mdir-state bad" role="alert">
            {phase.text}
          </p>
        )}
        <p className="mdir-foot">Every coding tool here gets it on its next turn. Its sign-in stays on this computer, in a file only you can read.</p>
      </DialogContent>
    </Dialog>
  );
}

/** What a server runs, in a line: the command and its arguments, or the address. */
export const lineOf = (s: Pick<ConnectionView, "transport" | "command" | "args" | "url">) => (s.transport === "stdio" ? [s.command, ...(s.args ?? [])].join(" ") : (s.url ?? ""));

/**
 * What a connected server has, and the ways to manage it, at the top of its sheet (Arun, 2026-11-17: "also add ability to
 * disconnect/manage and stuff"): its state and On for every tool, its tools folded to a line, Test again, the way back in
 * (sign in again, a new key), and Disconnect with a confirm in place.
 */
function Manage({ identity, server, name, again, onChanged, onGone }: { identity: Identity; server: ConnectionView; name: string; /** Signing in again, or a new key: what this kind of server takes. */ again?: { label: string; run: () => void }; onChanged: () => Promise<ConnectionView[]>; onGone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);
  const [allTools, setAllTools] = useState(false);
  const run = async (op: "connections.update" | "connections.test" | "connections.remove", body: Record<string, unknown> = {}) => {
    setBusy(true);
    setErr("");
    try {
      await hostApi(identity, `/api/runner/${op}`, { method: "POST", body: JSON.stringify({ id: server.id, ...body }) });
      await onChanged();
      if (op === "connections.remove") onGone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const st = server.status;
  const names = st?.ok ? (st.names ?? []) : [];
  return (
    <div className="mdir-manage">
      <div className="mdir-manage-top">
        <span className={`mdir-pill ${!st ? "" : st.ok && server.enabled ? "on" : st.ok ? "off" : "bad"}`}>
          <i aria-hidden="true" />
          {!st ? "Not tested yet" : st.ok ? `${server.enabled ? "Connected" : "Off"}${names.length ? "" : ` · ${st.tools} tool${st.tools === 1 ? "" : "s"}`}${server.signedIn ? " · signed in" : ""}` : st.kind === "auth" ? "Key refused" : st.kind === "signin" ? "Needs sign-in" : "Didn't answer"}
        </span>
        <label className="mdir-toggle">
          <span>On for every tool</span>
          <Switch aria-label={`${name}: on for every tool`} checked={server.enabled} disabled={busy} onCheckedChange={(on) => void run("connections.update", { enabled: on })} />
        </label>
      </div>
      {st && !st.ok && st.error && <p className="mdir-why">{st.error}</p>}
      {names.length > 0 && (
        <div className="mdir-tools">
          <button type="button" className="mdir-tools-line" aria-expanded={allTools} onClick={() => setAllTools((v) => !v)}>
            <Icon name="wrench" size={13} />
            <span className="mdir-tools-sum">
              <b>
                {names.length} tool{names.length === 1 ? "" : "s"}
              </b>
              {!allTools && <span> · {names.slice(0, 3).map(toolWords).join(", ")}{names.length > 3 ? ` and ${names.length - 3} more` : ""}</span>}
            </span>
            <span className="mdir-tools-more">{allTools ? "Hide" : "Show all"}</span>
            <Icon name={allTools ? "chevronUp" : "chevronDown"} size={13} />
          </button>
          {allTools && (
            <ul className="mdir-tools-list" aria-label="Its tools">
              {names.map((n) => (
                <li key={n} title={n}>
                  {toolWords(n)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {/* Disconnecting asks first, in a panel of its own in the actions' place: the question, what it does, then Keep or Disconnect
          (Arun, 2026-11-17: "design the disconnect mcp confirmation layout better"). */}
      {confirmOff ? (
        <div className="mdir-confirm" role="group" aria-labelledby={`mdir-off-${server.id}`}>
          <div className="mdir-confirm-text">
            <b id={`mdir-off-${server.id}`}>Disconnect {name}?</b>
            <span>It comes off every coding tool here, and its key or sign-in is deleted from this computer.</span>
          </div>
          <div className="mdir-confirm-acts">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirmOff(false)}>
              Keep
            </Button>
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => void run("connections.remove")}>
              {busy ? "Disconnecting…" : "Disconnect"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mdir-manage-acts">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void run("connections.test")}>
            <Icon name="refresh" size={13} /> {busy ? "Checking…" : "Test again"}
          </Button>
          {again && (
            <Button variant="outline" size="sm" disabled={busy} onClick={again.run}>
              {again.label}
            </Button>
          )}
          <span className="mdir-grow" />
          <Button variant="ghost" size="sm" className="mdir-danger" disabled={busy} onClick={() => setConfirmOff(true)}>
            Disconnect
          </Button>
        </div>
      )}
      {err && (
        <p className="mdir-state bad" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

/** A server of one's own, added from Custom server: what it runs, managed as a service is, its keys changed here. */
function OwnSheet({ identity, server, onClose, onChanged }: { identity: Identity; server: ConnectionView; onClose: () => void; onChanged: () => Promise<ConnectionView[]> }) {
  const [fixing, setFixing] = useState(false);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const hasKeys = server.envKeys.length + server.headerKeys.length > 0;
  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      const env = Object.fromEntries(server.envKeys.map((k) => [k, keys[`env:${k}`] ?? ""]).filter(([, v]) => v.trim()));
      const headers = Object.fromEntries(server.headerKeys.map((k) => [k, keys[`header:${k}`] ?? ""]).filter(([, v]) => v.trim()));
      await hostApi(identity, "/api/runner/connections.update", { method: "POST", body: JSON.stringify({ id: server.id, env, headers, enabled: true }) });
      await onChanged();
      setFixing(false);
      setKeys({});
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="mdir-sheet sm:max-w-[480px]">
        <DialogHeader>
          <div className="mdir-sheet-head">
            <span className="mdir-mark mdir-own" style={{ width: 40, height: 40 }} aria-hidden="true">
              <Icon name={server.transport === "stdio" ? "terminal" : "link"} size={20} />
            </span>
            <div className="min-w-0">
              <DialogTitle>{server.name}</DialogTitle>
              <DialogDescription className="mdir-own-line" title={lineOf(server)}>
                {lineOf(server)}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <Manage identity={identity} server={server} name={server.name} onChanged={onChanged} onGone={onClose} again={hasKeys && !fixing ? { label: server.status?.kind === "auth" ? "Fix its keys" : "Change its keys", run: () => setFixing(true) } : undefined} />
        {fixing && (
          <form
            className="mdir-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {[...server.envKeys.map((k) => ["env", k] as const), ...server.headerKeys.map((k) => ["header", k] as const)].map(([w, k]) => (
              <label key={`${w}:${k}`} className="mdir-field">
                <span>
                  {k}
                  {w === "header" ? " (header)" : ""}
                </span>
                <input type="password" autoComplete="off" placeholder="New value, or leave it as it is" value={keys[`${w}:${k}`] ?? ""} onChange={(e) => setKeys((x) => ({ ...x, [`${w}:${k}`]: e.target.value }))} />
              </label>
            ))}
            <span className="mdir-manage-acts">
              <Button type="submit" size="sm" disabled={busy || !Object.values(keys).some((v) => v.trim())}>
                {busy ? "Testing…" : "Save and test"}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => (setFixing(false), setKeys({}))}>
                Cancel
              </Button>
            </span>
            {err && (
              <p className="mdir-state bad" role="alert">
                {err}
              </p>
            )}
          </form>
        )}
        <p className="mdir-foot">Every coding tool here gets it on its next turn. Its keys stay on this computer, in a file only you can read.</p>
      </DialogContent>
    </Dialog>
  );
}

/** A tool's name in words: create_draft is "Create draft", hub_repo_search "Hub repo search". */
const toolWords = (n: string) => {
  const w = n.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
};

/**
 * Services left out of this computer's directory for now, because none of them can be used from here yet (Arun, 2026-11-17:
 * "disable all of the google ones for now.... on the app and get rid of the ones we cannot use right now"): Google's Gmail,
 * Calendar and Chat servers answer calls only for Cloud projects in its Workspace Developer Preview; Calendly signs in only apps
 * at an https address; Similarweb's firewall refuses Friday. One already connected still shows, so it can be turned off or
 * removed. The hosted edition's catalogue keeps them.
 */
const NOT_HERE_YET = new Set(["gmail", "google-calendar", "google-chat", "calendly", "similarweb"]);

/** Each kind's icon in the filters. */
const KIND_ICON: Record<Category, IconName> = {
  "Files and docs": "folder",
  "Email and calendar": "mail",
  "Chat and meetings": "message",
  "Issues and projects": "kanban",
  "Sales and support": "headset",
  "Design and content": "image",
  "Code and docs": "code",
  "Data and money": "chart",
  Infrastructure: "server",
};

/** How a service connects, in a word for its row: what pressing it will ask. */
function howWord(e: CatalogEntry, builtIn: boolean): string {
  if (e.local) return "Runs here";
  if (e.auth === "token") return e.tokenOptional ? "Optional key" : "Key";
  if (e.auth === "none") return "Connect";
  return e.needsClient && !builtIn ? "Your app" : "Sign in";
}

/**
 * The directory (Arun, 2026-11-17: "redesign this better please..... looks too much, like better filters, layout and everythign....
 * also show all of them and add better design details too"): every service, grouped by kind, as cards (its logo, name, what it
 * does in two lines, and how it connects, or, connected, its state and a way to manage it: "also add ability to disconnect/manage
 * and stuff..... i want these to be like cards"), with the kinds down the left to filter by, each with its count, the ones
 * connected first, and a search over all of them.
 */
export function Directory({ identity, servers, builtInApps, actions, onChanged }: { identity: Identity; servers: ConnectionView[]; /** The providers Friday signs in to with its own app (runner/builtin-apps.ts). */ builtInApps: string[]; /** Beside the search: the Claude Code switch and Custom server (McpServers.tsx). */ actions?: ReactNode; onChanged: () => Promise<ConnectionView[]> }) {
  const [q, setQ] = useState("");
  const [picked, setKind] = useState<Category | "" | "connected">("");
  const [open, setOpen] = useState<CatalogEntry | null>(null);
  const [openOwn, setOpenOwn] = useState("");
  const needle = q.trim().toLowerCase();
  const stateOf = (e: CatalogEntry) => {
    const s = serverFor(e, servers);
    return !s ? "" : s.status?.ok && s.enabled ? "on" : s.status && !s.status.ok ? "bad" : "off";
  };
  // Its name, what it does, its kind, and its address, so "google" finds Gmail.
  const matches = (e: CatalogEntry) => !needle || `${e.name} ${e.blurb} ${e.category} ${e.url ?? ""}`.toLowerCase().includes(needle);
  const catalog = MCP_CATALOG.filter((e) => !NOT_HERE_YET.has(e.id) || serverFor(e, servers));
  const connected = catalog.filter((e) => stateOf(e));
  // Servers of one's own (Custom server): none of the directory's. Shown first, as cards of their own.
  const own = servers.filter((s) => !MCP_CATALOG.some((e) => serverFor(e, [s])));
  // The last one disconnected while looking at the connected ones: back to all of them.
  const kind = picked === "connected" && !connected.length && !own.length ? "" : picked;
  const ownShown = kind === "" || kind === "connected" ? own.filter((s) => !needle || `${s.name} ${lineOf(s)}`.toLowerCase().includes(needle)) : [];
  const ownOpen = own.find((s) => s.id === openOwn);
  const groups: { title: string; list: CatalogEntry[] }[] =
    kind === "connected"
      ? [{ title: "Connected", list: connected.filter(matches) }]
      : (kind ? [kind] : CATEGORIES).map((c) => ({ title: c, list: catalog.filter((e) => e.category === c && matches(e)) }));
  const shownCount = groups.reduce((n, g) => n + g.list.length, 0) + ownShown.length;
  const ownCard = (s: ConnectionView) => {
    const state = s.status?.ok && s.enabled ? "on" : s.status && !s.status.ok ? "bad" : "off";
    return (
      <li key={s.id}>
        <button type="button" className={`mdir-card is-${state}`} onClick={() => setOpenOwn(s.id)} aria-label={`${s.name}: ${state === "on" ? "connected" : state === "bad" ? "needs you" : "off"}, manage`}>
          <span className="mdir-card-top">
            <span className="mdir-mark mdir-own" style={{ width: 34, height: 34 }} aria-hidden="true">
              <Icon name={s.transport === "stdio" ? "terminal" : "link"} size={17} />
            </span>
            <span className={`mdir-how ${state}`}>
              <i aria-hidden="true" />
              {state === "on" ? "Connected" : state === "bad" ? "Needs you" : "Off"}
            </span>
          </span>
          <span className="mdir-name">{s.name}</span>
          <span className="mdir-blurb mdir-own-line">{lineOf(s)}</span>
          <span className="mdir-manage-hint">
            Manage <Icon name="chevronRight" size={12} />
          </span>
        </button>
      </li>
    );
  };
  const row = (e: CatalogEntry) => {
    const state = stateOf(e);
    const builtIn = !!e.needsClient && builtInApps.includes(e.needsClient);
    return (
      <li key={e.id}>
        <button type="button" className={`mdir-card${state ? ` is-${state}` : ""}`} onClick={() => setOpen(e)} aria-label={`${e.name}: ${state === "on" ? "connected, manage" : state === "bad" ? "needs you" : state === "off" ? "off, manage" : howWord(e, builtIn).toLowerCase()}`}>
          <span className="mdir-card-top">
            <ServiceMark entry={e} size={20} />
            {state ? (
              <span className={`mdir-how ${state}`}>
                <i aria-hidden="true" />
                {state === "on" ? "Connected" : state === "bad" ? "Needs you" : "Off"}
              </span>
            ) : (
              <span className="mdir-how">{howWord(e, builtIn)}</span>
            )}
          </span>
          <span className="mdir-name">{e.name}</span>
          <span className="mdir-blurb">{e.blurb}</span>
          {state && (
            <span className="mdir-manage-hint">
              Manage <Icon name="chevronRight" size={12} />
            </span>
          )}
        </button>
      </li>
    );
  };
  const filter = (id: Category | "" | "connected", label: string, n: number) => (
    <button key={id || "all"} type="button" className={`mdir-filter${n ? "" : " none"}`} aria-pressed={kind === id} onClick={() => setKind(id)}>
      <Icon name={id === "" ? "grid" : id === "connected" ? "plug" : KIND_ICON[id]} size={14} />
      <span>{label}</span>
      <span className="mdir-count">{n}</span>
    </button>
  );
  return (
    <section className="mdir" aria-label="Connect a service">
      <div className="mdir-head">
        <h2 className="msv-h2">
          Connect a service <span>{catalog.length}</span>
        </h2>
        <div className="mdir-head-acts">
          {actions}
          <label className="mdir-search">
            <Icon name="search" size={14} />
            <input type="search" placeholder="Search services" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search services" />
          </label>
        </div>
      </div>
      <div className="mdir-body">
        <nav className="mdir-filters" aria-label="Kinds of service">
          {filter("", "All", catalog.filter(matches).length)}
          {connected.length + own.length > 0 && filter("connected", "Connected", connected.filter(matches).length + own.filter((s) => !needle || `${s.name} ${lineOf(s)}`.toLowerCase().includes(needle)).length)}
          <span className="mdir-sep" aria-hidden="true" />
          {CATEGORIES.filter((c) => catalog.some((e) => e.category === c)).map((c) => filter(c, c, catalog.filter((e) => e.category === c && matches(e)).length))}
        </nav>
        <div className="mdir-list">
          {ownShown.length > 0 && (
            <section className="mdir-group" aria-label="Your own servers">
              <h3 className="mdir-group-head">
                <Icon name="server" size={15} />
                Your own <span>{ownShown.length}</span>
              </h3>
              <ul className="mdir-cards">{ownShown.map(ownCard)}</ul>
            </section>
          )}
          {groups
            .filter((g) => g.list.length)
            .map((g) => (
              <section key={g.title} className="mdir-group" aria-label={g.title}>
                {(groups.length > 1 || kind === "connected") && (
                  <h3 className="mdir-group-head">
                    <Icon name={g.title === "Connected" ? "plug" : KIND_ICON[g.title as Category]} size={15} />
                    {g.title} <span>{g.list.length}</span>
                  </h3>
                )}
                <ul className="mdir-cards">{g.list.map(row)}</ul>
              </section>
            ))}
          {!shownCount && <p className="mdir-empty">No service matches “{q.trim()}”. Paste its address or command below instead.</p>}
        </div>
      </div>
      {ownOpen && <OwnSheet identity={identity} server={ownOpen} onClose={() => setOpenOwn("")} onChanged={onChanged} />}
      {open && <ServiceSheet identity={identity} entry={open} servers={servers} builtIn={!!open.needsClient && builtInApps.includes(open.needsClient)} onClose={() => setOpen(null)} onChanged={onChanged} />}
    </section>
  );
}
