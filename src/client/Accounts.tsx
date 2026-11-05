import { useEffect, useState } from "react";
import type { AccountUsage } from "../runner/limits.js";
import type { AccountChoice } from "./AgentModelPicker.js";
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
 * picked from a few (or typed), one line on what happens next, and the tool's own sign-in in the browser.
 *
 * Friday never moves work to another account by itself (Arun, 2026-10-27: own-plan.ts, runner/runner.ts otherAccount): the
 * person picks which one new sessions use, here, and can pick another for any one session in the message box (Arun,
 * 2026-11-02: "we need to design the multiple account support better"). The list said a run "carries on as another by itself"
 * and offered "Most room", which opened the tool's own sign-in whatever was left on it.
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

/** Which account new sessions use, by tool: the person's pick, kept in this browser; the tool's own sign-in until they pick. */
const PREFER = (tool: EngineTool) => `mpa.account.default.${tool}`;
export function preferredAccount(tool: EngineTool, rows: Row[] | undefined): string {
  let id = "";
  try {
    id = localStorage.getItem(PREFER(tool)) ?? "";
  } catch {
    // Private mode: the tool's own sign-in.
  }
  const a = rows?.find((x) => x.id === id);
  return a && a.loggedIn !== false ? a.id : "default";
}
function setPreferred(tool: EngineTool, id: string): void {
  try {
    if (id === "default") localStorage.removeItem(PREFER(tool));
    else localStorage.setItem(PREFER(tool), id);
    dispatchEvent(new Event("friday-account-default"));
  } catch {
    // Not kept: it holds for this page.
  }
}
/** The preferred account, followed as it changes here or in another of the app's lists. */
export function usePreferredAccount(tool: EngineTool | null | undefined, rows: Row[] | undefined): string {
  const [n, setN] = useState(0);
  useEffect(() => {
    const again = () => setN((x) => x + 1);
    addEventListener("friday-account-default", again);
    addEventListener("storage", again);
    return () => (removeEventListener("friday-account-default", again), removeEventListener("storage", again));
  }, []);
  void n;
  return tool ? preferredAccount(tool, rows) : "default";
}

/** How it reads in the list: its state's colour and words. */
function standing(a: Row): { tone: "done" | "queued" | "blocked" | "quiet"; text: string } {
  if (a.out) return { tone: "queued", text: a.outUntil ? `Back ${clock(a.outUntil)}` : "Out of usage" };
  if (a.loggedIn === false) return { tone: "blocked", text: "Signed out" };
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
  // One line: its name, ready typed (a suggestion, selected so typing replaces it), and Sign in; under it, in one quiet line, what
  // happens and whose it may be (Arun, 2026-11-05: the card had a title, a labelled field with a name menu and two notes).
  return (
    <form
      className="acct-add"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <div className="acct-add-line">
        <input
          className="acct-add-name"
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          value={label}
          maxLength={40}
          placeholder="Work, Personal…"
          aria-label={`Name for the new ${name} account`}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), onCancel())}
        />
        <button type="button" className="btn ghost small" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn primary small" disabled={!label.trim() || busy}>
          {busy ? <span className="spinner tiny" /> : null}
          Sign in
        </button>
      </div>
      {/* A seat is one person's (Arun, 2026-11-02: "we should have these guardrails in place btw … for friday team"): Anthropic's
          Team seats are "assigned to one named individual, and only that person may use it", and OpenAI's business seats the same. */}
      <p className="acct-add-note">
        {tool === "codex" ? "Codex's sign-in opens here, for the other ChatGPT account." : `${name}'s sign-in opens in your browser, for the other account.`} Only accounts that are yours.
      </p>
      {err && <p role="alert" className="error small">{err}</p>}
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
 * The tool's accounts as a list under it, in the computer's tool list: each with who it is (its email and plan), how much of
 * its 5 hours and its week are used, where it stands, and a menu of its own: use it for new sessions, rename it, sign in
 * again, sign out or remove it. "Add account" last, and one line that Friday never switches by itself.
 */
export function AccountList({ identity, tool, onChanged }: { identity: Identity; tool: LocalTool; onChanged: () => void }) {
  const usage = useAccountUsage(identity, tool.tool);
  const rows: Row[] = tool.accounts?.length ? tool.accounts : [{ id: "default", label: "Main", loggedIn: tool.loggedIn }];
  const preferred = usePreferredAccount(tool.tool, rows);
  const [adding, setAdding] = useState(false);
  const [signing, setSigning] = useState<{ id: string; login: Login } | null>(null);
  const [confirm, setConfirm] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const done = signing && rows.find((a) => a.id === signing.id)?.loggedIn === true;
  useWatch(!!signing && !done, onChanged);
  useEffect(() => {
    if (done) setSigning(null);
  }, [done]);
  if (!ACCOUNT_TOOLS.includes(tool.tool) || !tool.path) return null;
  const name = ENGINE_NAMES[tool.tool];
  const pick = rows.find((a) => a.id === preferred) ?? rows[0]!;
  const many = rows.length > 1;

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
  const remove = (id: string) => call(id, "/api/runner/accounts.remove", { id }, () => preferred === id && setPreferred(tool.tool, "default"));
  const rename = (id: string, label: string) => {
    const l = label.trim();
    setRenaming(null);
    if (l && l !== rows.find((a) => a.id === id)?.label) void call(id, "/api/runner/accounts.rename", { id, label: l });
  };
  const menu = (a: Row) => () => [
    { heading: a.label },
    many && { label: "Use for new sessions", checked: a.id === pick.id, disabled: a.loggedIn === false, sub: a.loggedIn === false ? "Sign in to it first" : undefined, onSelect: () => setPreferred(tool.tool, a.id) },
    many && { label: "Rename", icon: "pencil" as const, onSelect: () => setRenaming({ id: a.id, label: a.label }) },
    !many && { label: `Add a second ${name} account`, icon: "plus" as const, onSelect: () => setAdding(true) },
    a.loggedIn !== false && { label: "Sign in again", icon: "refresh" as const, sub: "To switch it to another login", onSelect: () => void signIn(a.id) },
    a.id === "default" ? { label: `Sign out of ${name}`, icon: "logout" as const, danger: true, onSelect: () => setConfirm(a.id) } : { label: "Remove", icon: "trash" as const, sub: "From this computer: its conversations stay", danger: true, onSelect: () => setConfirm(a.id) },
  ];
  /** Where it stands, as one quiet word on its line: Back 3 PM, Signed out, or how much of its fullest window is used. */
  const status = (a: Row) => {
    const st = standing(a);
    if (st.text !== "Ready") return <span className={`acct-st st-${st.tone}`}>{st.text}</span>;
    const t = tightest(usage?.find((x) => x.id === a.id));
    return t ? <span className="acct-st">{t}</span> : null;
  };
  const confirmLine = (a: Row) => (
    <p className="acct-confirm">
      {a.id === "default" ? `Signs ${name} out on this computer, for everything that uses it, not just Friday.` : `Signs ${a.label} out and takes it off this computer. Its conversations stay.`}
      <span className="acct-confirm-acts">
        <button type="button" className="btn ghost small" onClick={() => setConfirm("")}>
          Keep
        </button>
        <button type="button" className="btn destructive small" disabled={busy === a.id} onClick={() => void (a.id === "default" ? signOut(a.id) : remove(a.id))}>
          {a.id === "default" ? "Sign out" : "Remove"}
        </button>
      </span>
    </p>
  );

  /*
   * In the tool's row, as its other rows have their actions: "+ Account", quiet, and with one account its ⋯ (Arun, 2026-11-05:
   * "redesign this better for adding multiple accounts"; it was a "Main" line that folded open into a card, inside the tool's
   * card, saying "Main, Claude Code's own sign-in" again, with a dashed button). With more than one, each is a line under the
   * tool, flat, as a session is in the sidebar (Dass: state before chrome): its initial, its name, Default on the one new
   * sessions use, and where it stands in one quiet word; its ⋯ shows on pointing at it.
   */
  return (
    <>
      {!adding && (
        <span className="acct-tool-acts">
          <button type="button" className="acct-add-btn" title={`Add ${many ? "another" : "a second"} ${name} account: a sign-in of its own, kept apart`} onClick={() => setAdding(true)}>
            <Icon name="plus" size={12} />
            Account
          </button>
          {!many && <MenuButton className="icon-btn tiny acct-menu" label={`${name}: more`} icon="more" end compact width={260} items={() => menu(rows[0]!)().filter(Boolean) as never} />}
        </span>
      )}
      {(many || adding || signing || confirm || err) && (
        <div className="acct">
          {many && (
            <ul className="acct-lines" aria-label={`${name} accounts`}>
              {rows.map((a, i) => {
                const u = usage?.find((x) => x.id === a.id);
                return (
                  <li key={a.id} className={`acct-line${a.id === pick.id ? " pick" : ""}${confirm === a.id ? " confirming" : ""}`}>
                    <span className={`acct-mark${a.loggedIn === false || a.out ? " dim" : ""}`} data-i={i % 4} aria-hidden>
                      {a.label.trim()[0]?.toUpperCase() ?? "?"}
                    </span>
                    {renaming?.id === a.id ? (
                      <input
                        className="acct-rename"
                        autoFocus
                        value={renaming.label}
                        maxLength={40}
                        aria-label={`New name for ${a.label}`}
                        onChange={(e) => setRenaming({ id: a.id, label: e.target.value })}
                        onBlur={() => rename(a.id, renaming.label)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.nativeEvent.isComposing) (e.preventDefault(), rename(a.id, renaming.label));
                          if (e.key === "Escape") (e.preventDefault(), setRenaming(null));
                        }}
                      />
                    ) : (
                      <span className="acct-label" title={[u?.email, u?.plan].filter(Boolean).join(" · ") || undefined}>
                        {a.label}
                      </span>
                    )}
                    {a.id === pick.id && <span className="acct-default" title="New sessions use this account">Default</span>}
                    <span className="acct-end">
                      {signing?.id === a.id ? null : status(a)}
                      {a.loggedIn === false && signing?.id !== a.id ? (
                        <button type="button" className="btn primary small" disabled={busy === a.id} onClick={() => void signIn(a.id)}>
                          Sign in
                        </button>
                      ) : null}
                      <MenuButton className="icon-btn tiny acct-menu" label={`${a.label}: more`} icon="more" end compact width={260} items={() => menu(a)().filter(Boolean) as never} />
                    </span>
                    {signing?.id === a.id && <Pending login={signing.login} tool={tool.tool} />}
                    {confirm === a.id && confirmLine(a)}
                  </li>
                );
              })}
            </ul>
          )}
          {!many && signing && <Pending login={signing.login} tool={tool.tool} />}
          {!many && confirm && confirmLine(rows[0]!)}
          {adding && (
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
          )}
          {err && <p role="alert" className="error small">{err}</p>}
        </div>
      )}
    </>
  );
}

/**
 * Which account an agent runs as, in the connect dialog: a chip each, with how much of it is used, the one new sessions use
 * picked until another is; and the same "Add account" as the computer's list.
 */
export function AccountPicker({ identity, tool, value, onChange, onChanged }: { identity: Identity; tool: LocalTool; value: string; onChange: (id: string) => void; onChanged: () => void }) {
  const usage = useAccountUsage(identity, tool.tool);
  const accounts = tool.accounts ?? [];
  const preferred = usePreferredAccount(tool.tool, accounts);
  const current = value || preferred;
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
          {accounts.map((a) => {
            const st = a.out ? { tone: "queued", text: a.outUntil ? `back ${clock(a.outUntil)}` : "out" } : a.loggedIn === false ? { tone: "blocked", text: "signed out" } : { tone: "quiet", text: tightest(usage?.find((x) => x.id === a.id)) };
            return (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={current === a.id}
                disabled={a.loggedIn === false}
                className={`acct-chip ${current === a.id ? "on" : ""}`}
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
      {accounts.length > 1 && <p className="acct-foot">It stays on this one: Friday never switches accounts by itself.</p>}
    </div>
  );
}

/** The same choice as a pill in the composer, beside the agent and its model: the one new sessions use, until another is picked. */
/**
 * A tool's accounts as the agent picker's Account row lists them (AgentModelPicker, design D, Arun 2026-11-05): each with how much
 * of it is used, or until when it's out, the one new sessions use marked. Null for a tool with one account here.
 */
export function useAccountChoice(identity: Identity, tool: LocalTool | undefined, value: string, onChange: (id: string) => void, o: { disabled?: string; running?: boolean } = {}): AccountChoice | null {
  const usage = useAccountUsage(identity, tool?.tool ?? "claude");
  const accounts = tool?.accounts ?? [];
  const preferred = usePreferredAccount(tool?.tool, accounts);
  if (!tool || accounts.length < 2) return null;
  const current = value || preferred;
  return {
    now: current,
    set: onChange,
    ...(o.disabled ? { disabled: o.disabled } : {}),
    ...(o.running ? { note: "It carries on the same conversation there." } : {}),
    rows: accounts.map((a) => {
      const u = usage?.find((x) => x.id === a.id);
      const out = (a.out && !(a.outUntil && a.outUntil <= Date.now())) || (u?.out && !(u.outUntil && u.outUntil <= Date.now()));
      const until = a.outUntil ?? u?.outUntil;
      const w = u?.windows.filter((x) => x.usedPercent !== null).sort((x, y) => y.usedPercent! - x.usedPercent!)[0];
      return {
        id: a.id,
        label: a.label,
        ...(a.id === preferred ? { main: true } : {}),
        ...(u?.email ? { email: u.email } : {}),
        ...(out ? { out: true, note: until ? `Out until ${clock(until)}` : "Out of usage" } : a.loggedIn === false ? { off: true, note: "Signed out" } : w ? { used: w.usedPercent! / 100, note: `${Math.round(w.usedPercent!)}% ${(w.label ?? "").toLowerCase()}`.trim() } : {}),
      };
    }),
  };
}

export function AccountPill({ identity, tool, value, onChange, disabled, running = false }: { identity: Identity; tool: LocalTool; value: string; onChange: (id: string) => void; /** Why it can't be changed now, said on the pill. */ disabled?: string; /** On an agent already at work: picking another moves it there, its conversation with it. */ running?: boolean }) {
  const usage = useAccountUsage(identity, tool.tool);
  const accounts = tool.accounts ?? [];
  const preferred = usePreferredAccount(tool.tool, accounts);
  const current = value || preferred;
  const now = accounts.find((a) => a.id === current);
  // Not now (mid-run, or moving): the same pill, still, saying why.
  if (disabled)
    return (
      <button type="button" className={`menu-pill agent-pill account-pill${now?.out ? " out" : ""}`} aria-label={`${ENGINE_NAMES[tool.tool]} account`} title={disabled} disabled>
        <span>{now?.label ?? "Main"}</span>
        <Icon name="chevronDown" size={13} className="menu-pill-caret" />
      </button>
    );
  return (
    <MenuButton
      className={`agent-pill account-pill${now?.out ? " out" : ""}`}
      label={`${ENGINE_NAMES[tool.tool]} account`}
      text={now?.label ?? "Main"}
      width={300}
      above
      items={() => [
        { heading: running ? `Move ${ENGINE_NAMES[tool.tool]} to another account` : `${ENGINE_NAMES[tool.tool]} account for this session` },
        ...accounts.map((a) => {
          const u = usage?.find((x) => x.id === a.id);
          // Out as either reading says: the computer's look and its limits are read apart, and either can be the newer.
          const out = (a.out && !(a.outUntil && a.outUntil <= Date.now())) || (u?.out && !(u.outUntil && u.outUntil <= Date.now()));
          const until = a.outUntil ?? u?.outUntil;
          const note = out ? `Out of usage${until ? ` until ${clock(until)}` : ""}` : a.loggedIn === false ? "Signed out: sign in from your computer's tools" : tightest(u);
          return { label: a.label, hint: a.id === preferred ? "Default" : undefined, sub: [u?.email, note].filter(Boolean).join(" · ") || undefined, checked: current === a.id, disabled: a.loggedIn === false, onSelect: () => onChange(a.id) };
        }),
        ...(running ? [{ heading: "It carries on the same conversation there." }] : []),
      ]}
    />
  );
}

/** Out of usage now, as this computer last said: until its time, and one whose time has passed is back. */
const outNow = (a: Row, now = Date.now()) => !!a.out && !(a.outUntil && a.outUntil <= now);

/**
 * The account to offer an agent that ran out on `current`: the next one after it, in turn, that is signed in and isn't out
 * itself, as runner/accounts.ts nextAccount picks it for the run's own message. Only ever offered: the person presses it.
 */
export function nextFreeAccount(rows: Row[] | undefined, current: string, now = Date.now()): Row | null {
  if (!rows || rows.length < 2) return null;
  const at = rows.findIndex((a) => a.id === current);
  const order = [...rows.slice(at + 1), ...rows.slice(0, Math.max(0, at))];
  return order.find((a) => a.id !== current && a.loggedIn !== false && !outNow(a, now)) ?? null;
}
