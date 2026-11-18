import type { ReactNode } from "react";
import { ENGINE_NAMES, type EngineTool } from "../types.js";
import { EngineMark } from "./BrandMarks.js";
import { accountViews, inUseAccount, RailRing, type AccountView } from "./gauge.js";
import type { Identity } from "./storage.js";
import { useToolLimits } from "./toolLimits.js";

/**
 * A coding tool's accounts, each with who it is, how much of its week and its 5 hours is used, and where it stands (Arun, 2026-11-17:
 * "adding support for multiple coding tool accounts and show their emails like click to reveal", design 1 of the mockups, then
 * "i need a mockup for in the usage page as well"): in the card over a rail ring (AccountGlance) and on the Usage page, where each
 * has its ring and its menu too (UsageAccounts).
 */

const band = (used: number) => (used >= 90 ? "red" : used >= 70 ? "orange" : "green");

/** One window as a bar: its name, the bar in its band, how much is used and when it starts over. */
function Bar({ name, row }: { name: string; row: AccountView["five"] }) {
  if (!row) return null;
  const used = row.used;
  return (
    <div className="acg-bar">
      <span className="acg-bar-name">{name}</span>
      <span className="acg-bar-track" aria-hidden="true">
        {used !== null && <i className={band(used)} style={{ width: `${Math.max(2, used)}%` }} />}
      </span>
      <span className="acg-bar-said">
        <span>{row.text ?? (used === null ? "—" : `${Math.round(used)}% used`)}</span>
        {row.resets && <span className="acg-bar-reset">{row.resets.replace(/^Resets in /, "in ")}</span>}
      </span>
    </div>
  );
}

/** "Resets in 2h 05m" → "2h", for the ring's middle when a used-up 5 hours says when it's back. */

export function AccountRow({ tool, v, inUse, page = false, end }: { tool: EngineTool; v: AccountView; inUse: boolean; page?: boolean; end?: ReactNode }) {
  const five = v.out ? 100 : (v.five?.used ?? null);
  return (
    <li className={`acg-acct${page ? " page" : ""}`} aria-label={`${v.label} account`}>
      {page && (five !== null || v.week?.used != null ? <RailRing tool={tool} outer={five ?? v.week!.used!} inner={five !== null ? (v.week?.used ?? null) : null} /> : <span className="acg-ring-none" aria-hidden="true" />)}
      <div className="acg-who">
        <div className="acg-top">
          {/* The one new sessions use: a green dot before its name (Arun, 2026-11-17: "instead of the in use tag … a green dot"). */}
          {inUse && <span className="acg-dot" title="New sessions use this account" aria-label="In use" role="img" />}
          <b>{v.label}</b>
          {/* Its plan and where it stands, at the right of its name (Arun, 2026-11-17: "move the tags over to the right side"). */}
          <span className="acg-tags">
            {v.plan && <span className="acg-tag">{v.plan}</span>}
            {v.out && <span className="acg-tag out">{v.out}</span>}
          </span>
        </div>
        {/* Its email as it is ("get rid of the hidden thing… and its logic for the emails too"). */}
        {v.email && <span className="acg-mail" title={v.email}>{v.email}</span>}
      </div>
      <div className="acg-bars">
        <Bar name="Weekly" row={v.week} />
        <Bar name="5-hour" row={v.five} />
        {/* A model's own week, on the Usage page ("Weekly · Fable" as "Fable week"): the card over the rail keeps to the two. */}
        {page && v.more.map((r) => <Bar key={r.label} name={r.label.replace(/^(?:\S+ · )?Weekly · (.+)$/, "$1 week")} row={r} />)}
        {!v.week && !v.five && !v.out && <span className="acg-none">No reading yet: its limits show after its next turn.</span>}
      </div>
      {end}
    </li>
  );
}

/** The card over a rail ring, for a tool with more than one account: each of them, the one in use first marked. */
export function AccountGlance({ tool, identity }: { tool: EngineTool; identity: Identity }) {
  const views = accountViews(useToolLimits(identity), tool);
  const using = inUseAccount(tool, views.map((v) => v.id));
  return (
    <div className="ag">
      <div className="acg-head">
        <EngineMark tool={tool} size={14} />
        <b>{ENGINE_NAMES[tool]}</b>
        <span className="acg-n">{views.length} accounts</span>
      </div>
      <ul className="acg-list">
        {/* The one in use first (Arun, 2026-11-17: "make sure the inuse one is on top"), the rest in the order they refill. */}
        {[...views].sort((x, y) => Number(y.id === using) - Number(x.id === using)).map((v) => (
          <AccountRow key={v.id} tool={tool} v={v} inUse={v.id === using} />
        ))}
      </ul>
    </div>
  );
}
