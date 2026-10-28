import { execFile, spawn } from "node:child_process";
import { mkdir, open, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { childEnv, copilotSignedIn, findBin, launcher } from "./adapters.js";
import { codexRoots } from "./imports.js";
import { ghBin } from "./workspace.js";
import { readOtherTools, type ToolAllowance } from "./tool-limits.js";
import type { EngineTool } from "../types.js";
import { ACCOUNT_TOOLS, accountDir, accountEnv, DEFAULT_ACCOUNT, isOut, listAccounts, toolHome, type AccountTool } from "./accounts.js";

/**
 * What each coding CLI says about its own limits, read on this machine.
 *
 * Codex writes its limits into its own session logs. Claude Code's come from Claude Code itself, two ways, kept on disk for each
 * of its accounts in one record that whichever said last updates. When the card or a limit hand-off asks, Claude Code is asked
 * through its own `get_usage` control request (the CLI calls Anthropic with its own sign-in, the way T3 Code asks it; no model
 * call, no tokens, no transcript): its five-hour and weekly windows, a model's own week, extra usage, and its plan. And as it
 * runs, the rate-limit events in its stream say the same windows. Its sign-in is never read: Anthropic's terms don't let a
 * developer "collect, store, or intermediate Claude.ai credentials or session tokens" (code.claude.com/docs/en/legal-and-compliance),
 * so Friday no longer takes Claude Code's token to its usage page, as it did until 2026-10-27 (Arun: "i do not want my account
 * banned"). Asking the CLI instead came on 2026-10-28 (Arun: "reverse engineer how orca, t3 and others get the claude usage
 * limits so we can integrate that"). Between asks the last figures stand, with when they were said.
 *
 * Codex is asked the way its VS Code extension asks: its own app server, `account/rateLimits/read`, which signs in and
 * refreshes for itself, so Friday never holds Codex's token. Both windows come back (five hours and the week on paid plans,
 * a month on the free one). When that can't answer, the newest limits Codex wrote into its own session logs stand in.
 *
 * Cursor keeps no usage on disk. Its sign-in is read where Cursor's CLI and editor keep it and sent to Cursor's own server
 * and nowhere else, the same request its CLI makes for `/usage`: how much of this billing cycle's included use is spent, for
 * Cursor's models and for the others. Never refreshed: that is Cursor's job, and doing it here would sign Cursor out.
 *
 * GitHub Copilot is asked through the person's own GitHub CLI (`gh api copilot_internal/user`, the endpoint GitHub's editors
 * read their quota from), so the request and its token stay inside `gh`: Friday never reads Copilot's sign-in at all.
 */

export interface CodexLimit {
  usedPercent: number;
  windowMinutes: number;
  /** Unix seconds. */
  resetsAt: number | null;
  plan: string | null;
  /** When Codex wrote it, in ms. */
  at: number;
}

export interface ClaudeLimit {
  status: string | null;
  kind: string | null;
  /** What to call it when the kind alone doesn't say, e.g. a week that counts one model. */
  label?: string;
  /** 0 to 1, when known. */
  utilization: number | null;
  /** Unix seconds. */
  resetsAt: number | null;
  at: number;
}

/** One limit window, the same shape for every tool. */
export interface LimitWindow {
  /** What the tool calls it: "primary", "secondary", "auto", "api"... */
  kind: string;
  /** Its length, when it has one: 300 is five hours, 10080 a week. Cursor's run for the billing cycle instead. */
  windowMinutes: number | null;
  /** What to call it when the length alone doesn't say: "Cursor models". */
  label?: string;
  /** 0 to 100, when known. */
  usedPercent: number | null;
  /** Unix seconds. */
  resetsAt: number | null;
  /** When it was read, in ms. */
  at: number;
  /** What Claude Code said of it with no figure: "allowed", "allowed_warning", "rejected". */
  status?: string | null;
}

/** What Cursor says about this billing cycle. */
export interface CursorUsage {
  plan: string | null;
  windows: LimitWindow[];
  /** Asked of Cursor just now, or only the plan known from its settings. */
  from: "account" | "plan";
  why?: string;
}

/** What GitHub Copilot says about this month's allowance. */
export interface CopilotUsage {
  plan: string | null;
  windows: LimitWindow[];
  /** Why it couldn't be read, when it couldn't. */
  why?: string;
}

export interface Limits {
  /** Codex's first window, as before. */
  codex: CodexLimit | null;
  /** All of Codex's windows: five hours and the week, or the month on the free plan. */
  codexWindows?: LimitWindow[];
  /** Asked of Codex just now, or read from its last session log. */
  codexFrom?: "account" | "log" | null;
  cursor?: CursorUsage | null;
  copilot?: CopilotUsage | null;
  /** The newest thing Claude Code said about any of its limits. */
  claude: ClaudeLimit | null;
  /** Each of Claude Code's windows: the session (five hours), the week, and the per-model weeks. */
  claudeWindows: ClaudeLimit[];
  /** The Claude plan Claude Code is signed in on. */
  claudePlan?: string | null;
  /** Where the windows came from: Claude Code asked for them (`get_usage`), or only what it said during its last run. */
  claudeFrom?: "account" | "runs" | null;
  /** Why the account couldn't be asked, when it couldn't. */
  claudeWhy?: string;
  /** The windows are the account's last answer, kept, as it couldn't be asked just now (claudeWhy says why). */
  claudeKept?: boolean;
  /** The other tools signed in on this machine, each read the way it asks itself (see tool-limits.ts). */
  tools?: Partial<Record<EngineTool, ToolAllowance>>;
  /** Each account of a tool that has more than one on this computer (accounts.ts), with its own windows. */
  accounts?: Partial<Record<AccountTool, AccountUsage[]>>;
}

/** One account of a tool, as its own sign-in says: who it is, its plan and its windows. */
export interface AccountUsage {
  id: string;
  label: string;
  /** Who it is signed in as, where the tool keeps that beside the sign-in. */
  email?: string | null;
  plan: string | null;
  windows: LimitWindow[];
  /** Ran out, and hasn't come back yet as far as Friday knows. */
  out?: boolean;
  /** When it comes back, in ms, when its message said. */
  outUntil?: number | null;
  why?: string;
}

/** Friday's data on this computer (FRIDAY_STATE_DIR: the tests' own, so a stand-in's limits never land in a real one). */
const dir = () => process.env.FRIDAY_STATE_DIR || path.join(homedir(), ".friday");
const claudeFile = () => path.join(dir(), "claude-limits.json");

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The order windows are shown in: the session first, then the week, then the narrower ones. */
const WINDOW_ORDER = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "overage"];
const rank = (k: string | null) => {
  const i = WINDOW_ORDER.indexOf(k ?? "");
  return i === -1 ? WINDOW_ORDER.length : i;
};

/** What was last said about each window, for each account (keyed "account|kind"; "" is the tool's own sign-in). Kept in memory as
 * well as on disk, so two events a moment apart cannot undo each other. */
const seen = new Map<string, ClaudeLimit>();
/** What Claude Code's last answer to `get_usage` said of each account besides its windows (keyed by account, "" its own sign-in). */
interface ClaudeAsked {
  at: number;
  plan: string | null;
  /** False on an API key or a cloud provider: no plan limits there. */
  available: boolean;
  /** The model whose own week its stream calls `seven_day_overage_included`. */
  scoped?: string | null;
}
const askedOf = new Map<string, ClaudeAsked>();
let loaded = false;
const keyOf = (account: string | undefined, kind: string | null) => `${account ?? ""}|${kind ?? "usage"}`;

/** What is on disk, joined into what is in memory, the newer of each winning: another process may have written since. */
async function syncClaude(): Promise<void> {
  const disk = await readClaudeStore();
  for (const [k, w] of disk.windows) {
    const held = seen.get(k);
    if (!loaded || !held || held.at < w.at) seen.set(k, w);
  }
  for (const [k, a] of Object.entries(disk.asked)) {
    const held = askedOf.get(k);
    if (!loaded || !held || held.at < a.at) askedOf.set(k, a);
  }
  loaded = true;
}
async function saveClaude(): Promise<void> {
  await mkdir(dir(), { recursive: true });
  await writeFile(claudeFile(), JSON.stringify({ byAccount: Object.fromEntries(seen), asked: Object.fromEntries(askedOf) }));
}

/** The kind of Claude Code's own week of one model, from what it calls the model: "Fable" is `seven_day_fable`. */
const scopedKind = (name: string) => `seven_day_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
/** What its stream calls the week of the one model with a week of its own (T3 Code reads it the same way). */
const OVERAGE_INCLUDED = "seven_day_overage_included";

/** One rate-limit event, as a limit. Null for anything else. */
export function claudeLimitFrom(m: { type?: unknown; [k: string]: unknown }, at = Date.now()): ClaudeLimit | null {
  if (m.type !== "rate_limit_event") return null;
  const info = (m.rate_limit_info ?? m) as Record<string, unknown>;
  const reset = num(info.resetsAt) ?? num(info.resets_at);
  return {
    status: typeof info.status === "string" ? info.status : null,
    kind: typeof info.rateLimitType === "string" ? info.rateLimitType : typeof info.type === "string" ? info.type : null,
    utilization: num(info.utilization) ?? num(info.used_percentage),
    // Milliseconds or seconds, depending on the version; either way it is a time in the future.
    resetsAt: reset === null ? null : reset > 1e12 ? Math.round(reset / 1000) : reset,
    at,
  };
}

/** Called with every event type the Claude stream sends that the runner does not otherwise use; `account` is the one it ran as. */
export function noteClaudeEvent(m: { type?: unknown; [k: string]: unknown }, account?: string): void {
  const said = claudeLimitFrom(m);
  if (!said) return;
  void (async () => {
    await syncClaude();
    const asked = askedOf.get(account ?? "");
    // The week of the model that has one of its own, by the name `get_usage` gave it, so both update the same window.
    const limit = said.kind === OVERAGE_INCLUDED && asked?.scoped ? { ...said, kind: scopedKind(asked.scoped), label: `Weekly · ${asked.scoped}` } : said;
    const key = keyOf(account, limit.kind);
    // An event that does not say how full the window is must not erase what an earlier one did, nor the name it was given.
    const before = seen.get(key);
    seen.set(key, { ...(before?.label ? { label: before.label } : {}), ...limit, utilization: limit.utilization ?? (before && before.resetsAt === limit.resetsAt ? before.utilization : null) });
    // It said a plan limit, so it has them, whatever the last ask said.
    if (asked && !asked.available) askedOf.set(account ?? "", { ...asked, available: true });
    await saveClaude();
  })().catch(() => {});
}

// ── Claude Code, asked ───────────────────────────────────────────────────

const resetOf = (v: unknown): number | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? Math.round(t / 1000) : null;
};
const fraction = (pct: number) => Math.min(1, Math.max(0, pct / 100));
const nameOf = (v: unknown): string => (typeof v === "string" ? v : typeof (v as { display_name?: unknown } | null)?.display_name === "string" ? (v as { display_name: string }).display_name : "");
/** "max", "team", "max_20x": as a person says it. */
const planWords = (v: unknown): string | null =>
  typeof v === "string" && v.trim()
    ? v
        .trim()
        .split(/[_\s]+/)
        .map((w) => w[0]!.toUpperCase() + w.slice(1))
        .join(" ")
    : null;
/** A percentage from an amount used of a limit, when both are there. */
const share = (used: unknown, limit: unknown): number | null => {
  const u = num(used);
  const l = num(limit);
  return u !== null && l !== null && u >= 0 && l > 0 ? Math.min(100, (u / l) * 100) : null;
};

/** What Claude Code's `get_usage` says, as Friday keeps it. */
export interface ClaudeUsage {
  /** False on an API key or a cloud provider: no plan limits there. */
  available: boolean;
  plan: string | null;
  windows: ClaudeLimit[];
  /** The first model with a week of its own (its stream's `seven_day_overage_included`). */
  scoped: string | null;
}

/**
 * Claude Code's answer to `get_usage` (the `response` of its control_response), as windows: figures 0 to 100, resets as ISO
 * times. Pro and Max fill per-window fields (`five_hour`, `seven_day`, `seven_day_opus`…); Team and newer accounts leave some of
 * those null and send a `limits` list, and a model's own week comes in `model_scoped` (and in the list, with the model as its
 * scope). All are read and joined by window. A window with no figure is left out rather than shown as empty. Extra usage, when
 * it is on, is one more window: how much of its monthly limit is spent. Null for anything that isn't an answer.
 */
export function claudeUsageFrom(r: unknown, at = Date.now()): ClaudeUsage | null {
  if (!r || typeof r !== "object") return null;
  const res = r as Record<string, any>;
  const plan = planWords(res.subscription_type);
  const rl = res.rate_limits as Record<string, any> | null | undefined;
  if (res.rate_limits_available !== true || !rl || typeof rl !== "object") return { available: res.rate_limits_available === true, plan, windows: [], scoped: null };
  const out = new Map<string, ClaudeLimit>();
  const put = (kind: string, pct: number | null, resetsAt: unknown, label?: string) => {
    if (pct === null) return;
    out.set(kind, { status: null, kind, ...(label ? { label } : {}), utilization: fraction(pct), resetsAt: resetOf(resetsAt), at });
  };
  for (const kind of ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"]) put(kind, num(rl[kind]?.utilization), rl[kind]?.resets_at);
  for (const l of Array.isArray(rl.limits) ? (rl.limits as any[]) : []) {
    const group = typeof l?.group === "string" ? l.group : "";
    const scope = nameOf(l?.scope?.model);
    // Only the session and the weeks: anything else it may list is not a window Friday knows how to show.
    if (group === "session" && !scope) put("five_hour", num(l.percent), l.resets_at);
    else if (group === "weekly") put(scope ? scopedKind(scope) : "seven_day", num(l.percent), l.resets_at, scope ? `Weekly · ${scope}` : undefined);
  }
  let scoped: string | null = null;
  for (const m of Array.isArray(rl.model_scoped) ? (rl.model_scoped as any[]) : []) {
    const name = nameOf(m);
    if (!name) continue;
    scoped ??= name;
    put(scopedKind(name), num(m.utilization), m.resets_at, `Weekly · ${name}`);
  }
  // Extra usage: what is spent of its monthly limit, in money of one currency, else the credits, else its own figure.
  const spend = rl.spend as Record<string, any> | undefined;
  const extra = rl.extra_usage as Record<string, any> | undefined;
  const sameMoney = spend?.used && spend?.limit && spend.used.currency === spend.limit.currency && spend.used.exponent === spend.limit.exponent;
  const spent = spend?.enabled === true && sameMoney ? share(spend.used.amount_minor, spend.limit.amount_minor) : null;
  const credits = extra?.is_enabled === true ? (share(extra.used_credits, extra.monthly_limit) ?? num(extra.utilization)) : null;
  put("overage", spent ?? credits, null, "Extra usage");
  return { available: true, plan, windows: [...out.values()].sort((a, b) => rank(a.kind) - rank(b.kind)), scoped };
}

/** "Oct 28 at 4pm (America/New_York)", "3:59pm (Europe/London)": in Unix seconds, the next such time from `now`. */
export function claudeResetText(text: string, now = Date.now()): number | null {
  const m = /^(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?$/i.exec(text.trim());
  if (!m) return null;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  let hour = Number(m[4]);
  const minute = Number(m[5] ?? 0);
  const half = m[6]?.toLowerCase();
  if (half === "pm" && hour < 12) hour += 12;
  if (half === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const zone = m[7];
  /** How far ahead of UTC the zone is at `t`, in ms (the computer's own zone when it names none, or one it doesn't know). */
  const offset = (t: number): number => {
    try {
      if (!zone) throw new Error("none");
      const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
      return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second)) - Math.floor(t / 1000) * 1000;
    } catch {
      return -new Date(t).getTimezoneOffset() * 60_000;
    }
  };
  // The zone's own date now, for what the text leaves out.
  const here = new Date(now + offset(now));
  const month = m[1] ? months.indexOf(m[1].toLowerCase()) : here.getUTCMonth();
  if (month < 0) return null;
  const day = m[2] ? Number(m[2]) : here.getUTCDate();
  const at = (year: number, plusDays = 0) => {
    const wall = Date.UTC(year, month, day + plusDays, hour, minute);
    // Twice: the offset at the guess, then at the answer, so a change of clocks between them is allowed for.
    const first = wall - offset(wall);
    return wall - offset(first);
  };
  let t = at(m[3] ? Number(m[3]) : here.getUTCFullYear());
  // No year: a date well past is next year's. No date: a time past is tomorrow's.
  if (!m[3] && m[1] && t < now - 86_400_000) t = at(here.getUTCFullYear() + 1);
  if (!m[1] && t < now) t = at(here.getUTCFullYear(), 1);
  return Math.round(t / 1000);
}

/**
 * The windows in `/usage`'s text, for a Claude Code that can't answer `get_usage`: "Current session: 66% used · resets Oct 28 at
 * 3:59pm (America/New_York)", "Current week (all models): …", "Current week (Fable): …". Lines it doesn't recognise are passed over.
 */
export function claudeUsageText(text: string, at = Date.now()): ClaudeLimit[] {
  const out = new Map<string, ClaudeLimit>();
  for (const line of text.split("\n")) {
    const m = /^\s*Current\s+(session|week)(?:\s*\(([^)]+)\))?\s*:\s*(\d+(?:\.\d+)?)%\s*used(?:\s*[·•-]\s*resets\s+(.+?))?\s*$/i.exec(line);
    if (!m) continue;
    const scope = m[2]?.trim();
    const all = !scope || /^all\b/i.test(scope);
    const kind = m[1]!.toLowerCase() === "session" ? "five_hour" : all ? "seven_day" : scopedKind(scope!);
    if (kind === "five_hour" && scope && !all) continue;
    out.set(kind, { status: null, kind, ...(all ? {} : { label: `Weekly · ${scope}` }), utilization: fraction(Number(m[3])), resetsAt: m[4] ? claudeResetText(m[4], at) : null, at });
  }
  return [...out.values()].sort((a, b) => rank(a.kind) - rank(b.kind));
}

/** Kept as the answer came, for the newer of it and the stream to win, window by window. */
async function keepClaudeUsage(account: string | undefined, got: ClaudeUsage, at: number): Promise<void> {
  await syncClaude();
  const prefix = `${account ?? ""}|`;
  const listed = new Set(got.windows.map((w) => keyOf(account, w.kind)));
  for (const w of got.windows) {
    const key = keyOf(account, w.kind);
    const before = seen.get(key);
    if (!before || before.at <= at) seen.set(key, w);
  }
  // A window it no longer lists, which nothing has said since, is one the plan doesn't have now (or none, on an API key).
  for (const [k, w] of [...seen]) if (k.startsWith(prefix) && !listed.has(k) && w.at < at) seen.delete(k);
  const before = askedOf.get(account ?? "");
  if (!before || before.at <= at) askedOf.set(account ?? "", { at, plan: got.plan, available: got.available, scoped: got.scoped ?? before?.scoped ?? null });
  await saveClaude();
}

/**
 * Asked at most every `everyMs` for each account, and not for `backOffMs` after a failure or a Claude Code that can't answer;
 * a probe is stopped after `probeMs`, and none starts for `startingMs` after Friday starts Claude Code for a turn.
 */
export const CLAUDE_ASK = { everyMs: 5 * 60_000, backOffMs: 30 * 60_000, probeMs: 12_000, startingMs: 10_000 };
/** Claude Code was last started for a turn of Friday's: no probe for a few seconds after, so it has the computer to itself. */
let claudeStartedAt = 0;
/** Called as Friday starts Claude Code for a turn. */
export function noteClaudeStarting(): void {
  claudeStartedAt = Date.now();
}

/** Friday's own empty folder for asking Claude Code, never the person's project: no CLAUDE.md, settings or MCP servers of theirs. */
const probeDir = () => path.join(dir(), "claude-usage");

/** `signedOut`: its initialize answer said it has no sign-in of any kind ("tokenSource": "none", no API key). */
type Probe = { usage: unknown; signedOut: boolean } | { unsupported: true } | { failed: string };

/** Lines of a child's stdout, as they come. */
function eachLine(child: ReturnType<typeof spawn>, on: (line: string) => void): void {
  let buf = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (d: string) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      on(line);
    }
  });
}

/**
 * Claude Code asked for its usage the way its SDK asks (`usage_EXPERIMENTAL…`): started headless in Friday's empty folder with
 * no hooks, no MCP servers, no tools and nothing saved; initialized; then `get_usage` with `skip_behaviors` (only the limits, not a
 * scan of its transcripts). Its answer is the CLI's own call to Anthropic with its own sign-in. Stdin is closed once it answers;
 * it is stopped after twelve seconds whatever it is doing.
 */
function probeClaude(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<Probe> {
  return new Promise<Probe>((resolve) => {
    const child = spawn(command, [...args, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--settings", '{"disableAllHooks":true}', "--no-session-persistence", "--tools", ""], { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let settled = false;
    let signedOut = false;
    const done = (p: Probe) => {
      if (settled) return;
      settled = true;
      try {
        child.stdin!.end();
      } catch {
        // gone already
      }
      resolve(p);
    };
    const kill = setTimeout(() => {
      done({ failed: "Claude Code didn't answer in time." });
      try {
        child.kill();
      } catch {
        // gone already
      }
    }, CLAUDE_ASK.probeMs);
    child.on("error", () => done({ failed: "Claude Code couldn't be started." }));
    child.on("exit", () => {
      clearTimeout(kill);
      done({ failed: "Claude Code stopped without answering." });
    });
    child.stdin!.on("error", () => {});
    eachLine(child, (line) => {
      let m: { type?: string; response?: { subtype?: string; request_id?: string; response?: any; error?: unknown } };
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.type !== "control_response") return;
      if (m.response?.request_id === "i1") {
        // Only how it is signed in, never who: whether it has a sign-in at all.
        const a = m.response.response?.account as { tokenSource?: unknown; apiKeySource?: unknown } | undefined;
        signedOut = a?.tokenSource === "none" && !a.apiKeySource;
        return;
      }
      if (m.response?.request_id !== "u1") return;
      if (m.response.subtype === "success") return done({ usage: m.response.response, signedOut });
      const why = typeof m.response.error === "string" ? m.response.error : "";
      done(/unsupported control request|not supported/i.test(why) ? { unsupported: true } : { failed: why || "Claude Code couldn't say its usage." });
    });
    const send = (o: unknown) => child.stdin!.write(`${JSON.stringify(o)}\n`);
    send({ type: "control_request", request_id: "i1", request: { subtype: "initialize" } });
    send({ type: "control_request", request_id: "u1", request: { subtype: "get_usage", skip_behaviors: true } });
  });
}

/**
 * For a Claude Code too old for `get_usage`: its `/usage`, run in the same folder the same way (no model call), read as text.
 * Nothing is saved with --no-session-persistence; a version that saves anyway has its session file removed.
 */
function claudeUsageCommand(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, configDir: string): Promise<ClaudeLimit[] | null> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args, "-p", "/usage", "--output-format", "json", "--strict-mcp-config", "--settings", '{"disableAllHooks":true}', "--no-session-persistence"], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => (out += d));
    const kill = setTimeout(() => child.kill(), CLAUDE_ASK.probeMs);
    child.on("error", () => (clearTimeout(kill), resolve(null)));
    child.on("exit", () => {
      clearTimeout(kill);
      void (async () => {
        let j: { result?: unknown; session_id?: unknown; is_error?: unknown };
        try {
          j = JSON.parse(out.trim());
        } catch {
          return null;
        }
        // Its session file, if it kept one: under the projects folder, named for this folder (every other character a dash).
        if (typeof j.session_id === "string" && /^[\w-]+$/.test(j.session_id)) {
          for (const folder of new Set([cwd, await realpath(cwd).catch(() => cwd)])) await rm(path.join(configDir, "projects", folder.replace(/[^a-zA-Z0-9]/g, "-"), `${j.session_id}.jsonl`), { force: true }).catch(() => {});
        }
        if (j.is_error === true || typeof j.result !== "string") return null;
        const windows = claudeUsageText(j.result);
        return windows.length ? windows : null;
      })().then(resolve, () => resolve(null));
    });
  });
}

/** One probe at a time, whichever account it is for. */
let probing: Promise<unknown> = Promise.resolve();
const claudeAsks = new Map<string, { until: number; read: Promise<void> }>();
/** Why the last ask of each account came to nothing, when it did. */
const claudeWhyNot = new Map<string, string>();

/**
 * Claude Code asked for its usage, for one account ("" or none: its own sign-in), and the answer kept. At most every five minutes
 * for each, one at a time, never in the seconds Friday is starting it for a turn, and half an hour after a failure or a "not
 * supported". Not installed, or signed out: nothing, quietly.
 */
export function askClaudeUsage(account?: string): Promise<void> {
  if (account === DEFAULT_ACCOUNT) account = undefined;
  const key = account ?? "";
  const was = claudeAsks.get(key);
  if (was && Date.now() < was.until) return was.read;
  if (Date.now() - claudeStartedAt < CLAUDE_ASK.startingMs) return was?.read ?? Promise.resolve();
  const entry = { until: Date.now() + CLAUDE_ASK.everyMs, read: Promise.resolve() };
  const backOff = (why?: string) => {
    entry.until = Date.now() + CLAUDE_ASK.backOffMs;
    if (why) claudeWhyNot.set(key, why);
  };
  const turn = probing.then(async () => {
    // Not installed: nothing, and looked for again next time, in case it is installed by then.
    const bin = await findBin("claude");
    if (!bin) return;
    const l = await launcher(bin);
    const cwd = probeDir();
    await mkdir(cwd, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...childEnv(),
      ...(l.env ?? {}),
      ...accountEnv("claude", account),
      // Nothing of the editor's or claude.ai's for a question this small.
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    };
    const p = await probeClaude(l.command, l.prefix, env, cwd);
    const at = Date.now();
    if ("usage" in p) {
      const got = claudeUsageFrom(p.usage, at);
      if (!got) return backOff("Claude Code's answer about its usage wasn't readable.");
      // Signed out: nothing to say, and no "API key" to claim. Asked again in five minutes, in case it signs in.
      if (!got.available && p.signedOut) return void claudeWhyNot.set(key, "Claude Code isn't signed in here.");
      claudeWhyNot.delete(key);
      return keepClaudeUsage(account, got, at);
    }
    if ("unsupported" in p) {
      const windows = await claudeUsageCommand(l.command, l.prefix, env, cwd, account ? accountDir("claude", account) : toolHome("claude"));
      backOff(windows ? undefined : "This Claude Code is too old to say its usage: update it to see it here.");
      return windows ? keepClaudeUsage(account, { available: true, plan: askedOf.get(key)?.plan ?? null, windows, scoped: null }, at) : undefined;
    }
    backOff(p.failed);
  });
  entry.read = turn.catch(() => backOff());
  probing = entry.read;
  claudeAsks.set(key, entry);
  return entry.read;
}

/** A window's length, as a person says it. */
const windowName = (min: number | null) => (min === null ? "" : min >= 40_000 ? "Monthly" : min >= 10_080 ? "Weekly" : min >= 60 ? `${Math.round(min / 60)}-hour` : `${min}-minute`);

/** One of Codex's windows, from the app server (camelCase) or a session log (snake_case). Null when it says nothing. */
function codexWindow(kind: string, w: Record<string, unknown> | null | undefined, at: number, eventAt = at): LimitWindow | null {
  if (!w) return null;
  const used = num(w.usedPercent) ?? num(w.used_percent);
  const minutes = num(w.windowDurationMins) ?? num(w.window_minutes);
  // An absolute time when it says one; older Codex wrote how long was left, from when it wrote it.
  const inSec = num(w.resets_in_seconds);
  const resetsAt = num(w.resetsAt) ?? num(w.resets_at) ?? (inSec !== null ? Math.round(eventAt / 1000 + inSec) : null);
  if (used === null && resetsAt === null) return null;
  return { kind, windowMinutes: minutes, label: windowName(minutes), usedPercent: used, resetsAt, at };
}

/** A rate-limit snapshot (Codex's own `codex` bucket), as windows and the plan it is on. */
export function codexFromSnapshot(snap: Record<string, any> | null | undefined, at = Date.now(), eventAt = at): { windows: LimitWindow[]; plan: string | null } | null {
  if (!snap) return null;
  const windows = [codexWindow("primary", snap.primary, at, eventAt), codexWindow("secondary", snap.secondary, at, eventAt)].filter((w): w is LimitWindow => !!w);
  if (!windows.length) return null;
  const plan = (snap.planType ?? snap.plan_type) as unknown;
  return { windows, plan: typeof plan === "string" && plan ? plan[0]!.toUpperCase() + plan.slice(1) : null };
}

/**
 * Asked of Codex itself: its app server, over stdin and stdout, the way its editor extension asks. Codex signs in and
 * refreshes for itself, so no token passes through here. Started, asked once and stopped; at most once a minute.
 */
const codexAsked = new Map<string, { at: number; read: Promise<{ windows: LimitWindow[]; plan: string | null } | null> }>();
/** `home`: one of its accounts' folders (accounts.ts), run as that account. */
function askCodex(home?: string): Promise<{ windows: LimitWindow[]; plan: string | null } | null> {
  const was = codexAsked.get(home ?? "");
  if (was && Date.now() - was.at < 60_000) return was.read;
  const read = (async () => {
    const bin = await findBin("codex");
    if (!bin) return null;
    const l = await launcher(bin);
    return new Promise<{ windows: LimitWindow[]; plan: string | null } | null>((resolve) => {
      const child = spawn(l.command, [...l.prefix, "app-server"], { env: { ...childEnv(), ...(l.env ?? {}), ...(home ? { CODEX_HOME: home } : {}) }, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
      let buf = "";
      let settled = false;
      const done = (v: { windows: LimitWindow[]; plan: string | null } | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          child.kill();
        } catch {
          // gone already
        }
        resolve(v);
      };
      const timer = setTimeout(() => done(null), 10_000);
      const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
      child.on("error", () => done(null));
      child.on("exit", () => done(null));
      child.stdin.on("error", () => done(null));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        buf += d;
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let m: { id?: number; method?: string; result?: Record<string, any>; error?: unknown };
          try {
            m = JSON.parse(line);
          } catch {
            continue;
          }
          if (m.method) continue;
          if (m.id === 0) {
            send({ method: "initialized" });
            send({ method: "account/rateLimits/read", id: 1, params: { excludeResetCreditDetails: true } });
          } else if (m.id === 1) {
            done(m.result ? codexFromSnapshot(m.result.rateLimitsByLimitId?.codex ?? m.result.rateLimits) : null);
          }
        }
      });
      send({ method: "initialize", id: 0, params: { clientInfo: { name: "friday", version: "1" } } });
    });
  })().catch(() => null);
  codexAsked.set(home ?? "", { at: Date.now(), read });
  return read;
}

/** The last bytes of a file, as whole lines: a session log can be tens of megabytes, and its limits are near its end. */
async function tailLines(file: string, bytes = 64 * 1024): Promise<string[]> {
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    await fh.close();
  }
}

/**
 * The newest limits Codex wrote into its own session logs. Logs it imported from other tools say nothing (their limits are
 * null) and are passed over, as are other buckets (`premium`) and windows that aren't there; the newest real reading wins.
 */
async function readCodexLog(): Promise<{ windows: LimitWindow[]; plan: string | null; at: number } | null> {
  let best: { windows: LimitWindow[]; plan: string | null; at: number } | null = null;
  for (const root of codexRoots(homedir())) {
    for (const { file, at: mtime } of await newestRollouts(root, 80)) {
      // Nothing older than the best reading can be newer than it.
      if (best && mtime < best.at) break;
      const lines = await tailLines(file).catch(() => [] as string[]);
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]!.includes('"rate_limits"')) continue;
        try {
          const ev = JSON.parse(lines[i]!) as { timestamp?: string; payload?: { type?: string; rate_limits?: Record<string, any> | null } };
          const r = ev.payload?.rate_limits;
          if (ev.payload?.type !== "token_count" || !r || (r.limit_id ?? "codex") !== "codex") continue;
          const at = ev.timestamp ? Date.parse(ev.timestamp) || 0 : 0;
          const got = codexFromSnapshot(r, at, at);
          if (!got) continue;
          if (!best || at > best.at) best = { ...got, at };
          break;
        } catch {
          // A line cut in half by a write in progress: the one before it will do.
        }
      }
    }
  }
  return best;
}

/** The newest session logs by when they were written, newest first. */
async function newestRollouts(root: string, n: number): Promise<{ file: string; at: number }[]> {
  const out: { file: string; at: number }[] = [];
  const walk = async (d: string, depth: number) => {
    const names = await readdir(d).catch(() => [] as string[]);
    // Dated folders sort the same way as time, so only the newest of each level is worth opening.
    for (const name of names.sort().reverse().slice(0, depth < 3 ? 3 : 50)) {
      const p = path.join(d, name);
      if (name.endsWith(".jsonl")) out.push({ file: p, at: (await stat(p).catch(() => null))?.mtimeMs ?? 0 });
      else if (depth < 3) await walk(p, depth + 1);
    }
  };
  await walk(root, 0);
  return out.sort((a, b) => b.at - a.at).slice(0, n);
}

/** Codex's windows: asked of Codex, else its newest log. */
async function readCodex(): Promise<{ windows: LimitWindow[]; plan: string | null; from: "account" | "log" } | null> {
  const asked = await askCodex();
  if (asked) return { ...asked, from: "account" };
  const logged = await readCodexLog();
  return logged ? { windows: logged.windows, plan: logged.plan, from: "log" } : null;
}

// ── Cursor ───────────────────────────────────────────────────────────────

/** When a JWT expires, in ms; null when it doesn't say. */
function expiresAt(token: string): number | null {
  try {
    const exp = num(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")).exp);
    return exp === null ? null : exp * 1000;
  } catch {
    return null;
  }
}
const usable = (t: unknown): t is string => typeof t === "string" && t.length > 20 && (expiresAt(t) ?? Infinity) > Date.now() + 60_000;

/** Where Cursor's editor keeps its settings, the sign-in among them. */
function cursorStateDb(): string {
  const home = homedir();
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Cursor", "User", "globalStorage", "state.vscdb");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Cursor", "User", "globalStorage", "state.vscdb");
}

let sqlite: Promise<any> | null = null;
/** The editor's sign-in and plan, read from its settings without opening them for writing. Needs node:sqlite (Node 22.13+). */
async function cursorEditor(): Promise<{ token: string | null; plan: string | null }> {
  const name = "node:sqlite";
  sqlite ??= import(name).catch(() => null);
  const sq = await sqlite;
  if (!sq?.DatabaseSync || !(await stat(cursorStateDb()).catch(() => null))) return { token: null, plan: null };
  let db: any;
  try {
    db = new sq.DatabaseSync(cursorStateDb(), { readOnly: true });
    const rows = db.prepare("select key, value from ItemTable where key in ('cursorAuth/accessToken', 'cursorAuth/stripeMembershipType')").all() as { key: string; value: unknown }[];
    const get = (k: string) => {
      const v = rows.find((r) => r.key === k)?.value;
      return typeof v === "string" ? v : v instanceof Uint8Array ? Buffer.from(v).toString("utf8") : null;
    };
    return { token: get("cursorAuth/accessToken"), plan: get("cursorAuth/stripeMembershipType") };
  } catch {
    return { token: null, plan: null };
  } finally {
    db?.close();
  }
}

/** Cursor's CLI's sign-in: a file on Windows and Linux, the keychain on a Mac. */
async function cursorAgentToken(): Promise<string | null> {
  try {
    if (process.platform === "darwin") {
      const out = await new Promise<string>((resolve, reject) =>
        execFile("security", ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"], { timeout: 5000 }, (e, stdout) => (e ? reject(e) : resolve(stdout))),
      );
      return out.trim() || null;
    }
    const base = process.platform === "win32" ? process.env.APPDATA || path.join(homedir(), "AppData", "Roaming") : process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
    const j = JSON.parse(await readFile(path.join(base, process.platform === "win32" ? "Cursor" : "cursor", "auth.json"), "utf8")) as { accessToken?: unknown };
    return typeof j.accessToken === "string" ? j.accessToken : null;
  } catch {
    return null;
  }
}

const cents = (v: unknown) => (typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN);
const ms = (v: unknown) => {
  const n = cents(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n / 1000) : null;
};
const pct = (v: unknown) => {
  const n = cents(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
};

/**
 * Cursor's answer as windows: this billing cycle's included use, Cursor's own models and the others apart (the way its
 * dashboard shows them, two bars and no total), or as one figure when only that is given. Empty when the plan has none
 * (Cursor says "usage details are not available for this plan").
 */
export function cursorFrom(usage: Record<string, any> | null, planInfo: Record<string, any> | null, at = Date.now()): { windows: LimitWindow[]; plan: string | null } {
  const info = planInfo?.planInfo ?? planInfo ?? {};
  const plan = typeof info.planName === "string" && info.planName ? info.planName : null;
  const u = usage?.planUsage;
  if (!u) return { windows: [], plan };
  const weekly = /WEEKLY$/i.test(String(info.includedUsagePeriod ?? "")) || info.includedUsagePeriod === 2;
  const resetsAt = weekly ? (ms(info.includedUsageResetsAt) ?? ms(usage?.billingCycleEnd)) : (ms(usage?.billingCycleEnd) ?? ms(info.billingCycleEnd));
  const minutes = weekly ? 10_080 : null;
  const w = (kind: string, label: string, used: number | null): LimitWindow | null => (used === null ? null : { kind, windowMinutes: minutes, label, usedPercent: used, resetsAt, at });
  const auto = pct(u.autoPercentUsed);
  const api = pct(u.apiPercentUsed);
  const spent = cents(u.includedSpend);
  const limit = cents(u.limit);
  const total = Number.isFinite(spent) && limit > 0 ? Math.min(100, (spent / limit) * 100) : pct(u.totalPercentUsed);
  const windows = auto !== null || api !== null ? [w("auto", "Cursor models", auto), w("api", "Other models", api)] : [w("total", "Included", total)];
  return { windows: windows.filter((x): x is LimitWindow => !!x), plan };
}

/** Asked at most every five minutes: it moves slowly, and Cursor's server is not ours to lean on. */
let cursorAsked: { at: number; read: Promise<CursorUsage | null> } | null = null;
function readCursor(): Promise<CursorUsage | null> {
  if (cursorAsked && Date.now() - cursorAsked.at < 5 * 60_000) return cursorAsked.read;
  const read = (async (): Promise<CursorUsage | null> => {
    const [agent, editor] = await Promise.all([cursorAgentToken(), cursorEditor()]);
    const known = editor.plan ? (editor.plan[0]!.toUpperCase() + editor.plan.slice(1)).replace(/_/g, " ") : null;
    const token = usable(agent) ? agent : usable(editor.token) ? editor.token : null;
    if (!token) return agent || editor.token || known ? { plan: known, windows: [], from: "plan", why: "Cursor's sign-in needs refreshing, which it does the next time it runs." } : null;
    // Cursor's own server and nowhere else, as its CLI asks for /usage.
    const ask = (method: string) =>
      fetch(`https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
        body: "{}",
        signal: AbortSignal.timeout(8000),
      }).then((r) => (r.ok ? (r.json() as Promise<Record<string, any>>) : Promise.reject(new Error(String(r.status)))));
    const [usage, planInfo] = await Promise.all([ask("GetCurrentPeriodUsage").catch(() => null), ask("GetPlanInfo").catch(() => null)]);
    if (!usage && !planInfo) return { plan: known, windows: [], from: "plan", why: "Cursor's usage didn't answer just now." };
    const got = cursorFrom(usage, planInfo);
    return { plan: got.plan ?? known, windows: got.windows, from: got.windows.length ? "account" : "plan" };
  })().catch(() => null);
  cursorAsked = { at: Date.now(), read };
  return read;
}

/** Copilot's allowances, most telling first, with what each is called in its own settings page. */
const COPILOT_QUOTAS: [string, string][] = [
  ["premium_interactions", "Premium requests"],
  ["chat", "Chat"],
  ["completions", "Completions"],
];

/** The allowances Copilot's account endpoint lists (October 2026): each with an entitlement, how much is left, and a reset. */
export function copilotFrom(j: Record<string, any> | null, at = Date.now()): { windows: LimitWindow[]; plan: string | null } {
  const resetMs = Date.parse(String(j?.quota_reset_date_utc ?? j?.quota_reset_date ?? ""));
  const resetsAt = Number.isFinite(resetMs) ? Math.round(resetMs / 1000) : null;
  const windows = COPILOT_QUOTAS.flatMap(([kind, label]): LimitWindow[] => {
    const q = j?.quota_snapshots?.[kind];
    const left = num(q?.percent_remaining);
    // One the plan doesn't have, or doesn't limit, is no window.
    if (!q || q.unlimited || !(num(q.entitlement) ?? 0) || left === null) return [];
    return [{ kind, windowMinutes: null, label, usedPercent: Math.max(0, Math.min(100, 100 - left)), resetsAt, at }];
  });
  // "free_limited_copilot", "copilot_pro_plus": the words of it.
  const sku = typeof j?.access_type_sku === "string" ? j.access_type_sku : "";
  const words = sku.replace(/^copilot_|_copilot$/g, "").replace(/^free_limited$/, "free").split("_").filter(Boolean);
  return { windows, plan: words.length ? words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ") : null };
}

/** Asked at most every five minutes, and only on a computer where Copilot is installed and signed in. */
let copilotAsked: { at: number; read: Promise<CopilotUsage | null> } | null = null;
function readCopilot(): Promise<CopilotUsage | null> {
  if (copilotAsked && Date.now() - copilotAsked.at < 5 * 60_000) return copilotAsked.read;
  const read = (async (): Promise<CopilotUsage | null> => {
    if (!(await findBin("copilot")) || (await copilotSignedIn()) !== true) return null;
    const gh = await ghBin();
    if (!gh) return { plan: null, windows: [], why: "Install the GitHub CLI (gh) and sign in to see this here." };
    const out = await new Promise<string | null>((resolve) =>
      execFile(gh, ["api", "copilot_internal/user"], { env: childEnv(), timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 }, (e, stdout) => resolve(e ? null : stdout)),
    );
    if (out === null) return { plan: null, windows: [], why: "Sign in to the GitHub CLI (gh) with the account you use Copilot with to see this here." };
    let j: Record<string, any> | null = null;
    try {
      j = JSON.parse(out) as Record<string, any>;
    } catch {
      return { plan: null, windows: [], why: "Copilot's usage didn't answer just now." };
    }
    return copilotFrom(j);
  })().catch(() => null);
  copilotAsked = { at: Date.now(), read };
  return read;
}

/**
 * Everything on disk: each window by "account|kind" (files from before accounts, one account's windows by kind, are the tool's
 * own), and what each account's last `get_usage` answer said besides.
 */
async function readClaudeStore(): Promise<{ windows: [string, ClaudeLimit][]; asked: Record<string, ClaudeAsked> }> {
  try {
    const j = JSON.parse(await readFile(claudeFile(), "utf8")) as { byAccount?: Record<string, ClaudeLimit>; asked?: Record<string, ClaudeAsked>; windows?: Record<string, ClaudeLimit> } & Partial<ClaudeLimit>;
    const asked = j.asked && typeof j.asked === "object" ? j.asked : {};
    if (j.byAccount) return { windows: Object.entries(j.byAccount), asked };
    const list = j.windows ? Object.values(j.windows) : j.at ? [j as ClaudeLimit] : [];
    return { windows: list.map((w) => [keyOf(undefined, w.kind), w]), asked };
  } catch {
    return { windows: [], asked: {} };
  }
}

/** One account's windows and its last answer ("" or none: the tool's own sign-in), the windows in the order they are shown. */
async function readClaude(account?: string): Promise<{ windows: ClaudeLimit[]; asked: ClaudeAsked | null }> {
  const prefix = `${account ?? ""}|`;
  const store = await readClaudeStore();
  const asked = store.asked[account ?? ""] ?? null;
  const windows = store.windows
    .filter(([k]) => k.startsWith(prefix))
    .map(([, w]) => (w.utilization !== null && w.utilization > 1 ? { ...w, utilization: w.utilization / 100 } : w))
    // On an API key there are no plan limits: only what its stream has said since, if anything.
    .filter((w) => !asked || asked.available || w.at > asked.at)
    .sort((a, b) => rank(a.kind) - rank(b.kind));
  return { windows, asked };
}

const NO_PLAN = "No plan limits: Claude Code is on an API key or a cloud provider here, paid for as it is used.";

/** What answered last for each slow source, and the ask under way: see `within`. */
const lastRead = new Map<string, unknown>();
const reading = new Map<string, Promise<unknown>>();

/**
 * `read()`, waiting no longer than `budget`: a slow source's last answer stands in, and the ask goes on behind it for the next
 * time. Limits are read for the whole computer at once (Codex's app server, Cursor's and Copilot's servers, Claude's usage
 * page), and every one of them used to be waited for, up to eight seconds each, before Claude Code's figures were shown.
 */
export async function within<T>(key: string, read: () => Promise<T>, budget: number, none: T): Promise<T> {
  let p = reading.get(key) as Promise<T> | undefined;
  if (!p) {
    p = read()
      .then((v) => (lastRead.set(key, v), v))
      .catch(() => (lastRead.has(key) ? (lastRead.get(key) as T) : none))
      .finally(() => reading.delete(key));
    reading.set(key, p);
  }
  const late = Symbol("late");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const r = await Promise.race([p, new Promise<typeof late>((res) => (timer = setTimeout(() => res(late), budget)))]);
  clearTimeout(timer);
  return r === late ? (lastRead.has(key) ? (lastRead.get(key) as T) : none) : r;
}
/** How long the limits wait on any one source before its last answer stands in. */
const SOURCE_BUDGET_MS = 2500;

/**
 * Every tool's limits on this computer. `askClaude`: false to read Claude Code's as last said without asking it (a lane sharing
 * its limits as it opens, which is when Claude Code is being started).
 */
export async function readLimits(opts: { askClaude?: boolean } = {}): Promise<Limits> {
  const askClaude = opts.askClaude !== false;
  const [codexRead, , cursor, copilot, tools, accounts] = await Promise.all([
    within("codex", readCodex, SOURCE_BUDGET_MS, null),
    askClaude ? within("claude", () => askClaudeUsage(), SOURCE_BUDGET_MS, undefined) : undefined,
    within("cursor", readCursor, SOURCE_BUDGET_MS, null),
    within("copilot", readCopilot, SOURCE_BUDGET_MS, null),
    within("tools", () => readOtherTools(), SOURCE_BUDGET_MS, {} as Awaited<ReturnType<typeof readOtherTools>>),
    within(askClaude ? "accounts" : "accounts-kept", () => readAccounts(Date.now(), { askClaude }), SOURCE_BUDGET_MS, {} as Awaited<ReturnType<typeof readAccounts>>),
  ]);
  const first = codexRead?.windows[0];
  const codex: CodexLimit | null = first ? { usedPercent: first.usedPercent ?? 0, windowMinutes: first.windowMinutes ?? 0, resetsAt: first.resetsAt, plan: codexRead!.plan, at: first.at } : null;
  // Read after the ask, so an answer that came in time is in it: what Claude Code said when asked and as it ran, each with when.
  const { windows: claudeWindows, asked } = await readClaude();
  const why = asked && !asked.available ? NO_PLAN : claudeWindows.length ? undefined : (claudeWhyNot.get("") ?? "Claude Code says its limits when asked and as it runs: they show here once it has.");
  return {
    codex,
    codexWindows: codexRead?.windows ?? [],
    codexFrom: codexRead?.from ?? null,
    cursor,
    copilot,
    claude: claudeWindows.reduce<ClaudeLimit | null>((a, w) => (!a || w.at > a.at ? w : a), null),
    claudeWindows,
    claudePlan: asked?.plan ?? null,
    claudeFrom: claudeWindows.length ? (asked?.available ? "account" : "runs") : null,
    ...(why ? { claudeWhy: why } : {}),
    tools,
    ...(Object.keys(accounts).length ? { accounts } : {}),
  };
}

const claudeWindow = (w: ClaudeLimit): LimitWindow => ({
  kind: w.kind ?? "usage",
  windowMinutes: w.kind === "five_hour" ? 300 : w.kind?.startsWith("seven_day") ? 10_080 : null,
  label: w.label ?? (w.kind === "five_hour" ? "Session" : w.kind === "seven_day" ? "Weekly" : w.kind === "overage" ? "Extra usage" : w.kind?.startsWith("seven_day_") ? `Weekly · ${w.kind.slice(10)}` : "Usage"),
  usedPercent: w.utilization === null ? null : w.utilization * 100,
  resetsAt: w.resetsAt,
  at: w.at,
  status: w.status,
});

/** Who a sign-in is, where the tool keeps that beside it: Claude Code's .claude.json, the email in Codex's ID token. */
async function accountEmail(tool: AccountTool, dir: string | null): Promise<string | null> {
  try {
    if (tool === "claude") {
      const file = dir ? path.join(dir, ".claude.json") : process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(homedir(), ".claude.json");
      const e = (JSON.parse(await readFile(file, "utf8")) as { oauthAccount?: { emailAddress?: unknown } }).oauthAccount?.emailAddress;
      return typeof e === "string" ? e : null;
    }
    const auth = JSON.parse(await readFile(path.join(dir ?? (process.env.CODEX_HOME || path.join(homedir(), ".codex")), "auth.json"), "utf8")) as { tokens?: { id_token?: unknown } };
    const id = auth.tokens?.id_token;
    if (typeof id !== "string") return null;
    const claims = JSON.parse(Buffer.from(id.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, any>;
    const e = claims.email ?? claims["https://api.openai.com/profile"]?.email;
    return typeof e === "string" ? e : null;
  } catch {
    return null;
  }
}

/** Each account of Claude Code and Codex, for a tool with more than one here: asked as that account. */
export async function readAccounts(now = Date.now(), opts: { askClaude?: boolean } = {}): Promise<Partial<Record<AccountTool, AccountUsage[]>>> {
  const out: Partial<Record<AccountTool, AccountUsage[]>> = {};
  await Promise.all(
    ACCOUNT_TOOLS.map(async (tool) => {
      const all = await listAccounts(tool);
      if (all.length < 2) return;
      out[tool] = await Promise.all(
        all.map(async (a): Promise<AccountUsage> => {
          const dir = a.id === DEFAULT_ACCOUNT ? null : accountDir(tool, a.id);
          const base = { id: a.id, label: a.label, email: await accountEmail(tool, dir), ...(isOut(a, now) ? { out: true, outUntil: a.outUntil ?? null } : {}) };
          if (tool === "claude") {
            const id = a.id === DEFAULT_ACCOUNT ? undefined : a.id;
            if (opts.askClaude !== false) await askClaudeUsage(id);
            const { windows, asked } = await readClaude(id);
            const why = asked && !asked.available ? NO_PLAN : windows.length ? undefined : (claudeWhyNot.get(id ?? "") ?? "Shown once Claude Code says them for this account.");
            return { ...base, plan: asked?.plan ?? null, windows: windows.map(claudeWindow), ...(why ? { why } : {}) };
          }
          const c = await askCodex(dir ?? undefined).catch(() => null);
          return { ...base, plan: c?.plan ?? null, windows: c?.windows ?? [], ...(c ? {} : { why: "Codex didn't say, for this account." }) };
        }),
      );
    }),
  );
  return out;
}
