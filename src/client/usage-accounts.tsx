import { useCallback, useEffect, useState } from "react";
import { AddAccount, ACCOUNT_TOOLS, Pending, useAccountActions } from "./Accounts.js";
import { AccountRow } from "./account-glance.js";
import { EngineMark } from "./BrandMarks.js";
import { accountViews, type AccountView } from "./gauge.js";
import { Icon } from "./icons.js";
import { hostApi, type LocalTool } from "./local.js";
import type { Identity } from "./storage.js";
import type { Read } from "./toolLimits.js";
import { MenuButton } from "./ui.js";

/**
 * The Usage page's accounts (Arun, 2026-11-17: the Usage page mockup): a card per tool with "Add account", and a row per account with
 * its ring, who it is, its week and its 5 hours (account-glance.tsx AccountRow), and its menu (Accounts.tsx useAccountActions). Kept
 * apart from the rail's card, so the first load doesn't carry adding, renaming and removing accounts.
 */

/** One tool's accounts on the Usage page: a row each with its ring, and its menu; "Add account" in the head. */
function ToolAccounts({ identity, tool, read, onChanged }: { identity: Identity; tool: LocalTool; read: Read; onChanged: () => void }) {
  const a = useAccountActions(identity, tool, onChanged);
  const views = accountViews(read, tool.tool);
  // Every account the computer has, read or not yet: a new one shows as soon as it's added, its figures when they come.
  // Each account with its reading, the one in use first (Arun, 2026-11-17: "make sure the inuse one is on top").
  const rows = a.rows
    .map((row) => ({ row, v: views.find((v) => v.id === row.id) ?? (a.rows.length === 1 && views.length === 1 ? views[0]! : ({ id: row.id, label: row.label, email: null, plan: null, five: null, week: null, out: "", more: [] } as AccountView)) }))
    .sort((x, y) => Number(a.many && y.row.id === a.pick.id) - Number(a.many && x.row.id === a.pick.id));
  return (
    <section className="acg-tool" aria-label={`${a.name} accounts`}>
      <header className="acg-head">
        <EngineMark tool={tool.tool} size={15} />
        <b>{a.name}</b>
        <span className="acg-n">{a.many ? `${a.rows.length} accounts` : "1 account"}</span>
        {!a.adding && (
          <button type="button" className="acg-add" onClick={() => a.setAdding(true)} title={`Add ${a.many ? "another" : "a second"} ${a.name} account: a sign-in of its own, kept apart`}>
            <Icon name="plus" size={13} />
            Add account
          </button>
        )}
      </header>
      {a.adding && <AddAccount identity={identity} tool={tool.tool} taken={a.rows.map((r) => r.label)} onCancel={() => a.setAdding(false)} onAdded={(id, login) => (a.setAdding(false), a.setSigning({ id, login }), onChanged())} />}
      <ul className="acg-list">
        {rows.map(({ row, v }) => {
          const label = row.id === "default" && !a.many ? "Main" : row.label;
          return (
            <AccountRow
              key={v.id}
              tool={tool.tool}
              v={{ ...v, label, ...(row.loggedIn === false ? { out: "Signed out" } : {}) }}
              inUse={a.many && row.id === a.pick.id}
              page
              end={
                <span className="acg-end">
                  {row.loggedIn === false && (
                    <button type="button" className="btn primary small" disabled={a.busy === row.id} onClick={() => void a.signIn(row.id)}>
                      Sign in
                    </button>
                  )}
                  <MenuButton className="icon-btn tiny" label={`${label}: more`} icon="more" end compact width={260} items={() => a.menu(row)().filter(Boolean) as never} />
                </span>
              }
            />
          );
        })}
      </ul>
      {a.signing && <Pending login={a.signing.login} tool={tool.tool} />}
      {a.confirm && (
        <p className="acct-confirm">
          {a.confirm === "default" ? `Signs ${a.name} out on this computer, for everything that uses it, not just Friday.` : `Signs ${a.rows.find((r) => r.id === a.confirm)?.label ?? "it"} out and takes it off this computer. Its conversations stay.`}
          <span className="acct-confirm-acts">
            <button type="button" className="btn ghost small" onClick={() => a.setConfirm("")}>
              Keep
            </button>
            <button type="button" className="btn destructive small" disabled={a.busy === a.confirm} onClick={() => void (a.confirm === "default" ? a.signOut(a.confirm) : a.remove(a.confirm))}>
              {a.confirm === "default" ? "Sign out" : "Remove"}
            </button>
          </span>
        </p>
      )}
      {a.renaming && (
        <form className="acg-rename" onSubmit={(e) => (e.preventDefault(), a.rename(a.renaming!.id, a.renaming!.label))}>
          <input autoFocus value={a.renaming.label} maxLength={40} aria-label="New name" onChange={(e) => a.setRenaming({ id: a.renaming!.id, label: e.target.value })} onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), a.setRenaming(null))} />
          <button type="button" className="btn ghost small" onClick={() => a.setRenaming(null)}>
            Cancel
          </button>
          <button type="submit" className="btn primary small">
            Rename
          </button>
        </form>
      )}
      {a.err && <p role="alert" className="error small">{a.err}</p>}
    </section>
  );
}

/** The Usage page's accounts: Claude Code's and Codex's, installed here, each with its accounts. */
export function UsageAccounts({ identity, read }: { identity: Identity; read: Read }) {
  const [tools, setTools] = useState<LocalTool[] | null>(null);
  const look = useCallback(() => void hostApi<{ tools: LocalTool[] }>(identity, "/api/runner/tools").then((r) => setTools(r.tools ?? []), () => setTools([])), [identity]);
  useEffect(look, [look]);
  const shown = (tools ?? []).filter((t) => ACCOUNT_TOOLS.includes(t.tool) && t.path);
  if (!shown.length) return null;
  return (
    <section className="acg-page" aria-label="Accounts">
      <div className="lh-section-head">
        <h3 className="m-0 text-[13px] font-semibold text-[var(--ink)]">Accounts</h3>
        <span className="text-[12px] text-[var(--text-muted)]">Friday never moves an agent between them by itself.</span>
      </div>
      {shown.map((t) => (
        <ToolAccounts key={t.tool} identity={identity} tool={t} read={read} onChanged={look} />
      ))}
    </section>
  );
}
