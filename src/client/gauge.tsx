import { useContext, useEffect, useState } from "react";
import type { ToolContext } from "../runner/context-report.js";
import { PatchSource } from "./patchSource.js";
import { ENGINE_MODEL_INFO, ENGINE_NAMES, ENGINE_TOOLS, MAIN_LANE, TOOL_INFO, type EngineTool, type SessionEvent } from "../types.js";
import { clockUntil } from "../limit-reset.js";
import type { Limits } from "../runner/limits.js";
import { EngineMark } from "./BrandMarks.js";
import { Icon } from "./icons.js";
import { hostApi } from "./local.js";
import type { Identity } from "./storage.js";
import { ContextMenu, Skeleton } from "./ui.js";
import type { WorkspaceUsage } from "./workspace-types.js";

/**
 * How full the conversation is, as a ring beside the composer; press it for the context bar, the usage behind Friday's
 * own models, and what each coding tool says about its own limits.
 *
 * The last step's token count is how much the model was handed on that step, so it stands in for the size of the
 * context, measured against the window of the model the session runs on.
 */
// ponytail: windows by vendor, not per model; an exact table if the bar needs to be exact
function windowOf(model: string): number {
  if (/gemini/.test(model)) return 1_000_000;
  if (/gpt-5/.test(model)) return 400_000;
  if (/claude/.test(model)) return 200_000;
  return 128_000;
}

/** A coding tool's window: Claude Code's models by their family, Codex's GPT-5 and Gemini CLI's by theirs, the rest by model name. */
function windowFor(tool: EngineTool | undefined, model: string): number {
  if (tool === "claude") return 200_000;
  if (tool === "codex") return 400_000;
  if (tool === "gemini") return 1_000_000;
  return windowOf(model);
}

/** One of Friday's own models by name: the hosted Friday's catalogue; the local edition has none. */
let fridayModelName = (_model: string): string | undefined => undefined;
const nameOf = (model: string) => fridayModelName(model) ?? (model ? model.split("/").pop()! : "Friday");

const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);

// One size for every tab, so the card opens in the same place whichever is showing.
const POP_H = 218;
/** As wide as a menu may be: the popover's right edge sits on the ring, and the rest of it reaches left. */
const POP_W = 380;

type Tab = "friday" | EngineTool;

/** The tools whose limits Friday reads on the machine: these always have a glance. Another tool has one only on its own lane. */
const LIMITED: EngineTool[] = ["claude", "codex", "cursor", "copilot"];
const tabsFor = (tool?: EngineTool): [Tab, string][] => [["friday", "Friday"], ...[...LIMITED, ...(tool && !LIMITED.includes(tool) ? [tool] : [])].map((t): [Tab, string] => [t, ENGINE_NAMES[t]])];

const until = (sec: number) => {
  const m = Math.max(0, Math.round((sec * 1000 - Date.now()) / 60_000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
};

import { useToolLimits, type Read } from "./toolLimits.js";
/**
 * One limit at a glance: a short name, how much of it is used, and when it starts over. `text`: said instead (credits left). `win`:
 * which window it is, the five hours or the week, and `account` whose, so the ring finds its own by what it is rather than by a
 * label that has an account's name in front of it with more than one account (2026-10-27 audit).
 */
type Row = { label: string; used: number | null; resets: string; text?: string; win?: "5h" | "week" | "out"; account?: string };

/** Which window a limit is, by what its tool calls it or by its length. */
const winOf = (kind: string | null | undefined, minutes: number | null | undefined): Row["win"] =>
  kind === "five_hour" || minutes === 300 ? "5h" : kind === "seven_day" || minutes === 10_080 ? "week" : undefined;
/** A tool at a glance: its limits, or the one short line that stands in for them. */
type Glance = { plan?: string; rows: Row[]; empty?: string; link?: { label: string; href: string }; /** Why some limits are missing, said under what is there. */ note?: string };

const SHORT: Record<string, string> = { five_hour: "5h", seven_day: "Weekly", seven_day_opus: "Weekly · Opus", seven_day_sonnet: "Weekly · Sonnet", overage: "Extra" };
const shortWindow = (min: number) => (min >= 40_000 ? "Monthly" : min >= 10_080 ? "Weekly" : min >= 60 ? `${Math.round(min / 60)}h` : `${min}m`);

/**
 * One window as last read. One whose reset has passed since has started over, and how much of the new one is used was never read:
 * it says when it started over, not a 0% nobody measured (Arun, 2026-10-27, of "5h · 0% used · Reset" with Claude in use). Claude
 * Code gives a figure only as a limit nears; until then its "allowed" is said as it is.
 */
function row(label: string, usedPct: number | null, resetsAt: number | null, status?: string | null): Row {
  // A day ago or more says which day too: a bare time read as today's (2026-10-27 audit).
  if (resetsAt && resetsAt * 1000 <= Date.now()) return { label, used: null, resets: "", text: `Started over at ${new Date(resetsAt * 1000).toLocaleString([], Date.now() - resetsAt * 1000 >= 86_400_000 ? { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } : { hour: "numeric", minute: "2-digit" })}` };
  const resets = resetsAt ? `Resets in ${until(resetsAt)}` : "";
  if (usedPct === null && status === "rejected") return { label, used: 100, resets, text: "Out of usage" };
  if (usedPct === null && status === "allowed") return { label, used: null, resets, text: "Under the limit" };
  return { label, used: usedPct === null ? null : Math.max(0, Math.min(100, usedPct)), resets };
}

/** What each tool's glance says, from one reading of this computer. */
export function glanceOf(limits: Read): Record<EngineTool, Glance> {
  const elsewhere = (t: EngineTool): Glance => {
    const url = TOOL_INFO[t].usage;
    return { rows: [], empty: "Not shared on this computer", ...(url ? { link: { label: `See usage on ${new URL(url).hostname.replace(/^www\./, "")}`, href: url } } : {}) };
  };
  const none = limits === "none" ? "Connect your computer" : limits === null ? "…" : "";
  const got = limits && limits !== "none" ? limits : null;
  const codex = got?.codex ?? null;
  // Every Codex window when the computer says them (Friday 0.1.33 on), else the one it always did.
  const codexRows = got?.codexWindows?.length
    ? got.codexWindows.map((w) => ({ ...row(w.windowMinutes ? shortWindow(w.windowMinutes) : "Limit", w.usedPercent, w.resetsAt), win: winOf(w.kind, w.windowMinutes) }))
    : codex
      ? [{ ...row(shortWindow(codex.windowMinutes), codex.usedPercent, codex.resetsAt), win: winOf(null, codex.windowMinutes) }]
      : [];
  const cursor = got?.cursor ?? null;
  // The other tools read on this computer (tool-limits.ts): their windows, the credits left where they sell credits, and the age
  // of a reading kept from before their sign-in lapsed.
  const others = Object.fromEntries(
    Object.entries(got?.tools ?? {}).map(([t, a]): [EngineTool, Glance] => {
      const url = TOOL_INFO[t as EngineTool].usage;
      const rows = [
        ...a!.windows.map((w) => ({ ...row(w.label ?? (w.windowMinutes ? shortWindow(w.windowMinutes) : "Limit"), w.usedPercent, w.resetsAt), win: winOf(w.kind, w.windowMinutes) })),
        ...(a!.balanceUsd !== undefined ? [{ label: "Credits", used: null, resets: "", text: `$${a!.balanceUsd.toFixed(2)} left` }] : []),
      ];
      const ago = Math.round((Date.now() - a!.at) / 60_000);
      return [
        t as EngineTool,
        {
          ...(a!.plan ? { plan: a!.plan } : {}),
          rows,
          empty: a!.why ?? "No limits on this plan",
          ...(rows.length && a!.stale ? { note: `${ago < 60 ? `${ago}m` : ago < 1440 ? `${Math.round(ago / 60)}h` : `${Math.round(ago / 1440)}d`} ago · ${a!.why ?? ""}` } : {}),
          ...(url ? { link: { label: `See usage on ${new URL(url).hostname.replace(/^(www|app)\./, "")}`, href: url } } : {}),
        },
      ];
    }),
  ) as Partial<Record<EngineTool, Glance>>;
  /**
   * A tool with more than one account on the computer (runner/accounts.ts): each account's windows, under its name, so both are
   * seen at once and the one a lane runs on can be told from the other. One out of usage says until when instead.
   */
  const byAccount = (t: "claude" | "codex"): Row[] | null => {
    const all = got?.accounts?.[t];
    if (!all?.length) return null;
    return all.flatMap((a): Row[] => {
      // Out until a time that has passed is back: a reading kept from then (this page's cache too) no longer says it is out
      // (2026-10-27 audit: "Out until 3:00 PM" stood red after three).
      const back = !!a.outUntil && a.outUntil <= Date.now();
      if (a.out && !back) return [{ label: a.label, used: 100, resets: "", text: a.outUntil ? `Out until ${clockUntil(a.outUntil)}` : "Out of usage", win: "out", account: a.id }];
      if (a.windows.length) return a.windows.map((w) => ({ ...row(`${a.label} · ${SHORT[w.kind] ?? (w.windowMinutes ? shortWindow(w.windowMinutes) : (w.label ?? "Limit"))}`, w.usedPercent, w.resetsAt, w.status), win: winOf(w.kind, w.windowMinutes), account: a.id }));
      return [{ label: a.label, used: null, resets: "", text: a.out && back ? `Back since ${new Date(a.outUntil!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : (a.why ?? "No reading yet"), account: a.id }];
    });
  };
  const claudeAccounts = byAccount("claude");
  const codexAccounts = byAccount("codex");
  return {
    ...(Object.fromEntries(ENGINE_TOOLS.map((t) => [t, elsewhere(t)])) as Record<EngineTool, Glance>),
    ...others,
    claude: {
      ...(got?.claudePlan ? { plan: got.claudePlan } : {}),
      rows: claudeAccounts ?? (got?.claudeWindows ?? []).map((w) => ({ ...row(SHORT[w.kind ?? ""] ?? w.label ?? "Limit", w.utilization === null ? null : w.utilization * 100, w.resetsAt, w.status), win: winOf(w.kind, null) })),
      // A slow answer is not a fault to report: "didn't answer in time" beside the context's own "Asking…" read as the card
      // contradicting itself (2026-10-29 verify). Said as what happens next, here, so an older computer's words are covered too.
      empty: none || (got?.claudeWhy && /didn't answer in time/.test(got.claudeWhy) ? "Its limits show here after its next turn." : got?.claudeWhy) || "No reading yet",
      // What Claude Code itself said of its limits, asked (`get_usage`) or as it last ran in Friday, and how long ago. Its sign-in
      // is never read: runner/limits.ts.
      ...(got?.claudeWindows?.length ? { note: got.claudeFrom === "account" ? `From Claude Code, ${keptAgo(got.claudeWindows)}` : `From Claude Code's last run in Friday, ${keptAgo(got.claudeWindows)}` } : {}),
    },
    codex: {
      ...(codex?.plan ? { plan: codex.plan } : {}),
      rows: codexAccounts ?? codexRows,
      empty: none || "No reading yet",
    },
    cursor: {
      ...(cursor?.plan ? { plan: cursor.plan } : {}),
      rows: (cursor?.windows ?? []).map((w) => row(w.label ?? "Included", w.usedPercent, w.resetsAt)),
      empty: none || cursor?.why || (cursor ? "No usage on this plan" : "Not shared on this computer"),
      link: { label: "See usage on cursor.com", href: "https://cursor.com/dashboard?tab=usage" },
    },
    copilot: {
      ...(got?.copilot?.plan ? { plan: got.copilot.plan } : {}),
      rows: (got?.copilot?.windows ?? []).map((w) => row(w.label ?? "Allowance", w.usedPercent, w.resetsAt)),
      empty: none || got?.copilot?.why || (got?.copilot ? "No allowance on this plan" : "Not shared on this computer"),
      link: { label: "See usage on github.com", href: "https://github.com/settings/copilot/features" },
    },
  };
}


/** One tool at a glance: its plan, then a bar per limit that fills as it is used. Amber from 70% used, red from 90%. */
function ToolGlance({ tool, g, bare = false }: { tool: EngineTool; g: Glance; /** Under a tab that already says which tool: just its limits. */ bare?: boolean }) {
  return (
    <section className="lg-tool">
      {!bare && (
        <div className="lg-head">
          <EngineMark tool={tool} size={14} />
          <b>{ENGINE_NAMES[tool]}</b>
          {g.plan && <span className="lg-plan">{g.plan}</span>}
        </div>
      )}
      {g.rows.length ? (
        // By place as well as label: two accounts' rows, or two windows a tool names alike, shared a key (2026-10-27 audit).
        g.rows.map((r, i) => (
          <div key={`${i}:${r.label}`} className={`lg-row ${r.used === null ? "" : r.used >= 90 ? "low" : r.used >= 70 ? "mid" : ""}`}>
            {/* The same three lines in every row, whatever the numbers: what and how much, the bar, when it resets. On one
                line, a wider "100% used" pushed the reset time under it in that row only. */}
            <div className="lg-line">
              <span className="lg-label">{r.label}</span>
              <span className="lg-used">{r.text ?? (r.used === null ? "—" : `${Math.round(r.used)}% used`)}</span>
            </div>
            {!r.text && (
              <div className="lg-bar">
                <i style={{ width: `${r.used ?? 0}%` }} />
              </div>
            )}
            {r.resets && <div className="lg-reset">{r.resets}</div>}
          </div>
        ))
      ) : g.empty === "…" ? (
        // The very first reading on this computer: two bars' worth of shape until it lands.
        [0, 1].map((i) => (
          <div key={i} className="lg-row sk-glance" aria-hidden>
            <Skeleton w={i ? "38%" : "52%"} h={11} />
            <Skeleton h={6} r={3} />
          </div>
        ))
      ) : (
        <div className="lg-empty">
          {g.empty}
          {g.link && (
            <a href={g.link.href} target="_blank" rel="noreferrer">
              {g.link.label}
            </a>
          )}
        </div>
      )}
      {g.note && g.rows.length > 0 && <p className="lg-note">{g.note}</p>}
    </section>
  );
}

/** The limits Friday can read, one tool under another: the rail's Usage card, and a Solo session's. */
export function CodingToolLimits({ identity }: { identity: Identity }) {
  const limits = useToolLimits(identity);
  const g = glanceOf(limits);
  // The four always, then every other tool this computer has a reading for.
  const read = limits && limits !== "none" ? limits.tools ?? {} : {};
  const shown = ENGINE_TOOLS.filter((t) => LIMITED.includes(t) || read[t]);
  return (
    <div className="lg-glance">
      {shown.map((t) => (
        <ToolGlance key={t} tool={t} g={g[t]} />
      ))}
    </div>
  );
}

/**
 * What a session's ring opens: a tab for each coding tool, each a glance at its limits, and on Team one for Friday's own agent
 * (its context and allowance) too. One size for every tab, so the card doesn't jump as they are switched.
 */
function PopBody({ identity, first, ws, ctx, solo, lane, live }: { identity: Identity; first: Tab; ws: WorkspaceUsage | null | undefined; ctx: { model: string; tokens: number; window: number }; solo: boolean; /** The agent the box is aimed at, whose tool is `first`. */ lane?: string; /** Its context at the end of its last turn, as its tool said. */ live?: { used: number; window: number } | null }) {
  const [tab, setTab] = useState<Tab>(first);
  const limits = useToolLimits(identity);
  const glance = glanceOf(limits);
  return (
    <div className={`lim ${solo ? "solo" : ""}`}>
      <div className="lim-tabs" role="tablist">
        {tabsFor(first === "friday" ? undefined : first).filter(([id]) => !(solo && id === "friday")).map(([id, label]) => (
          // The tab is the tool's name now (there is no heading under it), so its plan is said here.
          <button key={id} type="button" role="tab" aria-label={label} title={id !== "friday" && glance[id].plan ? `${label} · ${glance[id].plan}` : label} aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            <EngineMark tool={id === "friday" ? "" : id} size={16} />
          </button>
        ))}
      </div>
      {tab === "friday" ? (
        <>
        </>
      ) : (
        <>
          {/* The agent's own context, by what fills it, above its tool's limits (Arun, 2026-10-21: "just like claude code does it"). */}
          {tab === first && lane && <ToolContextView tool={tab} lane={lane} live={live ?? null} />}
          <div className="lg-glance lg-one">
            <ToolGlance tool={tab} g={glance[tab]} bare />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The rows of a tool's glance that are the lane's: with more than one account on the computer, those of the account it runs on
 * (its lane's `account`, else the first, its default), each labelled with the account's name; with one, all of them.
 */
function rowsFor(tool: EngineTool, limits: Read, account?: string): Row[] {
  const rows = glanceOf(limits)[tool]?.rows ?? [];
  if (!rows.some((r) => r.account)) return rows;
  const id = account && rows.some((r) => r.account === account) ? account : rows.find((r) => r.account)!.account;
  return rows.filter((r) => r.account === id);
}

/**
 * A tool's 5-hour window as the glance reads it (Claude Code's five_hour, a 300-minute Codex window), when it has one: found by
 * which window it is, for the account the lane runs on. An account out of usage is full until it comes back.
 */
export function fiveHourOf(tool: EngineTool | undefined, limits: Read, account?: string): { used: number; resets: string } | null {
  if (!tool) return null;
  const rows = rowsFor(tool, limits, account);
  const out = rows.find((x) => x.win === "out");
  if (out) return { used: 100, resets: out.text ?? "" };
  const r = rows.find((x) => x.win === "5h" && x.used !== null);
  return r ? { used: r.used!, resets: r.resets } : null;
}

/** A tool's weekly window as the glance reads it, for the account the lane runs on, when it has a figure. */
export function weekOf(tool: EngineTool | undefined, limits: Read, account?: string): Row | null {
  if (!tool) return null;
  return rowsFor(tool, limits, account).find((x) => x.win === "week" && x.used !== null) ?? null;
}

export function ContextGauge({ events, model = "", identity, tool, lane, solo = false, account }: { events: SessionEvent[]; friday: boolean; model?: string; identity: Identity; tool?: EngineTool; /** The agent the message box is aimed at: the ring is its context, not the whole session's. */ lane?: string; /** Solo: the coding tools' glance, and no Friday tab. */ solo?: boolean; /** Which of the tool's accounts on the computer the lane runs on, when it has more than one. */ account?: string }) {
  const WINDOW = windowFor(tool, model);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  // undefined while it is being read, null when it couldn't be.
  const [ws, setWs] = useState<WorkspaceUsage | null | undefined>(undefined);
  const used = events.findLast((e) => e.body.type === "agent.message" && (e.body.tokens ?? 0) > 0 && (!lane || (e.lane ?? MAIN_LANE) === lane))?.body;
  const tokens = used && used.type === "agent.message" ? (used.tokens ?? 0) : 0;
  // A coding tool's context, as it said at the end of its last turn: its last model call's input against its model's window.
  const toolUsage = tool ? events.findLast((e) => e.body.type === "agent.usage" && (e.body.context ?? 0) > 0 && (!lane || (e.lane ?? MAIN_LANE) === lane))?.body : undefined;
  const live = toolUsage?.type === "agent.usage" ? { used: toolUsage.context!, window: toolUsage.window || WINDOW } : null;
  // A coding tool's ring is its 5-hour limit, the one a working day runs into; never a weekly or monthly one. A tool that has no
  // 5-hour window (Cursor and Copilot sell monthly allowances) shows its context instead, and says so.
  const limits = useToolLimits(identity);
  const five = fiveHourOf(tool, limits, account);
  // The week beside the five hours, as Orca's bar says both ("17% 5h · 43% wk"): the week is what a long day runs into next.
  const week = weekOf(tool, limits, account);
  // A coding tool's context is what it said of it (agent.usage), not Friday's own count; until it has said, there is no figure
  // to show, and "0%" with "context 0 of 200k" beside a card saying "Not reported yet" disagreed with itself (2026-10-27 audit).
  const ctxUsed = tool ? (live?.used ?? 0) : tokens;
  const ctxWindow = tool ? (live?.window ?? WINDOW) : WINDOW;
  const reported = !!five || (tool ? !!live : tokens > 0);
  const pct = five ? five.used / 100 : Math.min(1, ctxUsed / ctxWindow);
  // A thin ring and how full it is beside it, in figures (2026-10-27 design review: a bare ring was a shape to decode); the tooltip
  // and the card say whose limit it is.
  const r = 9;
  const c = 2 * Math.PI * r;
  const tone = pct >= 0.9 ? "hot" : pct >= 0.7 ? "warm" : "";
  // Which agent and model this is, said on the ring: switch the box to Codex and it reads Codex's context, under Codex's name.
  const who = tool ? [ENGINE_NAMES[tool], ENGINE_MODEL_INFO[tool]?.find((m) => m.id === model)?.label ?? (model && model !== "auto" ? model : "")].filter(Boolean).join(" · ") : nameOf(model);
  return (
    <>
      <button
        type="button"
        className={`ctx-gauge ${tool ? "has-mark " : ""}${tone || "ok"}`}
        title={five ? `${who} · 5-hour limit ${Math.round(five.used)}% used${five.resets ? ` · ${five.resets}` : ""}${week ? ` · weekly ${Math.round(week.used!)}% used` : ""}` : reported ? `${who} · Context ${compact(ctxUsed)} of ${compact(ctxWindow)}` : `${who} · Context: not reported yet`}
        aria-label={five ? `${who}: 5-hour limit ${Math.round(five.used)}% used` : reported ? `${who}: context ${Math.round(pct * 100)}% full` : `${who}: context not reported yet`}
        // Its own press isn't "outside" the card it opened: without this the card closed on mousedown and the click opened it again.
        onMouseDown={(e) => e.stopPropagation()}
        aria-expanded={!!at}
        onClick={(e) => {
          const b = e.currentTarget.getBoundingClientRect();
          // Opens to the left of the ring, from its right edge; the menu keeps itself inside the window.
          setAt(at ? null : { x: b.right, y: b.top - 6 });
          if (!solo) void fetch("/api/workspace", { credentials: "same-origin" }).then((r) => r.json()).then((d: { workspace?: WorkspaceUsage }) => setWs(d.workspace ?? null), () => setWs(null));
        }}
      >
        <svg className="ctx-ring" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
          <circle cx="11" cy="11" r={r} fill="none" stroke="currentColor" strokeOpacity=".22" strokeWidth="2.25" />
          <circle cx="11" cy="11" r={r} fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeDasharray={`${c * pct} ${c}`} transform="rotate(-90 11 11)" />
        </svg>
        <span className="ctx-pct" aria-hidden="true">
          {reported ? `${Math.round(pct * 100)}%` : "–"}{five && <em> 5h</em>}
          {five && week && (
            <>
              <i> · </i>
              {Math.round(week.used!)}%<em> wk</em>
            </>
          )}
        </span>
      </button>
      {at && (
        <ContextMenu
          at={at}
          end
          width={POP_W}
          onClose={() => setAt(null)}
          items={() => [
            { node: <PopBody identity={identity} first={tool ?? (solo ? "claude" : "friday")} ws={ws} ctx={{ model, tokens, window: WINDOW }} solo={solo} {...(tool && lane ? { lane, live } : {})} />, height: tool === "claude" ? POP_H + 300 : tool ? POP_H + 70 : POP_H },
          ]}
        />
      )}
    </>
  );
}

/** What a category of Claude Code's context is drawn in, by its name: the same colour wherever it is shown. */
function hueOf(name: string): string {
  const n = name.toLowerCase();
  if (n.startsWith("free")) return "free";
  if (n.startsWith("autocompact")) return "buffer";
  if (n.startsWith("messages")) return "messages";
  if (n.startsWith("mcp")) return "mcp";
  if (n.startsWith("system tools")) return "tools";
  if (n.startsWith("system prompt")) return "prompt";
  if (n.startsWith("skills")) return "skills";
  if (n.startsWith("memory")) return "memory";
  if (n.includes("agent")) return "agents";
  return "other";
}

/**
 * A coding tool's context, the way Claude Code's own /context shows it: how full the window is, a bar split by what fills it
 * (system prompt, tools, MCP tools, skills, messages, the autocompact buffer, free space), a row each, and which MCP servers
 * take the most. Claude Code says the breakdown itself, asked of a copy of the conversation (Runner.toolContext); for another
 * tool it is how full it is, as it said at the end of its last turn.
 */
/** Each lane's last context report, by session and lane, so the card opens on it while it is asked again. */
const seenContext = new Map<string, ToolContext>();

function ToolContextView({ tool, lane, live }: { tool: EngineTool; lane: string; live: { used: number; window: number } | null }) {
  const src = useContext(PatchSource);
  const seenKey = `${src?.sid ?? ""}:${lane}`;
  // undefined while it is asked, null when it couldn't be. Opened again, the last report shows at once while it is asked anew.
  const [ctx, setCtx] = useState<ToolContext | null | undefined>(tool === "claude" ? seenContext.get(seenKey) : null);
  useEffect(() => {
    if (tool !== "claude" || !src) return setCtx(null);
    let on = true;
    void fetch(`/api/sessions/${encodeURIComponent(src.sid)}/repo?op=context&lane=${encodeURIComponent(lane)}&invite=${encodeURIComponent(src.invite)}`, { credentials: "same-origin" })
      .then((r) => r.json() as Promise<{ output?: string }>)
      .then((j) => {
        const got = (JSON.parse(j.output ?? "{}") as { context?: ToolContext | null }).context ?? null;
        if (got) seenContext.set(seenKey, got);
        // Nothing this time keeps the one already showing: a slow or failed ask isn't a reason to empty the card.
        if (on) setCtx((was) => got ?? was ?? null);
      })
      .catch(() => on && setCtx((was) => was ?? null));
    return () => {
      on = false;
    };
  }, [tool, lane, src?.sid, src?.invite]);
  const used = ctx?.used ?? live?.used ?? 0;
  const window = ctx?.window ?? live?.window ?? 0;
  const pct = window ? Math.min(100, (used / window) * 100) : 0;
  // What is in the window, without what is only loaded when used ("deferred"), which the window doesn't hold yet.
  const shown = (ctx?.categories ?? []).filter((c) => !/deferred/i.test(c.name) && c.tokens > 0);
  const deferred = (ctx?.categories ?? []).filter((c) => /deferred/i.test(c.name) && c.tokens > 0);
  const total = shown.reduce((n, c) => n + c.tokens, 0) || 1;
  const tone = pct >= 90 ? "hot" : pct >= 70 ? "warm" : "";
  // The rows fold under the header and the bar, closed until asked for (Arun, 2026-10-24: "make this collapsable and have it be
  // closed on default"): how full it is reads at a glance, what fills it is a press away.
  const [open, setOpen] = useState(false);
  // Nothing reported: one quiet line, without an empty bar or a caret that opens onto nothing.
  if (!window && ctx !== undefined && !shown.length)
    return (
      <section className="ctx-tool none" aria-label={`${ENGINE_NAMES[tool]}'s context`}>
        <div className="ctx-tool-head">
          <span className="ctx-tool-title">Context</span>
          <span className="ctx-tool-n">Not reported yet</span>
        </div>
      </section>
    );
  return (
    <section className={`ctx-tool ${tone} ${open ? "open" : ""}`} aria-label={`${ENGINE_NAMES[tool]}'s context`}>
      <button type="button" className="ctx-tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="chevronDown" size={13} className="ctx-tool-caret" />
        <span className="ctx-tool-title">Context{ctx?.model ? <span className="ctx-tool-model"> · {ctx.model}</span> : null}</span>
        <span className="ctx-tool-n">
          {ctx?.at && Date.now() - ctx.at > 2 * 60_000 && <span className="ctx-tool-asof">as of {Math.round((Date.now() - ctx.at) / 60_000)} min ago · </span>}
          {window ? `${compact(used)} / ${compact(window)} · ${Math.round(pct)}%` : ctx === undefined ? "Asking…" : "Not reported yet"}
        </span>
      </button>
      {shown.length ? (
        <div className="ctx-stack" role="img" aria-label={shown.map((c) => `${c.name} ${compact(c.tokens)}`).join(", ")}>
          {shown.map((c) => (
            <i key={c.name} className={`ctx-seg ${hueOf(c.name)}`} style={{ width: `${(c.tokens / total) * 100}%` }} title={`${c.name}: ${compact(c.tokens)}`} />
          ))}
        </div>
      ) : !window ? null : (
        // Nothing known yet draws no track: an empty grey bar beside nothing read as broken (2026-10-28 QA).
        <div className="ctx-stack" aria-hidden="true">
          {/* Nothing reported is an empty track, not a sliver of colour. */}
          {pct > 0 && <i className="ctx-seg messages" style={{ width: `${pct}%` }} />}
        </div>
      )}
      {!open ? null : ctx === undefined ? (
        <div className="ctx-rows" aria-label="Asking Claude Code for its breakdown">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} h={12} w={`${70 - i * 9}%`} />
          ))}
        </div>
      ) : shown.length ? (
        <>
          <ul className="ctx-rows">
            {shown.map((c) => (
              <li key={c.name}>
                <i className={`ctx-dot ${hueOf(c.name)}`} aria-hidden="true" />
                <span className="ctx-row-name">{c.name}</span>
                <span className="ctx-row-n">{compact(c.tokens)}</span>
                <span className="ctx-row-pct">{window ? `${((c.tokens / window) * 100).toFixed(c.tokens / window < 0.1 ? 1 : 0)}%` : ""}</span>
              </li>
            ))}
          </ul>
          {(ctx?.servers.length ?? 0) > 0 && (
            <p className="ctx-note">
              <b>MCP tools by server:</b> {ctx!.servers.slice(0, 4).map((x) => `${x.name} ${compact(x.tokens)}`).join(" · ")}
              {deferred.length > 0 && ` (${deferred.map((d) => `${d.name.replace(/\s*\(deferred\)/i, "")} ${compact(d.tokens)}`).join(", ")} loaded only when used)`}
            </p>
          )}
        </>
      ) : (
        <p className="ctx-note">{tool === "claude" ? "Claude Code didn't say its breakdown just now. Open this again in a moment." : `${ENGINE_NAMES[tool]} reports how full it is, not what fills it.`}</p>
      )}
    </section>
  );
}

/** How long ago a kept reading of Claude's windows was taken: "2 min ago", "1 h ago". */
function keptAgo(windows: { at: number }[]): string {
  const m = Math.max(0, Math.round((Date.now() - Math.min(...windows.map((w) => w.at))) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}
