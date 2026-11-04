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

/** A usage window's name: "5 hours", "This week", or what the tool calls it. */
function windowName(w: AccountUsage["windows"][number]): string {
  // A model's own weekly limit says which ("Weekly · Fable" is "Fable, week"), apart from the week for everything.
  const model = /^weekly\s*·\s*(.+)$/i.exec(w.label ?? "")?.[1];
  if (model) return `${model}, week`;
  if (w.windowMinutes === 300) return "5 hours";
  if (w.windowMinutes === 10080) return "This week";
  return w.label || (w.windowMinutes ? `${Math.round(w.windowMinutes / 60)} hours` : "Usage");
}

/** How much of each window is used, a thin bar each with when it resets: the two that matter at a glance. */
function UsageBars({ u }: { u: AccountUsage | undefined }) {
  const windows = (u?.windows ?? []).filter((w) => w.usedPercent !== null).slice(0, 3);
  if (!windows.length) return null;
  return (
    <span className="acct-usage">
      {windows.map((w, i) => {
        const pct = Math.max(0, Math.min(100, Math.round(w.usedPercent!)));
        const tone = pct >= 90 ? "hot" : pct >= 70 ? "warm" : "";
        return (
          <span key={i} className={`acct-bar ${tone}`} title={w.resetsAt ? `Resets ${clock(w.resetsAt * 1000)}` : undefined}>
            <span className="acct-bar-name">{windowName(w)}</span>
            <span className="acct-bar-track" aria-hidden="true">
              <span style={{ width: `${pct}%` }} />
            </span>
            <span className="acct-bar-pct">{pct}%</span>
          </span>
        );
      })}
    </span>
  );
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
            onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), onCancel())}
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
      {/* A seat is one person's (Arun, 2026-11-02: "we should have these guardrails in place btw … for friday team"): Anthropic's
          Team seats are "assigned to one named individual, and only that person may use it", and OpenAI's business seats the same. */}
      <p className="acct-add-note">
        <Icon name="user" size={12} />
        {tool === "codex"
          ? "Only an account that's yours: a ChatGPT Business or Enterprise seat is for the person it's assigned to, not a teammate's to borrow."
          : "Only an account that's yours: a Claude Team or Enterprise seat is for the person it's assigned to, not a teammate's to borrow."}
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
  // One line, folded (Arun, 2026-10-25: "design this better maybe make it collapseable"): who is signed in and where they
  // stand, opening to the accounts themselves. Open by itself while something needs doing (a sign-in, an account on its way).
  const needs = rows.some((a) => a.loggedIn === false);
  const [opened, setOpened] = useState<boolean | null>(null);
  if (!ACCOUNT_TOOLS.includes(tool.tool) || !tool.path) return null;
  const open = opened ?? (needs || adding || !!signing);
  const name = ENGINE_NAMES[tool.tool];
  const pick = rows.find((a) => a.id === preferred) ?? rows[0]!;
  const summary = (() => {
    const u = usage?.find((x) => x.id === pick.id);
    if (rows.length === 1) return [pick.label, u?.plan, pick.out ? standing(pick).text : tightest(u)].filter(Boolean).join(" · ");
    const out = rows.filter((a) => a.out).length;
    return [`New sessions: ${pick.label}`, out ? `${out} out of usage` : ""].filter(Boolean).join(" · ");
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
  const remove = (id: string) => call(id, "/api/runner/accounts.remove", { id }, () => preferred === id && setPreferred(tool.tool, "default"));
  const rename = (id: string, label: string) => {
    const l = label.trim();
    setRenaming(null);
    if (l && l !== rows.find((a) => a.id === id)?.label) void call(id, "/api/runner/accounts.rename", { id, label: l });
  };

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
            const st = standing(a);
            const isPick = rows.length > 1 && a.id === pick.id;
            const who = [u?.email, u?.plan].filter(Boolean).join(" · ") || (a.id === "default" ? `${name}'s own sign-in` : "Its own sign-in, kept apart");
            return (
              <li key={a.id} className={`acct-row${isPick ? " pick" : ""}`}>
                <span className="acct-mark" data-i={i % 4} aria-hidden>
                  {a.label.trim()[0]?.toUpperCase() ?? "?"}
                </span>
                <span className="acct-id">
                  <span className="acct-name-line">
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
                      <span className="acct-label">{a.label}</span>
                    )}
                    {isPick && <span className="acct-default">New sessions</span>}
                    {st.text !== "Ready" && <span className={`acct-state st-${st.tone}`}>{st.text}</span>}
                  </span>
                  {signing?.id === a.id ? <Pending login={signing.login} tool={tool.tool} /> : confirm === a.id ? null : <span className="acct-sub">{who}</span>}
                  {signing?.id !== a.id && confirm !== a.id && a.loggedIn !== false && <UsageBars u={u} />}
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
                  ) : (
                    <>
                      {a.loggedIn === false && signing?.id !== a.id && (
                        <button type="button" className="btn primary small" disabled={busy === a.id} onClick={() => void signIn(a.id)}>
                          Sign in
                        </button>
                      )}
                      <MenuButton
                        className="icon-btn tiny acct-menu"
                        label={`${a.label}: more`}
                        icon="more"
                        end
                        compact
                        width={260}
                        items={() => [
                          { heading: a.label },
                          rows.length > 1 && { label: "Use for new sessions", checked: a.id === pick.id, disabled: a.loggedIn === false, sub: a.loggedIn === false ? "Sign in to it first" : undefined, onSelect: () => setPreferred(tool.tool, a.id) },
                          { label: "Rename", icon: "pencil", onSelect: () => setRenaming({ id: a.id, label: a.label }) },
                          a.loggedIn !== false && { label: "Sign in again", icon: "refresh", sub: "To switch it to another login", onSelect: () => void signIn(a.id) },
                          a.id === "default" ? { label: `Sign out of ${name}`, icon: "logout", danger: true, onSelect: () => setConfirm(a.id) } : { label: "Remove", icon: "trash", sub: "From this computer: its conversations stay", danger: true, onSelect: () => setConfirm(a.id) },
                        ]}
                      />
                    </>
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
                Add {rows.length > 1 ? "another" : "a second"} {name} account
              </button>
            </li>
          )}
          {rows.length > 1 && <li className="acct-foot">Friday never switches accounts by itself. Pick another for one session in the message box.</li>}
        </ul>
      )}
      {err && <p role="alert" className="error small">{err}</p>}
    </div>
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
export function AccountPill({ identity, tool, value, onChange }: { identity: Identity; tool: LocalTool; value: string; onChange: (id: string) => void }) {
  const usage = useAccountUsage(identity, tool.tool);
  const accounts = tool.accounts ?? [];
  const preferred = usePreferredAccount(tool.tool, accounts);
  const current = value || preferred;
  const now = accounts.find((a) => a.id === current);
  return (
    <MenuButton
      className={`agent-pill account-pill${now?.out ? " out" : ""}`}
      label={`${ENGINE_NAMES[tool.tool]} account`}
      text={now?.label ?? "Main"}
      width={300}
      above
      items={() => [
        { heading: `${ENGINE_NAMES[tool.tool]} account for this session` },
        ...accounts.map((a) => {
          const u = usage?.find((x) => x.id === a.id);
          const note = a.out ? `Out of usage${a.outUntil ? ` until ${clock(a.outUntil)}` : ""}` : a.loggedIn === false ? "Signed out: sign in from your computer's tools" : tightest(u);
          return { label: a.label, hint: a.id === preferred ? "Default" : undefined, sub: [u?.email, note].filter(Boolean).join(" · ") || undefined, checked: current === a.id, disabled: a.loggedIn === false, onSelect: () => onChange(a.id) };
        }),
      ]}
    />
  );
}
