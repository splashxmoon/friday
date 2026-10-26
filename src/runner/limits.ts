import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { childEnv, copilotSignedIn, findBin, launcher } from "./adapters.js";
import { codexRoots } from "./imports.js";
import { ghBin } from "./workspace.js";
import { readOtherTools, type ToolAllowance } from "./tool-limits.js";
import type { EngineTool } from "../types.js";
import { ACCOUNT_TOOLS, accountDir, DEFAULT_ACCOUNT, isOut, listAccounts, type AccountTool } from "./accounts.js";

/**
 * What each coding CLI says about its own limits, read on this machine.
 *
 * Codex writes its limits into its own session logs. Claude Code is asked the way its own /usage screen asks: its
 * sign-in token, read where Claude Code keeps it, sent to Anthropic's usage endpoint and nowhere else, never refreshed
 * (that is Claude Code's job, and doing it here would sign Claude Code out). When that can't answer, what Claude Code
 * announced in the stream of its last run is used instead, which is thinner: usually the five-hour window, without a
 * percentage.
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
  /** Where the windows came from: the account, asked just now, or what Claude Code said during its last run. */
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

const dir = () => path.join(homedir(), ".friday");
const claudeFile = () => path.join(dir(), "claude-limits.json");

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The order windows are shown in: the session first, then the week, then the narrower ones. */
const WINDOW_ORDER = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "overage"];
const rank = (k: string | null) => {
  const i = WINDOW_ORDER.indexOf(k ?? "");
  return i === -1 ? WINDOW_ORDER.length : i;
};

/** What was last said about each window. Kept in memory as well as on disk, so two events a moment apart cannot undo each other. */
const seen = new Map<string, ClaudeLimit>();
let loaded = false;

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

/** Called with every event type the Claude stream sends that the runner does not otherwise use. */
export function noteClaudeEvent(m: { type?: unknown; [k: string]: unknown }): void {
  const limit = claudeLimitFrom(m);
  if (!limit) return;
  void (async () => {
    if (!loaded) {
      loaded = true;
      for (const w of await readClaudeWindows()) seen.set(w.kind ?? "usage", w);
    }
    const key = limit.kind ?? "usage";
    // An event that does not say how full the window is must not erase what an earlier one did.
    const before = seen.get(key);
    seen.set(key, { ...limit, utilization: limit.utilization ?? (before && before.resetsAt === limit.resetsAt ? before.utilization : null) });
    await mkdir(dir(), { recursive: true });
    await writeFile(claudeFile(), JSON.stringify({ windows: Object.fromEntries(seen) }));
  })().catch(() => {});
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

/** Every window on disk, old single-limit files included. */
async function readClaudeWindows(): Promise<ClaudeLimit[]> {
  try {
    const j = JSON.parse(await readFile(claudeFile(), "utf8")) as { windows?: Record<string, ClaudeLimit> } & Partial<ClaudeLimit>;
    const list = j.windows ? Object.values(j.windows) : j.at ? [j as ClaudeLimit] : [];
    return list.sort((a, b) => rank(a.kind) - rank(b.kind));
  } catch {
    return [];
  }
}

interface ClaudeAccount {
  token: string | null;
  /** The plan its sign-in says it is on: Pro, Max, Team… */
  plan: string | null;
  /** Why the account can't be asked, when it can't. */
  why?: string;
}

/**
 * The keychain item Claude Code keeps a sign-in in on a Mac: "Claude Code-credentials" for its own folder, and with
 * CLAUDE_CONFIG_DIR set, that and the first 8 hex of the folder's SHA-256 (read from 2.1.307), which is what lets two sign-ins
 * live side by side (accounts.ts).
 */
export const claudeKeychainItem = (configDir?: string) => (configDir ? `Claude Code-credentials-${createHash("sha256").update(configDir.normalize("NFC")).digest("hex").slice(0, 8)}` : "Claude Code-credentials");

/** Where Claude Code keeps its sign-in: the keychain on a Mac, a file everywhere else (and on a Mac, where the keychain has none). */
async function claudeAccount(dir?: string): Promise<ClaudeAccount> {
  const fromJson = (text: string): ClaudeAccount => {
    const o = (JSON.parse(text) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown; subscriptionType?: unknown } }).claudeAiOauth;
    const plan = typeof o?.subscriptionType === "string" && o.subscriptionType ? o.subscriptionType[0]!.toUpperCase() + o.subscriptionType.slice(1) : null;
    if (typeof o?.accessToken !== "string") return { token: null, plan, why: "Claude Code isn't signed in to a Claude account here (an API key has no plan limits)." };
    // Signing out leaves the file with its tokens blanked and the plan still named: that is signed out, not expired.
    if (!o.accessToken) return { token: null, plan, why: "Claude Code is signed out on this computer. Sign in to it to see your weekly limits." };
    // An expired token is left alone: refreshing it here would spend the refresh token Claude Code is relying on.
    if (typeof o.expiresAt === "number" && o.expiresAt < Date.now() + 60_000) return { token: null, plan, why: "Claude Code's sign-in needs refreshing, which it does the next time it runs." };
    return { token: o.accessToken, plan };
  };
  const named = dir ?? process.env.CLAUDE_CONFIG_DIR;
  try {
    if (process.platform === "darwin") {
      const out = await new Promise<string>((resolve) =>
        execFile("security", ["find-generic-password", "-s", claudeKeychainItem(named), "-w"], { timeout: 5000 }, (e, stdout) => resolve(e ? "" : stdout)),
      );
      if (out.trim()) return fromJson(out.trim());
    }
    return fromJson(await readFile(path.join(named || path.join(homedir(), ".claude"), ".credentials.json"), "utf8"));
  } catch {
    return { token: null, plan: null, why: "Claude Code isn't signed in to a Claude account here." };
  }
}

const resetOf = (v: unknown): number | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? Math.round(t / 1000) : null;
};
const fraction = (pct: number) => Math.min(1, Math.max(0, pct / 100));
const nameOf = (v: unknown): string => (typeof v === "string" ? v : typeof (v as { display_name?: unknown } | null)?.display_name === "string" ? (v as { display_name: string }).display_name : "");

/**
 * The usage endpoint's answer as windows, as fractions with their reset times.
 *
 * Plans answer in two shapes. Pro and Max fill per-window fields (`five_hour`, `seven_day`, `seven_day_opus`…); Team and
 * newer accounts send a `limits` list instead and leave those null, and the list is the only place a week that counts
 * one model appears. Both are read and joined by window, the list winning where they overlap. A window with no figure
 * (null, or a plan without that limit) is left out rather than shown as empty.
 */
export function claudeWindowsFrom(body: unknown, at = Date.now()): ClaudeLimit[] {
  if (!body || typeof body !== "object") return [];
  const out = new Map<string, ClaudeLimit>();
  for (const [key, v] of Object.entries(body as Record<string, unknown>)) {
    const w = v as { utilization?: unknown; resets_at?: unknown } | null;
    const pct = num(w?.utilization);
    if (pct === null) continue;
    const kind = key === "extra_usage" ? "overage" : key;
    out.set(kind, { status: null, kind, utilization: fraction(pct), resetsAt: resetOf(w!.resets_at), at });
  }
  const list = (body as { limits?: unknown }).limits;
  for (const l of Array.isArray(list) ? (list as any[]) : []) {
    const pct = num(l?.percent);
    if (pct === null) continue;
    const group = typeof l.group === "string" ? l.group : "";
    const scope = nameOf(l.scope?.model) || nameOf(l.scope?.surface);
    const kind = group === "session" ? "five_hour" : group === "weekly" ? (scope ? `seven_day_${scope.toLowerCase().replace(/\W+/g, "_")}` : "seven_day") : String(l.kind || group || "usage");
    out.set(kind, {
      status: typeof l.severity === "string" ? l.severity : null,
      kind,
      ...(scope ? { label: `${group === "weekly" ? "Weekly" : group === "session" ? "Session" : "Limit"} · ${scope}` } : {}),
      utilization: fraction(pct),
      resetsAt: resetOf(l.resets_at),
      at,
    });
  }
  return [...out.values()].sort((a, b) => rank(a.kind) - rank(b.kind));
}

interface ClaudeUsage {
  windows: ClaudeLimit[];
  plan: string | null;
  /** True when the account itself answered, even with no windows. */
  asked: boolean;
  /** Its last answer, kept, as it couldn't be asked now. */
  kept?: boolean;
  why?: string;
}

const REFRESH = "Claude Code's sign-in needs refreshing, which it does the next time it runs.";

/**
 * Asked at most once a minute: the panel opens often, and the answer moves slowly. Told to slow down (429), not again for
 * BACK_OFF_MS, or for as long as the answer said.
 */
const asked = new Map<string, { at: number; until: number; usage: Promise<ClaudeUsage> }>();
const ASK_EVERY_MS = 60_000;
const BACK_OFF_MS = 5 * 60_000;
/**
 * How long the account's last answer stands in when it can't be asked: its sign-in mid-refresh, Anthropic slow, busy or down.
 * Each window carries when it was read, and one whose reset has passed shows as reset. Before, any of those emptied the card
 * and put the last run's thinner figures in its place, or nothing, until the next ask worked (Arun, 2026-10-24: "make sure we
 * are properly fetching the claude code usage limits it needs to be stabler and fast").
 */
const KEEP_MS = 12 * 60 * 60_000;
const goodFile = () => path.join(dir(), "claude-usage.json");
let good: Record<string, { at: number; usage: ClaudeUsage }> | null = null;
async function goodFor(key: string): Promise<{ at: number; usage: ClaudeUsage } | null> {
  if (!good) {
    try {
      good = JSON.parse(await readFile(goodFile(), "utf8")) as Record<string, { at: number; usage: ClaudeUsage }>;
    } catch {
      good = {};
    }
  }
  const g = good[key];
  return g && Date.now() - g.at < KEEP_MS ? g : null;
}
async function keepGood(key: string, usage: ClaudeUsage): Promise<void> {
  await goodFor(key);
  good![key] = { at: Date.now(), usage };
  await mkdir(dir(), { recursive: true }).catch(() => {});
  await writeFile(goodFile(), JSON.stringify(good)).catch(() => {});
}

/** `dir`: one of its accounts' folders (accounts.ts). */
function fetchClaudeUsage(dir?: string): Promise<ClaudeUsage> {
  const key = dir ?? "";
  const was = asked.get(key);
  if (was && Date.now() < was.until) return was.usage;
  let backOff = 0;
  const usage = (async (): Promise<ClaudeUsage> => {
    const acct = await claudeAccount(dir);
    // Signed out, or not on a Claude account at all: nothing to keep showing.
    if (!acct.token && acct.why !== REFRESH) return { windows: [], plan: acct.plan, asked: false, ...(acct.why ? { why: acct.why } : {}) };
    let why = REFRESH;
    if (acct.token) {
      const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: { Authorization: `Bearer ${acct.token}`, "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8000),
      }).catch(() => null);
      if (r?.ok) {
        const fresh: ClaudeUsage = { windows: claudeWindowsFrom(await r.json()), plan: acct.plan, asked: true };
        void keepGood(key, fresh);
        return fresh;
      }
      if (r?.status === 429) backOff = Math.max(BACK_OFF_MS, (Number(r.headers.get("retry-after")) || 0) * 1000);
      why = !r ? "Claude's usage page didn't answer." : r.status === 401 ? REFRESH : r.status === 429 ? "Claude's usage page asked to be asked less often." : `Claude's usage page answered ${r.status}.`;
    }
    const kept = await goodFor(key);
    return kept ? { ...kept.usage, asked: true, kept: true, why } : { windows: [], plan: acct.plan, asked: false, why };
  })().catch((): ClaudeUsage => ({ windows: [], plan: null, asked: false, why: "Claude's usage page didn't answer." }));
  const at = Date.now();
  asked.set(key, { at, until: at + ASK_EVERY_MS, usage });
  void usage.then(() => backOff && asked.set(key, { at, until: at + backOff, usage }));
  return usage;
}

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

export async function readLimits(): Promise<Limits> {
  const none: ClaudeUsage = { windows: [], plan: null, asked: false };
  const [codexRead, announced, fetched, cursor, copilot, tools, accounts] = await Promise.all([
    within("codex", readCodex, SOURCE_BUDGET_MS, null),
    readClaudeWindows(),
    within("claude", () => fetchClaudeUsage(), SOURCE_BUDGET_MS, none),
    within("cursor", readCursor, SOURCE_BUDGET_MS, null),
    within("copilot", readCopilot, SOURCE_BUDGET_MS, null),
    within("tools", () => readOtherTools(), SOURCE_BUDGET_MS, {} as Awaited<ReturnType<typeof readOtherTools>>),
    within("accounts", () => readAccounts(), SOURCE_BUDGET_MS, {} as Awaited<ReturnType<typeof readAccounts>>),
  ]);
  const first = codexRead?.windows[0];
  const codex: CodexLimit | null = first ? { usedPercent: first.usedPercent ?? 0, windowMinutes: first.windowMinutes ?? 0, resetsAt: first.resetsAt, plan: codexRead!.plan, at: first.at } : null;
  // When the account answered, it is the whole truth: a window it didn't list is one the plan doesn't have right now, and
  // an old figure from a run would be shown as if it still applied. Otherwise the last run's announcements are what there is.
  const claudeWindows = (fetched.asked ? fetched.windows : announced)
    .map((w) => (w.utilization !== null && w.utilization > 1 ? { ...w, utilization: w.utilization / 100 } : w))
    .sort((a, b) => rank(a.kind) - rank(b.kind));
  return {
    codex,
    codexWindows: codexRead?.windows ?? [],
    codexFrom: codexRead?.from ?? null,
    cursor,
    copilot,
    claude: claudeWindows.reduce<ClaudeLimit | null>((a, w) => (!a || w.at > a.at ? w : a), null),
    claudeWindows,
    claudePlan: fetched.plan,
    claudeFrom: fetched.asked ? "account" : claudeWindows.length ? "runs" : null,
    ...(fetched.why ? { claudeWhy: fetched.why } : {}),
    ...(fetched.kept ? { claudeKept: true } : {}),
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
export async function readAccounts(now = Date.now()): Promise<Partial<Record<AccountTool, AccountUsage[]>>> {
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
            const u = await fetchClaudeUsage(dir ?? undefined);
            return { ...base, plan: u.plan, windows: u.windows.map(claudeWindow), ...(u.why ? { why: u.why } : {}) };
          }
          const c = await askCodex(dir ?? undefined).catch(() => null);
          return { ...base, plan: c?.plan ?? null, windows: c?.windows ?? [], ...(c ? {} : { why: "Codex didn't say, for this account." }) };
        }),
      );
    }),
  );
  return out;
}
