import { useEffect, useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Note, SettingsGroup, SettingsRow, StateBadge } from "@/components/dass";
import { api } from "./api.js";
import { LinearMark, SlackMark } from "./BrandMarks.js";
import { Icon } from "./icons.js";
import type { Identity } from "./storage.js";
import { Picker, SkeletonRows, Switch, relTime } from "./ui.js";

/**
 * Settings › Integrations (spec 08): Friday in Slack and in Linear, each a card with its mark, what it does, whether it's
 * connected and its one action; then, connected, who you are there and where each channel's or team's work goes. Linear is one
 * button when the build has Friday's own Linear app (builtin-apps.ts), with an app of your own as the way round it. Everything
 * secret stays on this computer (channels/config.ts); the page only hears what to show.
 */

type SlackStatus = { connected: boolean; state: "off" | "connecting" | "on"; team?: string; me: { id: string; name: string } | null; dms: boolean; error?: string; channels?: { id: string; folder: string; name?: string }[] };
type LinearStatus = { connected: boolean; clientId?: string; org?: string; urlKey?: string; app?: string; me: { id: string; name: string } | null; error?: string; teams?: { id: string; folder: string; name?: string }[]; builtIn: boolean; usingBuiltIn?: boolean; checkedAt?: number };
type Person = { id: string; name: string; email?: string };

const CALLBACK = "http://localhost:47841/linear/callback";
const NEW_APP = "https://linear.app/settings/api/applications/new";

const H = { "x-friday-local": "1" };
const open = (url: string) => (window.fridayDesktop?.openExternal ? void window.fridayDesktop.openExternal(url) : void window.open(url, "_blank", "noopener"));
const pickFolder = () => (window as { fridayDesktop?: { pickFolder?: () => Promise<string | null> } }).fridayDesktop?.pickFolder?.() ?? Promise.resolve(null);
const short = (folder: string) => folder.replace(/^\/(Users|home)\/[^/]+/, "~");
const base = (folder: string) => folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder;

/** A value to paste somewhere else, with a copy button. */
function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <SettingsRow label={label}>
      <div className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 max-w-[340px] truncate rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-[12px]">{value}</code>
        <Button variant="ghost" size="sm" aria-label={`Copy ${label}`} onClick={() => void navigator.clipboard.writeText(value).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1400)))}>
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
        </Button>
      </div>
    </SettingsRow>
  );
}

/** An integration's head: its mark, its name and one line, whether it's connected, and its action. */
function Head({ mark, name, line, state, children }: { mark: ReactNode; name: string; line: ReactNode; state: { tone?: "live" | "needs" | "danger"; text: string }; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3.5 py-4 max-sm:flex-wrap" data-set-row="">
      <span className="grid size-10 shrink-0 place-items-center rounded-[10px] border border-[var(--border)] bg-[var(--card)]" aria-hidden>
        {mark}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="m-0 text-[14px] font-semibold text-[var(--ink)]">{name}</h3>
          <StateBadge {...(state.tone ? { tone: state.tone } : {})}>{state.text}</StateBadge>
        </div>
        <div className="mt-0.5 text-[13px] leading-snug text-[var(--text-muted)]">{line}</div>
      </div>
      {children && <div className="flex shrink-0 items-center gap-2 max-sm:w-full max-sm:justify-end">{children}</div>}
    </div>
  );
}

/** What an integration does, three short lines with a tick each, under its head while it isn't connected. */
function Does({ items }: { items: string[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 py-3.5 pl-0" data-set-row="">
      {items.map((t) => (
        <li key={t} className="flex items-start gap-2 text-[13px] leading-snug text-[var(--ink-2)]">
          <Icon name="check" size={14} className="mt-[2px] shrink-0 text-[var(--text-muted)]" />
          {t}
        </li>
      ))}
    </ul>
  );
}

/** A POST to one of the integration routes, with its busy flag and error. */
function usePost(identity: Identity) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const post = async (path: string, body: Record<string, unknown>) => {
    setBusy(true);
    setErr("");
    try {
      return await api<Record<string, unknown>>(identity, path, { method: "POST", headers: H, body: JSON.stringify(body) });
    } catch (e) {
      setErr((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, post, setErr };
}

function usePeople(identity: Identity, path: string, on: boolean) {
  const [people, setPeople] = useState<Person[] | null>(null);
  useEffect(() => {
    if (!on) return;
    api<{ people: Person[] }>(identity, path, { headers: H })
      .then((r) => setPeople(r.people))
      .catch(() => setPeople([]));
  }, [on]);
  return people;
}

export function ChannelsSection({ identity }: { identity: Identity }) {
  const [linear, setLinear] = useState<LinearStatus | null>(null);
  const [slack, setSlack] = useState<SlackStatus | null>(null);
  const [newApp, setNewApp] = useState("");
  const [failed, setFailed] = useState("");
  const load = () =>
    api<{ linear: LinearStatus; slack: SlackStatus; slackNewApp: string }>(identity, "/api/channels", { headers: H })
      .then((r) => (setLinear(r.linear), setSlack(r.slack), setNewApp(r.slackNewApp), setFailed("")))
      .catch((e: Error) => setFailed(e.message));
  useEffect(() => {
    void load();
  }, []);
  // Slack's connection comes up a moment after connecting: read again while it is on its way.
  useEffect(() => {
    if (slack?.connected && slack.state !== "on") {
      const t = setTimeout(() => void load(), 1500);
      return () => clearTimeout(t);
    }
  }, [slack?.connected, slack?.state]);
  if (failed && !linear) return <Note ok={false}>{failed}</Note>;
  if (!linear || !slack) return <SkeletonRows rows={6} />;
  return (
    <section className="flex flex-col gap-5">
      <LinearCard identity={identity} status={linear} onChange={setLinear} reload={load} />
      <SlackCard identity={identity} status={slack} newApp={newApp} onChange={setSlack} />
      <p className="m-0 text-[12.5px] leading-snug text-[var(--text-muted)]">
        Both work while Friday is open on this computer. Tokens stay here, and only your own asks start work straight away: anyone else's waits for you to send it on.
      </p>
    </section>
  );
}

// ── Linear ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

function LinearCard({ identity, status, onChange, reload }: { identity: Identity; status: LinearStatus; onChange: (s: LinearStatus) => void; reload: () => Promise<unknown> }) {
  const [clientId, setClientId] = useState(status.usingBuiltIn ? "" : (status.clientId ?? ""));
  const [secret, setSecret] = useState("");
  const [own, setOwn] = useState(!status.builtIn);
  const [waiting, setWaiting] = useState(false);
  const { busy, err, post } = usePost(identity);
  const people = usePeople(identity, "/api/channels/linear/people", status.connected);
  const got = (r: Record<string, unknown> | null) => r?.linear && onChange(r.linear as LinearStatus);

  // Waiting on Install in Linear: read again until it's connected, or for two minutes.
  useEffect(() => {
    if (!waiting) return;
    const until = Date.now() + 120_000;
    const t = setInterval(() => (Date.now() > until ? setWaiting(false) : void reload()), 2000);
    return () => clearInterval(t);
  }, [waiting]);
  useEffect(() => {
    if (status.connected) setWaiting(false);
  }, [status.connected]);

  const connect = async (body: Record<string, unknown>) => {
    const r = await post("/api/channels/linear/connect", body);
    if (r?.url) {
      open(String(r.url));
      setWaiting(true);
    }
  };
  const mark = <LinearMark size={20} />;

  if (!status.connected) {
    return (
      <SettingsGroup>
        <Head mark={mark} name="Linear" line="Assign issues to Friday, or mention it. The work runs here, on your coding tools." state={{ text: waiting ? "Waiting for Linear" : "Not connected" }}>
          {status.builtIn && !own && (
            <Button size="sm" disabled={busy} onClick={() => void connect({})}>
              {waiting ? "Waiting…" : "Connect Linear"}
            </Button>
          )}
        </Head>
        <Does items={["Friday shows up in Linear as a teammate you can assign or @mention", "Its steps, plan, questions and pull request show on the issue as it works", "The issue moves to In Progress; reply on it to steer, or stop it from Linear"]} />
        {waiting && <SettingsRow label="Finish in your browser" hint="Press Install on Linear's page. A workspace admin has to. This updates by itself once you have." />}
        {status.builtIn && !own && (
          <SettingsRow label="Use your own Linear app" hint="For a workspace that only allows its own apps.">
            <Button variant="ghost" size="sm" onClick={() => setOwn(true)}>
              Set it up
            </Button>
          </SettingsRow>
        )}
        {own && (
          <>
            <SettingsRow label="1. Create an app in Linear" hint="Name it Friday, give it this callback URL, and leave webhooks off: Friday reads Linear from this computer.">
              <Button size="sm" variant="secondary" onClick={() => open(NEW_APP)}>
                Open Linear
              </Button>
            </SettingsRow>
            <CopyValue label="Callback URL" value={CALLBACK} />
            <SettingsRow label="2. Paste its client ID, and install" hint="From the app's page in Linear. The client secret is optional." htmlFor="linear-client-id" stack onSubmit={() => void connect({ clientId: clientId.trim(), ...(secret.trim() ? { clientSecret: secret.trim() } : {}) })}>
              <div className="flex flex-wrap items-center gap-2">
                <Input id="linear-client-id" aria-label="Client ID" placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} className="h-8 w-[240px]" spellCheck={false} autoComplete="off" />
                <Input type="password" aria-label="Client secret (optional)" placeholder="Client secret (optional)" value={secret} onChange={(e) => setSecret(e.target.value)} className="h-8 w-[200px]" autoComplete="off" />
                <Button size="sm" type="submit" disabled={busy || clientId.trim().length < 8}>
                  {waiting ? "Waiting…" : "Install in Linear"}
                </Button>
              </div>
            </SettingsRow>
            {status.builtIn && (
              <SettingsRow label="Or use Friday's app" hint="One button, nothing to paste.">
                <Button variant="ghost" size="sm" onClick={() => setOwn(false)}>
                  Back
                </Button>
              </SettingsRow>
            )}
          </>
        )}
        {(err || status.error) && (
          <SettingsRow label="Didn't connect">
            <Note ok={false}>{err || status.error}</Note>
          </SettingsRow>
        )}
      </SettingsGroup>
    );
  }

  const healthy = !status.error;
  const line = (
    <>
      In {status.org} as “{status.app}”{status.checkedAt ? <> · checked {relTime(status.checkedAt)}</> : null}
      {status.urlKey && (
        <>
          {" · "}
          <button type="button" className="link-btn" onClick={() => open(`https://linear.app/${status.urlKey}`)}>
            Open Linear
          </button>
        </>
      )}
    </>
  );
  return (
    <SettingsGroup>
      <Head mark={mark} name="Linear" line={line} state={healthy ? { tone: "live", text: "Connected" } : { tone: "danger", text: "Needs attention" }}>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void post("/api/channels/linear/disconnect", {}).then(got)}>
          Disconnect
        </Button>
      </Head>
      {status.error && (
        <SettingsRow label="Problem" hint={status.error}>
          {/signed .* out/i.test(status.error) && (
            <Button size="sm" onClick={() => void connect(status.usingBuiltIn ? {} : { clientId: status.clientId })}>
              Connect again
            </Button>
          )}
        </SettingsRow>
      )}
      <SettingsRow label="You in Linear" hint={status.me ? "Your asks start straight away. Anyone else's wait for you to send them on from the thread." : "Pick yourself, so your asks start straight away. Until you do, every ask waits for you in Friday."}>
        <Picker
          label="You in Linear"
          className="int-pick"
          value={status.me?.id ?? ""}
          placeholder={people ? "Choose yourself" : "Loading…"}
          options={(people ?? []).map((p) => ({ value: p.id, label: p.name, ...(p.email ? { sub: p.email } : {}) }))}
          disabled={!people}
          onChange={(id) => {
            const p = people?.find((x) => x.id === id);
            if (p) void post("/api/channels/linear", { me: { id: p.id, name: p.name } }).then(got);
          }}
        />
      </SettingsRow>
      <LinearTeams identity={identity} onChange={onChange} />
      {err && (
        <SettingsRow label="Didn't save">
          <Note ok={false}>{err}</Note>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}

/** Each Linear team and the project its issues are worked in, picked here up front, or asked on its first issue. */
function LinearTeams({ identity, onChange }: { identity: Identity; onChange: (s: LinearStatus) => void }) {
  const [teams, setTeams] = useState<{ id: string; key: string; name: string; folder: string | null }[] | null>(null);
  const [projects, setProjects] = useState<string[]>([]);
  const { busy, post } = usePost(identity);
  const load = () =>
    Promise.all([api<{ teams: NonNullable<typeof teams> }>(identity, "/api/channels/linear/teams", { headers: H }), api<{ projects: { folder: string }[] }>(identity, "/api/channels/linear/projects", { headers: H })])
      .then(([t, p]) => (setTeams(t.teams), setProjects(p.projects.map((x) => x.folder))))
      .catch(() => setTeams([]));
  useEffect(() => {
    void load();
  }, []);
  if (!teams) return <SettingsRow label="Projects" hint="Reading your teams…" />;
  // The desktop app's folder dialog; in a browser tab there's none, and the projects worked in lately are the choices.
  const canPick = !!(window as { fridayDesktop?: { pickFolder?: unknown } }).fridayDesktop?.pickFolder;
  if (!teams.length) return null;
  const set = async (t: { id: string; name: string }, folder: string | null) => {
    const r = await post("/api/channels/linear", { team: { id: t.id, folder, name: t.name } });
    if (r?.linear) onChange(r.linear as LinearStatus);
    await load();
  };
  return (
    <>
      {teams.map((t) => {
        // This team's folder, the other teams' and the projects worked in lately, each once.
        const choices = [...new Set([...(t.folder ? [t.folder] : []), ...teams.map((x) => x.folder).filter((f): f is string => !!f), ...projects])];
        return (
          <SettingsRow key={t.id} label={<>{t.name} <span className="font-normal text-[var(--text-muted)]">{t.key}</span></>} hint={t.folder ? `Its issues are worked in ${short(t.folder)}.` : "Its first issue asks which project it's in."}>
            <Picker
              label={`${t.name}'s project`}
              className="int-pick"
              value={t.folder ?? ""}
              placeholder="Ask on the first issue"
              disabled={busy}
              heading="Where its issues are worked"
              options={[...choices.map((f) => ({ value: f, label: base(f), sub: short(f) })), ...(canPick ? [{ value: "__pick", label: "Choose a folder…" }] : []), ...(t.folder ? [{ value: "__ask", label: "Ask on the first issue" }] : [])]}
              onChange={(v) => {
                if (v === "__ask") return void set(t, null);
                if (v === "__pick") return void pickFolder().then((f) => void (f && set(t, f)));
                void set(t, v);
              }}
            />
          </SettingsRow>
        );
      })}
    </>
  );
}

// ── Slack ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

function SlackCard({ identity, status, newApp, onChange }: { identity: Identity; status: SlackStatus; newApp: string; onChange: (s: SlackStatus) => void }) {
  const [bot, setBot] = useState("");
  const [appToken, setAppToken] = useState("");
  const { busy, err, post } = usePost(identity);
  const people = usePeople(identity, "/api/channels/slack/people", status.connected);
  const got = (r: Record<string, unknown> | null) => r?.slack && onChange(r.slack as SlackStatus);
  const mark = <SlackMark size={20} />;

  if (!status.connected) {
    return (
      <SettingsGroup>
        <Head mark={mark} name="Slack" line="Mention Friday in a channel, DM it, or use /friday. The work runs here, on your coding tools." state={{ text: "Not connected" }} />
        <Does items={["One message per task that updates as it works, with Stop", "Approvals and questions as buttons; reply in the thread to steer it", "A teammate's ask waits for your Start, which comes to your DMs"]} />
        <SettingsRow label="1. Create Friday in Slack" hint="Slack's form opens with everything filled in. Pick your workspace, press Create, then Install to Workspace.">
          <Button size="sm" variant="secondary" disabled={!newApp} onClick={() => open(newApp)}>
            Open Slack
          </Button>
        </SettingsRow>
        <SettingsRow label="2. Make an app-level token" hint="On the app's Basic Information page, under App-Level Tokens: Generate, with the connections:write scope. It starts with xapp-." />
        <SettingsRow label="3. Paste both tokens" hint="The bot token is under OAuth & Permissions and starts with xoxb-." stack onSubmit={() => void post("/api/channels/slack/connect", { bot, app: appToken }).then(got)}>
          <div className="flex flex-wrap items-center gap-2">
            <Input type="password" aria-label="Bot token" placeholder="xoxb-…" value={bot} onChange={(e) => setBot(e.target.value)} className="h-8 w-[220px]" autoComplete="off" />
            <Input type="password" aria-label="App-level token" placeholder="xapp-…" value={appToken} onChange={(e) => setAppToken(e.target.value)} className="h-8 w-[220px]" autoComplete="off" />
            <Button size="sm" type="submit" disabled={busy || !bot.trim() || !appToken.trim()}>
              {busy ? "Checking…" : "Connect"}
            </Button>
          </div>
          {err && <Note ok={false}>{err}</Note>}
        </SettingsRow>
      </SettingsGroup>
    );
  }

  const state = status.state === "on" ? ({ tone: "live", text: "Connected" } as const) : status.state === "connecting" ? ({ tone: "needs", text: "Connecting" } as const) : ({ tone: "danger", text: "Disconnected" } as const);
  return (
    <SettingsGroup>
      <Head mark={mark} name="Slack" line={status.state === "on" ? <>In {status.team}. Invite it to a channel with <code className="text-[12px]">/invite @Friday</code>.</> : (status.error ?? "Slack's connection is on its way.")} state={state}>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void post("/api/channels/slack/disconnect", {}).then(got)}>
          Disconnect
        </Button>
      </Head>
      <SettingsRow label="You in Slack" hint={status.me ? "Your asks start straight away. Anyone else's wait for your Start, which comes to your DMs." : "Pick yourself, so your asks start straight away. Until you do, every ask waits for you."}>
        <Picker
          label="You in Slack"
          className="int-pick"
          value={status.me?.id ?? ""}
          placeholder={people ? "Choose yourself" : "Loading…"}
          options={(people ?? []).map((p) => ({ value: p.id, label: p.name, ...(p.email ? { sub: p.email } : {}) }))}
          disabled={!people}
          onChange={(id) => {
            const p = people?.find((x) => x.id === id);
            if (p) void post("/api/channels/slack", { me: { id: p.id, name: p.name } }).then(got);
          }}
        />
      </SettingsRow>
      <SettingsRow label="Needs you, in your DMs" hint="Approvals and questions from every thread, not only Slack's, as a DM with buttons.">
        <Switch on={status.dms} label="Needs you, in your DMs" disabled={busy || !status.me} onChange={(on) => void post("/api/channels/slack", { dms: on }).then(got)} />
      </SettingsRow>
      {(status.channels ?? []).map((c) => (
        <SettingsRow key={c.id} label={c.name ? `#${c.name}` : "A channel"} hint={`Its asks are worked in ${short(c.folder)}.`}>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void post("/api/channels/slack", { channel: { id: c.id, folder: null } }).then(got)}>
            Forget
          </Button>
        </SettingsRow>
      ))}
      {err && (
        <SettingsRow label="Didn't save">
          <Note ok={false}>{err}</Note>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}
