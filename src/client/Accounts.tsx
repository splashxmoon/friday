import { useEffect, useState } from "react";
import type { AccountUsage } from "../runner/limits.js";
import { ENGINE_NAMES, type EngineTool } from "../types.js";
import { Icon } from "./icons.js";
import { hostApi, type LocalTool } from "./local.js";
import { openOutside } from "./openOutside.js";
import type { Identity } from "./storage.js";
import { useToolLimits } from "./toolLimits.js";
import { MenuButton } from "./ui.js";

/**
 * A coding tool's accounts on the computer (Arun, 2026-10-24: "add support for multiple account support for the coding tools",
 * then "design this better"): two Claude Code logins, work and personal, or two Codex accounts.
 *
 * Under the tool, a small raised list: each account with who it is and how much of it is used, and where it stands in the
 * board's state colours (--st-*): the one a new agent starts on, one out of usage until it comes back, one waiting for its
 * sign-in. Its own actions sit on its own row, so nothing opens over the tool's name. Adding one is the list's last row: a name
 * picked from a few (or typed), one line on what happens next, and the tool's own sign-in in the browser. Once one runs out
 * mid-task, the runner carries on as the next by itself (runner/accounts.ts).
 */

export const ACCOUNT_TOOLS: EngineTool[] = ["claude", "codex"];

type Row = NonNullable<LocalTool["accounts"]>[number];
type Login = { url?: string; opened?: boolean; command?: string };

/** The fullest window of an account, as a few words: "62% weekly". */
function tightest(u: AccountUsage | undefined): string {
  const w = u?.windows.filter((x) => x.usedPercent !== null).sort((a, b) => b.usedPercent! - a.usedPercent!)[0];
  return w ? `${Math.round(w.usedPercent!)}% ${(w.label ?? "").toLowerCase() || "used"}` : "";
}

const clock = (ms: number) => {
  const today = new Date(ms).toDateString() === new Date().toDateString();
  return new Date(ms).toLocaleString([], today ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
};

/** The account a new agent opens on when nobody picks one: the tool's own, unless that is out and another isn't (Runner.startAccount). */
function firstUp(rows: Row[]): string {
  const main = rows[0];
  if (!main) return "";
  if (!main.out) return main.id;
  return rows.find((a) => !a.out && a.loggedIn !== false)?.id ?? main.id;
}

/** How it reads in the list: its state's colour and words. */
function standing(a: Row, first: boolean): { tone: "done" | "queued" | "blocked" | "working" | "quiet"; text: string } {
  if (a.out) return { tone: "queued", text: a.outUntil ? `Back ${clock(a.outUntil)}` : "Out of usage" };
  if (a.loggedIn === false) return { tone: "blocked", text: "Signed out" };
  if (first) return { tone: "working", text: "Used first" };
  return { tone: "done", text: "Ready" };
}

/** Its usage for a tool, when the computer said. */
function useAccountUsage(identity: Identity, tool: EngineTool): AccountUsage[] | undefined {
  const limits = useToolLimits(identity);
  return limits && limits !== "none" ? limits.accounts?.[tool as "claude" | "codex"] : undefined;
}

/** While a sign-in is open in the browser or a terminal, the tool is looked at again every few seconds, for three minutes. */
function useWatch(on: boolean, look: () => void): void {
  useEffect(() => {
    if (!on) return;
    const every = setInterval(look, 3000);
    const stop = setTimeout(() => clearInterval(every), 180_000);
    return () => (clearInterval(every), clearTimeout(stop));
  }, [on]); // eslint-disable-line react-hooks/exhaustive-deps
}

const SUGGESTED = ["Work", "Personal", "Side project", "Team"];

/**
 * Naming a new account and signing in to it: a few names to pick from (the first free one already picked, so the button is
 * ready), a field for another, and one line on what happens next.
 */
function AddAccount({ identity, tool, taken, onAdded, onCancel }: { identity: Identity; tool: EngineTool; taken: string[]; onAdded: (id: string, login: Login) => void; onCancel: () => void }) {
  const free = SUGGESTED.filter((s) => !taken.some((t) => t.toLowerCase() === s.toLowerCase()));
  const [label, setLabel] = useState(free[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const name = ENGINE_NAMES[tool];
  const add = async () => {
    if (!label.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await hostApi<{ account: { id: string }; login: Login }>(identity, "/api/runner/accounts.add", { method: "POST", body: JSON.stringify({ tool, label: label.trim() }) });
      onAdded(r.account.id, r.login);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <form
      className="acct-add"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <p className="acct-add-title">Add a {name} account</p>
      {/* One field for its name: typed, or picked from a few in the dropdown at its end. */}
      <label className="acct-field">
        <span className="acct-field-label">Name</span>
        <span className="acct-combo">
          <input
            className="acct-combo-input"
            autoFocus
            value={label}
            maxLength={40}
            placeholder="Work, Personal…"
            aria-label="Name for the account"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onCancel()}
          />
          {free.length > 0 && (
            <MenuButton
              className="icon-btn tiny acct-combo-pick"
              label="Pick a name"
              icon="chevronDown"
              end
              compact
              width={180}
              items={() => [{ heading: "Name it" }, ...free.map((n) => ({ label: n, checked: label === n, onSelect: () => setLabel(n) }))]}
            />
          )}
        </span>
      </label>
      <p className="acct-add-note">
        <Icon name="external" size={12} />
        {tool === "codex"
          ? "Codex's sign-in opens on this computer. Sign in with the other ChatGPT account; your current one stays signed in."
          : `${name} opens its sign-in in your browser. Sign in with the other account; your current one stays signed in.`}
      </p>
      {err && <p role="alert" className="error small">{err}</p>}
      <div className="acct-add-actions">
        <button type="button" className="btn ghost small" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn primary small" disabled={!label.trim() || busy}>
          {busy ? <span className="spinner" /> : null}
          Sign in to {label.trim() || "it"}
        </button>
      </div>
    </form>
  );
}

/** A sign-in under way, on its account's row: where to finish it, and a way back to the page. */
function Pending({ login, tool }: { login: Login; tool: EngineTool }) {
  return (
    <p className="acct-pending">
      <span className="spinner tiny" aria-hidden />
      {login.url ? (
        <>
          Finish signing in to {ENGINE_NAMES[tool]} in the page that opened.{" "}
          <button type="button" className="link-btn" onClick={() => openOutside(login.url!)}>
            Open it again
          </button>
        </>
      ) : login.opened ? (
        "Finish signing in in the terminal that opened. This updates by itself."
      ) : (
        <>
          Run this on the computer to sign in: <code>{login.command}</code>
        </>
      )}
    </p>
  );
}

/**
 * The tool's accounts as a list under it, in the computer's tool list: each with who it is, how much is used and where it
 * stands, its own sign-in, sign-out or removal on its row, and "Add account" last.
 */
export function AccountList({ identity, tool, onChanged }: { identity: Identity; tool: LocalTool; onChanged: () => void }) {
  const usage = useAccountUsage(identity, tool.tool);
  const rows: Row[] = tool.accounts?.length ? tool.accounts : [{ id: "default", label: "Main", loggedIn: tool.loggedIn }];
  const [adding, setAdding] = useState(false);
  const [signing, setSigning] = useState<{ id: string; login: Login } | null>(null);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const done = signing && rows.find((a) => a.id === signing.id)?.loggedIn === true;
  useWatch(!!signing && !done, onChanged);
  useEffect(() => {
    if (done) setSigning(null);
  }, [done]);
  if (!ACCOUNT_TOOLS.includes(tool.tool) || !tool.path) return null;
  const first = firstUp(rows);
  const name = ENGINE_NAMES[tool.tool];
  // One line, folded (Arun, 2026-10-25: "design this better maybe make it collapseable"): who is signed in and where they
  // stand, opening to the accounts themselves. Open by itself while something needs doing (a sign-in, an account on its way).
  const needs = rows.some((a) => a.loggedIn === false || a.out);
  const [opened, setOpened] = useState<boolean | null>(null);
  const open = opened ?? (needs || adding || !!signing);
  const summary = (() => {
    if (rows.length === 1) {
      const a = rows[0]!;
      const u = usage?.find((x) => x.id === a.id);
      const st = standing(a, false);
      return [a.label, st.text, u?.plan, a.out ? "" : tightest(u)].filter(Boolean).join(" · ");
    }
    const out = rows.filter((a) => a.out).length;
    const signedOut = rows.filter((a) => a.loggedIn === false).length;
    const bits = [`${rows.length} accounts`, signedOut ? `${signedOut} signed out` : "", out ? `${out} out of usage` : "", !signedOut && !out ? "all ready" : ""].filter(Boolean);
    return bits.join(" · ");
  })();

  const call = async (id: string, path: string, body: Record<string, unknown>, after?: (r: Login) => void) => {
    setBusy(id);
    setErr("");
    try {
      const r = await hostApi<Login>(identity, path, { method: "POST", body: JSON.stringify({ tool: tool.tool, ...body }) });
      setConfirm("");
      after?.(r);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const signIn = (id: string) => call(id, "/api/runner/login", id === "default" ? {} : { account: id }, (login) => setSigning({ id, login }));
  const signOut = (id: string) => call(id, "/api/runner/logout", id === "default" ? {} : { account: id });
  const remove = (id: string) => call(id, "/api/runner/accounts.remove", { id });

  return (
    <div className={`acct${open ? " open" : ""}`}>
      <button type="button" className="acct-sum" aria-expanded={open} title={open ? "Fold the accounts away" : `${name}'s accounts on this computer`} onClick={() => setOpened(!open)}>
        <span className="acct-sum-marks" aria-hidden>
          {rows.slice(0, 3).map((a, i) => (
            <span key={a.id} className={`acct-mark${a.loggedIn === false || a.out ? " dim" : ""}`} data-i={i % 4}>
              {a.label.trim()[0]?.toUpperCase() ?? "?"}
            </span>
          ))}
        </span>
        <span className="acct-sum-text">{summary}</span>
        {needs && !open && <span className="acct-state st-blocked">Needs you</span>}
        <Icon name={open ? "chevronUp" : "chevronDown"} size={12} />
      </button>
      {open && (
      <ul className="acct-list" aria-label={`${name} accounts`}>
        {rows.map((a, i) => {
          const u = usage?.find((x) => x.id === a.id);
          const st = standing(a, rows.length > 1 && a.id === first);
          const sub = [u?.email, u?.plan, a.out ? "" : tightest(u)].filter(Boolean).join(" · ") || (a.id === "default" ? `${name}'s own sign-in` : "Its own sign-in, kept apart");
          return (
            <li key={a.id} className="acct-row">
              <span className="acct-mark" data-i={i % 4} aria-hidden>
                {a.label.trim()[0]?.toUpperCase() ?? "?"}
              </span>
              <span className="acct-id">
                <span className="acct-name-line">
                  <span className="acct-label">{a.label}</span>
                  <span className={`acct-state st-${st.tone}`}>{st.text}</span>
                </span>
                {signing?.id === a.id ? <Pending login={signing.login} tool={tool.tool} /> : confirm === a.id ? null : <span className="acct-sub">{sub}</span>}
              </span>
              <span className="acct-act">
                {confirm === a.id ? (
                  <>
                    <button type="button" className="btn ghost small" onClick={() => setConfirm("")}>
                      Keep
                    </button>
                    <button type="button" className="btn destructive small" disabled={busy === a.id} onClick={() => void (a.id === "default" ? signOut(a.id) : remove(a.id))}>
                      {a.id === "default" ? "Sign out" : "Remove"}
                    </button>
                  </>
                ) : a.loggedIn === false && signing?.id !== a.id ? (
                  <button type="button" className="btn primary small" disabled={busy === a.id} onClick={() => void signIn(a.id)}>
                    Sign in
                  </button>
                ) : (
                  <button
                    type="button"
                    className="icon-btn tiny acct-x"
                    aria-label={a.id === "default" ? `Sign ${a.label} out of ${name}` : `Remove ${a.label}`}
                    title={a.id === "default" ? `Sign out of ${name} on this computer` : `Remove ${a.label} from this computer`}
                    onClick={() => setConfirm(a.id)}
                  >
                    <Icon name={a.id === "default" ? "logout" : "trash"} size={13} />
                  </button>
                )}
              </span>
              {confirm === a.id && (
                <p className="acct-confirm">
                  {a.id === "default"
                    ? `Signs ${name} out on this computer, for everything that uses it, not just Friday.`
                    : `Signs ${a.label} out and takes it off this computer. Its conversations stay.`}
                </p>
              )}
            </li>
          );
        })}
        {adding ? (
          <li className="acct-row acct-row-add">
            <AddAccount
              identity={identity}
              tool={tool.tool}
              taken={rows.map((a) => a.label)}
              onCancel={() => setAdding(false)}
              onAdded={(id, login) => {
                setAdding(false);
                setSigning({ id, login });
                onChanged();
              }}
            />
          </li>
        ) : (
          <li>
            <button type="button" className="acct-more" onClick={() => setAdding(true)}>
              <Icon name="plus" size={13} />
              Add account
            </button>
          </li>
        )}
      </ul>
      )}
      {err && <p role="alert" className="error small">{err}</p>}
    </div>
  );
}

/**
 * Which account an agent runs as, in the connect dialog: a chip each, with how much of it is used, "Most room" first; and the
 * same "Add account" as the computer's list.
 */
export function AccountPicker({ identity, tool, value, onChange, onChanged }: { identity: Identity; tool: LocalTool; value: string; onChange: (id: string) => void; onChanged: () => void }) {
  const usage = useAccountUsage(identity, tool.tool);
  const accounts = tool.accounts ?? [];
  const [adding, setAdding] = useState(false);
  const [signing, setSigning] = useState<{ id: string; login: Login } | null>(null);
  const done = signing && accounts.find((a) => a.id === signing.id)?.loggedIn === true;
  useWatch(!!signing && !done, onChanged);
  useEffect(() => {
    if (done) setSigning(null);
  }, [done]);
  if (!ACCOUNT_TOOLS.includes(tool.tool) || !tool.path) return null;
  return (
    <div className="acct acct-pick">
      {accounts.length > 1 && (
        <div className="acct-chips" role="radiogroup" aria-label={`${ENGINE_NAMES[tool.tool]} account`}>
          <button type="button" role="radio" aria-checked={value === ""} className={`acct-chip ${value === "" ? "on" : ""}`} onClick={() => onChange("")}>
            <Icon name="zap" size={12} />
            Most room
          </button>
          {accounts.map((a) => {
            const st = a.out ? { tone: "queued", text: a.outUntil ? `back ${clock(a.outUntil)}` : "out" } : a.loggedIn === false ? { tone: "blocked", text: "signed out" } : { tone: "quiet", text: tightest(usage?.find((x) => x.id === a.id)) };
            return (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={value === a.id}
                disabled={a.loggedIn === false}
                className={`acct-chip ${value === a.id ? "on" : ""}`}
                title={usage?.find((x) => x.id === a.id)?.email ?? a.label}
                onClick={() => onChange(a.id)}
              >
                {a.label}
                {st.text && <span className={`acct-chip-note st-${st.tone}`}>{st.text}</span>}
              </button>
            );
          })}
        </div>
      )}
      {signing && <Pending login={signing.login} tool={tool.tool} />}
      {adding ? (
        <AddAccount
          identity={identity}
          tool={tool.tool}
          taken={accounts.length ? accounts.map((a) => a.label) : ["Main"]}
          onCancel={() => setAdding(false)}
          onAdded={(id, login) => {
            setAdding(false);
            setSigning({ id, login });
            onChange(id);
            onChanged();
          }}
        />
      ) : (
        <button type="button" className="acct-more" onClick={() => setAdding(true)}>
          <Icon name="plus" size={13} />
          Add {accounts.length > 1 ? "another" : "a second"} {ENGINE_NAMES[tool.tool]} account
        </button>
      )}
      {accounts.length > 1 && <p className="acct-foot">If one runs out mid-task, it carries on as another by itself.</p>}
    </div>
  );
}

/** The same choice as a pill in the composer, beside the agent and its model. */
export function AccountPill({ identity, tool, value, onChange }: { identity: Identity; tool: LocalTool; value: string; onChange: (id: string) => void }) {
  const usage = useAccountUsage(identity, tool.tool);
  const accounts = tool.accounts ?? [];
  const now = accounts.find((a) => a.id === value);
  return (
    <MenuButton
      className="agent-pill account-pill"
      label={`${ENGINE_NAMES[tool.tool]} account`}
      text={now?.label ?? "Most room"}
      width={300}
      above
      items={() => [
        { heading: `${ENGINE_NAMES[tool.tool]} account` },
        { label: "Most room", sub: "Whichever has the most left. If it runs out mid-task, the next carries on.", checked: value === "", onSelect: () => onChange("") },
        ...accounts.map((a) => {
          const u = usage?.find((x) => x.id === a.id);
          const note = a.out ? `Out of usage${a.outUntil ? ` until ${clock(a.outUntil)}` : ""}` : a.loggedIn === false ? "Signed out: sign in from your computer's tools" : tightest(u);
          return { label: a.label, sub: [u?.email, note].filter(Boolean).join(" · ") || undefined, checked: value === a.id, disabled: a.loggedIn === false, onSelect: () => onChange(a.id) };
        }),
      ]}
    />
  );
}
