import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ConnectionView, Draft } from "../runner/connections.js";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PageHeader } from "@/components/dass";
import { ClaudeMark } from "./BrandMarks.js";
import { Icon } from "./icons.js";
import { hostApi } from "./local.js";
import type { Identity } from "./storage.js";
import { Directory, lineOf } from "./mcp-directory.js";
import "./mcp-servers.css";

/**
 * MCP servers, set up once for every coding tool on this computer (runner/connections.ts; Arun, 2026-11-17: "Yes, build it",
 * then "create a page for it on the rail for me"). One box takes what a server's docs say to paste; only what's left as a
 * placeholder is asked for; each is tested as it's added and shown with what it answered, or why it didn't, in plain words.
 * Its keys are typed here once and never shown again: the page is told which keys a server has, not what they are.
 */

type List = { servers: ConnectionView[]; claudeCode: boolean; claudeCodeNames: string[]; builtInApps?: string[] };

const call = <T,>(identity: Identity, op: string, body?: unknown) =>
  hostApi<T>(identity, `/api/runner/${op}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });

export function McpServersPage({ identity, tabs }: { identity: Identity; /** Customize's tabs, at the toolbar's left (App.tsx). */ tabs?: ReactNode }) {
  const [list, setList] = useState<List | null>(null);
  const [failed, setFailed] = useState("");
  const load = useCallback(
    () =>
      call<List>(identity, "connections").then(
        (l) => (setList(l), setFailed(""), l.servers),
        (e: Error) => (setFailed(e.message), [] as ConnectionView[]),
      ),
    [identity],
  );
  useEffect(() => void load(), [load]);
  return (
    <div className="page conns-page msv-page px-6! max-[640px]:px-4!">
      <div className="page-inner">
        <PageHeader title="Plugins" />
        {tabs && <div className="customize-bar">{tabs}</div>}
        <div className="msv">
          <Directory
            identity={identity}
            servers={list?.servers ?? []}
            builtInApps={list?.builtInApps ?? []}
            onChanged={load}
            actions={
              <>
                <CustomServer identity={identity} servers={list?.servers ?? []} onAdded={() => void load()} />
                {list && <ClaudeCodeSwitch identity={identity} list={list} onChange={(on) => setList((l) => (l ? { ...l, claudeCode: on } : l))} />}
              </>
            }
          />
          {failed && (
            <p className="msv-error" role="alert">
              Couldn't read your plugins: {failed}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Custom server, in the header (Arun, 2026-11-17: "add a button in the header for custom mcp, with input fields and stuff", then
 * "like this for the custom one and like the key or whatever instead of a input box thing we have"): a sheet of plain fields (its
 * name, where it is, a key), remote or run here. Its config pasted whole (JSON, a claude mcp add line) is one link away, for the
 * servers whose docs give one. One added shows as a card under Your own.
 */
function CustomServer({ identity, servers, onAdded }: { identity: Identity; servers: ConnectionView[]; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [paste, setPaste] = useState(false);
  const [where, setWhere] = useState<"remote" | "local">("remote");
  const [name, setName] = useState("");
  const [addr, setAddr] = useState("");
  const [key, setKey] = useState("");
  const [envName, setEnvName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  /** Saved but off: it's under Your own now, so the sheet only closes; adding again would make a second. */
  const [saved, setSaved] = useState(false);
  const start = () => (setSaved(false), setPaste(false), setWhere("remote"), setName(""), setAddr(""), setKey(""), setEnvName(""), setErr(""), setOpen(true));
  const remote = where === "remote";
  const add = async () => {
    if (!addr.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await call<{ drafts: Draft[] }>(identity, "connections.parse", { text: addr.trim() });
      const d = r.drafts[0];
      if (!d) throw new Error(remote ? "That isn't an address Friday can reach." : "That isn't a command Friday can run.");
      if (remote && d.transport === "stdio") throw new Error("That's a command: switch to Runs here.");
      if (!remote && d.transport !== "stdio") throw new Error("That's an address: switch to Remote.");
      const k = key.trim();
      const draft: Draft = {
        ...d,
        name: name.trim() || d.name,
        ...(remote && k && !d.needs.length ? { headers: { ...(d.headers ?? {}), Authorization: `Bearer ${k}` } } : {}),
        ...(!remote && k && envName.trim() ? { env: { ...(d.env ?? {}), [envName.trim()]: k } } : {}),
      };
      // A placeholder in what was given (an address with {API_KEY} in it) takes the key.
      const values = Object.fromEntries(d.needs.map((n) => [`${n.where}:${n.key}`, k]));
      if (d.needs.length && !k) throw new Error(`It asks for ${d.needs.map((n) => n.key).join(", ")}: give it as its key.`);
      const a = await call<{ server: ConnectionView }>(identity, "connections.add", { draft, values });
      onAdded();
      if (a.server.status?.ok) setOpen(false);
      else setSaved(true), setErr(`Saved, but it's off: ${a.server.status?.error ?? "it didn't answer."} It's under Your own to try again.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button type="button" variant="outline" size="sm" className="mdir-custom-btn" onClick={start}>
        <Icon name="plus" size={14} /> Custom server
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="mdir-sheet msv-dlg sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>Add a custom server</DialogTitle>
            <DialogDescription>Any MCP server, for every coding tool here: Claude Code, Codex, Amp and the ACP tools. Cursor reads only its own list.</DialogDescription>
          </DialogHeader>
          {paste ? (
            <>
              <AddBox identity={identity} servers={servers} onAdded={onAdded} />
              <button type="button" className="link-btn msv-switch" onClick={() => setPaste(false)}>
                Fill it in instead
              </button>
            </>
          ) : (
            <form
              className="msv-fields"
              onSubmit={(e) => {
                e.preventDefault();
                void add();
              }}
            >
              <div className="msv-seg" role="radiogroup" aria-label="Where it runs">
                {(["remote", "local"] as const).map((w) => (
                  <button key={w} type="button" role="radio" aria-checked={where === w} onClick={() => (setWhere(w), setErr(""))}>
                    <Icon name={w === "remote" ? "globe" : "terminal"} size={13} />
                    {w === "remote" ? "Remote" : "Runs here"}
                  </button>
                ))}
              </div>
              <label className="mdir-field">
                <span>Name</span>
                <input value={name} maxLength={40} placeholder={remote ? "acme" : "my-tools"} autoComplete="off" spellCheck={false} onChange={(e) => setName(e.target.value)} />
                <small>How it's shown here and named to the tools. Left empty, it's named from {remote ? "the address" : "the command"}.</small>
              </label>
              <label className="mdir-field">
                <span>{remote ? "Server URL" : "Command"}</span>
                <input className="msv-mono" value={addr} autoFocus placeholder={remote ? "https://mcp.example.com/mcp" : "npx -y @acme/mcp-server"} autoComplete="off" spellCheck={false} onChange={(e) => setAddr(e.target.value)} />
                <small>{remote ? "The address where it takes MCP requests. An address ending in /sse is spoken to the older way." : "What starts it on this computer. Friday starts it once to check it answers."}</small>
              </label>
              {remote ? (
                <label className="mdir-field">
                  <span>
                    API key <em>optional</em>
                  </span>
                  <input type="password" value={key} placeholder="Paste its key" autoComplete="off" onChange={(e) => setKey(e.target.value)} />
                  <small>Sent as a Bearer token. Kept on this computer in a file only you can read, and never shown again.</small>
                </label>
              ) : (
                <div className="mdir-field">
                  <span>
                    Key <em>optional</em>
                  </span>
                  <span className="msv-env">
                    <input className="msv-mono" value={envName} placeholder="ACME_API_KEY" aria-label="Its variable" autoComplete="off" spellCheck={false} onChange={(e) => setEnvName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))} />
                    <input type="password" value={key} placeholder="Its value" aria-label="Its value" autoComplete="off" onChange={(e) => setKey(e.target.value)} />
                  </span>
                  <small>Given to it as this environment variable. Kept on this computer, and never shown again.</small>
                </div>
              )}
              {err && (
                <p className="msv-error" role="alert">
                  {err}
                </p>
              )}
              <p className="msv-trust">Only add servers from people you trust: Friday can't check what their tools do, or that they won't change.</p>
              <div className="msv-dlg-foot">
                <button type="button" className="link-btn" onClick={() => (setPaste(true), setErr(""))}>
                  Paste a config instead
                </button>
                <span className="msv-acts">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  {saved ? (
                    <Button type="button" size="sm" onClick={() => setOpen(false)}>
                      Done
                    </Button>
                  ) : (
                    <Button type="submit" size="sm" disabled={!addr.trim() || busy || (!remote && !!key.trim() && !envName.trim())}>
                      {busy ? "Testing…" : "Add and test"}
                    </Button>
                  )}
                </span>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The person's own Claude Code servers handed to the other tools too, as a switch in the header (Arun, 2026-11-17: "make the also
 * give every tool my claude servers a toggle in the header"). Off unless turned on; hidden when Claude Code has none.
 */
function ClaudeCodeSwitch({ identity, list, onChange }: { identity: Identity; list: List; onChange: (on: boolean) => void }) {
  const n = list.claudeCodeNames.length;
  if (!n && !list.claudeCode) return null;
  const set = async (on: boolean) => {
    onChange(on);
    await call(identity, "connections.claude", { on }).catch(() => onChange(!on));
  };
  const why = `Also give every tool the ${n} server${n === 1 ? "" : "s"} in your Claude Code${n ? ` (${list.claudeCodeNames.slice(0, 4).join(", ")}${n > 4 ? ` and ${n - 4} more` : ""})` : ""}. Claude Code has them already. Off unless you want them: each one's tools are described to the model on every call.`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <label className="mdir-cc">
          <ClaudeMark size={14} />
          <span>Claude Code servers</span>
          <Switch aria-label="Also give every tool my Claude Code servers" checked={list.claudeCode} onCheckedChange={(on) => void set(on)} />
        </label>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[300px]">
        {why}
      </TooltipContent>
    </Tooltip>
  );
}

/** The one box: paste, then fill in what it asks for, then add. */
function AddBox({ identity, onAdded, servers }: { identity: Identity; onAdded: (s: ConnectionView) => void; /** The list as it is now: a line about one is gone once that one changes. */ servers: ConnectionView[] }) {
  const [text, setText] = useState("");
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [names, setNames] = useState<string[]>([]);
  const [busy, setBusy] = useState<"" | "reading" | "adding">("");
  const [err, setErr] = useState("");
  const [said, setSaid] = useState<ConnectionView[]>([]);
  const box = useRef<HTMLTextAreaElement>(null);
  // How an add went, for a little while, and only while it still says how that server is.
  useEffect(() => {
    if (!said.length) return;
    const t = setTimeout(() => setSaid([]), 10_000);
    return () => clearTimeout(t);
  }, [said]);
  const current = said.filter((x) => {
    const now = servers.find((y) => y.id === x.id);
    return now && now.enabled === x.enabled && now.status?.at === x.status?.at;
  });
  const read = async () => {
    if (!text.trim() || busy) return;
    setBusy("reading");
    setErr("");
    setSaid([]);
    try {
      const r = await call<{ drafts: Draft[] }>(identity, "connections.parse", { text });
      setDrafts(r.drafts);
      setNames(r.drafts.map((d) => d.name));
      setValues({});
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const missing = (drafts ?? []).some((d) => d.needs.some((n) => !values[`${d.name}|${n.where}:${n.key}`]?.trim()));
  const add = async () => {
    if (!drafts || missing || busy) return;
    setBusy("adding");
    setErr("");
    const added: ConnectionView[] = [];
    try {
      for (const [i, d] of drafts.entries()) {
        const mine = Object.fromEntries(Object.entries(values).filter(([k]) => k.startsWith(`${d.name}|`)).map(([k, v]) => [k.slice(d.name.length + 1), v.trim()]));
        const r = await call<{ server: ConnectionView }>(identity, "connections.add", { draft: { ...d, name: names[i] || d.name }, values: mine });
        added.push(r.server);
        onAdded(r.server);
      }
      setSaid(added);
      setDrafts(null);
      setText("");
      setValues({});
    } catch (e) {
      setErr((e as Error).message);
      if (added.length) setSaid(added);
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="msv-add" aria-label="Add an MCP server">
      {!drafts ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void read();
          }}
        >
          <textarea
            ref={box}
            className="msv-paste"
            rows={3}
            value={text}
            spellCheck={false}
            aria-label="What the server's docs say to paste"
            placeholder={"Paste what a server's docs say: its URL, a claude mcp add … line,\nan npx / uvx / docker run command, or its JSON."}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), void read());
            }}
          />
          <div className="msv-add-foot">
            <span className="msv-hint">Only what it leaves as a placeholder is asked for.</span>
            <Button type="submit" size="sm" disabled={!text.trim() || !!busy}>
              {busy === "reading" ? "Reading…" : "Add"}
            </Button>
          </div>
        </form>
      ) : (
        <form
          className="msv-review"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          {drafts.map((d, i) => (
            <div key={`${d.name}-${i}`} className="msv-draft">
              <div className="msv-draft-head">
                <Icon name={d.transport === "stdio" ? "terminal" : "link"} size={14} />
                <input className="msv-name" value={names[i] ?? d.name} maxLength={40} aria-label="Its name" onChange={(e) => setNames((n) => n.map((x, j) => (j === i ? e.target.value : x)))} />
                <span className="msv-kind">{d.transport === "stdio" ? "Runs here" : d.transport === "sse" ? "Remote · SSE" : "Remote"}</span>
              </div>
              <code className="msv-line" title={lineOf(d)}>
                {lineOf(d)}
              </code>
              {d.needs.map((n) => {
                const k = `${d.name}|${n.where}:${n.key}`;
                return (
                  <label key={k} className="msv-need">
                    <span>
                      {n.key}
                      {n.where === "header" ? <em> header</em> : null}
                    </span>
                    <input type="password" autoComplete="off" value={values[k] ?? ""} placeholder={n.prefix ? `Paste the key: “${n.prefix.trim()}” goes before it` : "Paste its value"} aria-label={`${n.key}${n.where === "header" ? " header" : ""}`} onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))} />
                  </label>
                );
              })}
            </div>
          ))}
          <div className="msv-add-foot">
            <span className="msv-hint">{busy === "adding" ? "Starting it and asking for its tools…" : "Friday starts it once to check it answers, then every tool gets it."}</span>
            <span className="msv-acts">
              <Button type="button" size="sm" variant="ghost" disabled={busy === "adding"} onClick={() => (setDrafts(null), setErr(""))}>
                Back
              </Button>
              <Button type="submit" size="sm" disabled={missing || !!busy}>
                {busy === "adding" ? "Testing…" : drafts.length > 1 ? `Add ${drafts.length} and test` : "Add and test"}
              </Button>
            </span>
          </div>
        </form>
      )}
      {err && (
        <p className="msv-error" role="alert">
          {err}
        </p>
      )}
      {current.map((s) => (
        <p key={s.id} className={`msv-said ${s.status?.ok ? "ok" : "bad"}`} role="status">
          {s.status?.ok ? `${s.name} is connected: ${s.status.tools} tool${s.status.tools === 1 ? "" : "s"}. Every tool gets it on its next turn.` : `${s.name} was saved, but it's off: ${s.status?.error ?? "the test failed."}`}
        </p>
      ))}
    </section>
  );
}
