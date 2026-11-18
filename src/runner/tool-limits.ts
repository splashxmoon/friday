import { createDecipheriv } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { devNull, homedir } from "node:os";
import path from "node:path";
import type { EngineTool } from "../types.js";
import type { LimitWindow } from "./limits.js";
import { childEnv, findBin, launcher, loginStatusCached, toolEnv } from "./adapters.js";
import { execCli } from "./spawn-cli.js";

/**
 * What the other coding tools say about their own limits, read on this machine (Claude Code, Codex, Cursor and Copilot are in
 * limits.ts).
 *
 * Each is asked the way the tool asks itself, worked out from what it sends: its own sign-in, read where the tool keeps it, sent
 * to the tool's own server and nowhere else, never refreshed. A sign-in that has lapsed is the tool's to renew the next time it
 * runs, and doing it here could sign the tool out; meanwhile the last reading is shown with its age. That is rarely old for long:
 * a tool only spends its limits while it runs, and running is what renews its sign-in.
 *
 * Kiro, Devin, Cline and Kilo were checked against real accounts (October 2026). The rest are read as the three open-source apps
 * that show these limits read them (T3 Code, Orca and Synara, November 2026): Gemini CLI, Grok Build, Factory Droid, OpenCode Go
 * and Devin as they do, Amp as the open-source usage trackers do. Antigravity is asked of Google directly with agy's own sign-in
 * (T3 Code, Synara), and agy itself only when that can't be read (Orca). JetBrains Junie keeps its sign-in in the keychain under
 * names nobody has documented, and OpenCode's free models report nothing: both say so instead.
 *
 * A reading that fails is asked again after a minute, and the last good one shows meanwhile; a window whose reset has passed shows
 * empty rather than as full as it last was.
 */

/** One tool's allowance, the same shape for every tool here. */
export interface ToolAllowance {
  plan: string | null;
  windows: LimitWindow[];
  /** Credits left to spend, in dollars, for a tool that sells credits rather than resetting a window. */
  balanceUsd?: number;
  /** When it was read, in ms. */
  at: number;
  /** The last good reading, shown because the tool's sign-in has lapsed since (see `why`). */
  stale?: boolean;
  /** Why it couldn't be read just now, or why there is nothing to read. */
  why?: string;
}

const home = () => homedir();
const roaming = () => process.env.APPDATA || path.join(home(), "AppData", "Roaming");
const local = () => process.env.LOCALAPPDATA || path.join(home(), "AppData", "Local");
const mac = process.platform === "darwin";
const win = process.platform === "win32";

const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const pct = (used: number | null, limit: number | null) => (used === null || !limit ? null : Math.max(0, Math.min(100, (used / limit) * 100)));
const secs = (v: unknown): number | null => {
  const n = num(v);
  if (n !== null) return n > 1e11 ? Math.round(n / 1000) : Math.round(n);
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? Math.round(t / 1000) : null;
};
const window = (kind: string, label: string, usedPercent: number | null, resetsAt: number | null, windowMinutes: number | null = null): LimitWindow => ({
  kind,
  label,
  windowMinutes,
  usedPercent,
  resetsAt,
  at: Date.now(),
});

async function readJson(file: string): Promise<any> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}
const exists = (file: string) => stat(file).then(() => true, () => false);

let sqlite: Promise<any> | null = null;
/** Rows from a tool's SQLite file, opened read-only. Null when there is no such file, or no node:sqlite (Node 22.13+). */
export async function sqliteRows(file: string, sql: string): Promise<Record<string, unknown>[] | null> {
  const name = "node:sqlite";
  sqlite ??= import(name).catch(() => null);
  const sq = await sqlite;
  if (!sq?.DatabaseSync || !(await exists(file))) return null;
  let db: any;
  try {
    db = new sq.DatabaseSync(file, { readOnly: true });
    return db.prepare(sql).all() as Record<string, unknown>[];
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
const text = (v: unknown) => (typeof v === "string" ? v : v instanceof Uint8Array ? Buffer.from(v).toString("utf8") : "");

/** A token's own expiry, from a JWT's `exp`, in ms; null when it carries none. */
function jwtExpiry(token: string): number | null {
  try {
    const exp = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))?.exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Whether a URL is one of the tool's own hosts: a sign-in is never sent anywhere else, whatever a settings file says. */
const ownHost = (url: string, hosts: string[]) => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
};

/** One request to a tool's own server, given up on after eight seconds. */
async function ask(url: string, init: RequestInit = {}): Promise<{ status: number; json: any }> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  const body = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(body);
  } catch {
    json = null;
  }
  return { status: r.status, json };
}

// ── the last good reading of each, kept on disk ─────────────────────

const keptFile = () => path.join(home(), ".friday", "tool-limits.json");
let keptCache: Partial<Record<EngineTool, ToolAllowance>> | null = null;

async function keptAll(): Promise<Partial<Record<EngineTool, ToolAllowance>>> {
  keptCache ??= ((await readJson(keptFile())) as Partial<Record<EngineTool, ToolAllowance>> | null) ?? {};
  return keptCache;
}
async function remember(tool: EngineTool, a: ToolAllowance): Promise<ToolAllowance> {
  const all = await keptAll();
  all[tool] = a;
  await mkdir(path.dirname(keptFile()), { recursive: true }).catch(() => {});
  await writeFile(keptFile(), JSON.stringify(all)).catch(() => {});
  return a;
}
/** The last good reading, marked as such, with why it couldn't be read now; or only why, when there has never been one. */
async function kept(tool: EngineTool, why: string): Promise<ToolAllowance> {
  const last = (await keptAll())[tool];
  return last ? { ...last, stale: true, why } : { plan: null, windows: [], at: Date.now(), why };
}
const lapsed = (name: string) => `${name}'s sign-in renews the next time it runs.`;

// ── Kiro ────────────────────────────────────────────────────────────

const kiroDb = () =>
  win ? path.join(local(), "Kiro-Cli", "data.sqlite3") : mac ? path.join(home(), "Library", "Application Support", "kiro-cli", "data.sqlite3") : path.join(home(), ".local", "share", "kiro-cli", "data.sqlite3");

/** Kiro's GetUsageLimits answer: this month's credits (and any bonus or trial credits), and the plan. */
export function kiroFrom(j: Record<string, any> | null): ToolAllowance {
  const reset = secs(j?.nextDateReset);
  const windows: LimitWindow[] = (Array.isArray(j?.usageBreakdownList) ? j!.usageBreakdownList : []).flatMap((u: any): LimitWindow[] => {
    const limit = num(u?.usageLimitWithPrecision ?? u?.usageLimit);
    if (!limit) return [];
    const rows = [window(String(u.resourceType ?? "credits"), "Monthly credits", pct(num(u.currentUsageWithPrecision ?? u.currentUsage), limit), secs(u.nextDateReset) ?? reset)];
    for (const b of Array.isArray(u.bonuses) ? u.bonuses : []) {
      const bl = num(b?.usageLimit ?? b?.usageLimitWithPrecision);
      if (bl) rows.push(window("bonus", "Bonus credits", pct(num(b.currentUsage ?? b.currentUsageWithPrecision), bl), secs(b.expiresAt ?? b.expiryDate)));
    }
    return rows;
  });
  const trial = j?.freeTrialInfo;
  if (trial && num(trial.usageLimit)) windows.push(window("trial", "Trial credits", pct(num(trial.currentUsage), num(trial.usageLimit)), secs(trial.freeTrialExpiry)));
  const title = typeof j?.subscriptionInfo?.subscriptionTitle === "string" ? j.subscriptionInfo.subscriptionTitle : "";
  const plan = title.replace(/^kiro\s+/i, "").toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase()) || null;
  return { plan, windows, at: Date.now() };
}

async function readKiro(): Promise<ToolAllowance | null> {
  const rows = await sqliteRows(kiroDb(), "select key, value from auth_kv where key like 'kirocli:%token'");
  if (rows === null) return null;
  const token = rows.map((r) => {
    try {
      return JSON.parse(text(r.value)) as Record<string, any>;
    } catch {
      return null;
    }
  }).find((t) => typeof t?.access_token === "string");
  if (!token) return kept("kiro", "Sign in to Kiro (kiro-cli login) to see this here.");
  if (!(Date.parse(String(token.expires_at)) > Date.now() + 60_000)) return kept("kiro", lapsed("Kiro"));
  let arn = typeof token.profile_arn === "string" ? token.profile_arn : "";
  if (!arn) {
    const p = await sqliteRows(kiroDb(), "select value from state where key = 'api.codewhisperer.profile'");
    try {
      arn = JSON.parse(text(p?.[0]?.value))?.arn ?? "";
    } catch {
      arn = "";
    }
  }
  const region = /^arn:aws:[\w-]+:([a-z0-9-]+):/.exec(arn)?.[1] ?? "us-east-1";
  const r = await ask(`https://q.${region}.amazonaws.com/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-amz-json-1.0", "X-Amz-Target": "AmazonCodeWhispererService.GetUsageLimits", Authorization: `Bearer ${token.access_token}` },
    body: JSON.stringify({ origin: "KIRO_CLI", ...(arn ? { profileArn: arn } : {}), resourceType: "AGENTIC_REQUEST" }),
  });
  if (r.status === 403 || r.status === 401) return kept("kiro", lapsed("Kiro"));
  if (r.status !== 200) return kept("kiro", "Kiro's usage didn't answer just now.");
  return remember("kiro", kiroFrom(r.json));
}

// ── Devin ───────────────────────────────────────────────────────────

const devinCredentials = () => [
  path.join(process.env.XDG_DATA_HOME || path.join(home(), ".local", "share"), "devin", "credentials.toml"),
  path.join(roaming(), "devin", "credentials.toml"),
  path.join(home(), ".config", "devin", "credentials.toml"),
  path.join(home(), "Library", "Application Support", "devin", "credentials.toml"),
];
/** What the CLI calls itself to its server. */
const DEVIN_CLIENT = { ideName: "chisel", ideVersion: "3000.11.3", extensionName: "chisel", extensionVersion: "3000.11.3", locale: "en" };

/** Devin's GetUserStatus answer: today's and this week's share of the quota, extra usage, ACUs, and the plan. */
export function devinFrom(j: Record<string, any> | null): ToolAllowance {
  const raw = j?.userStatus?.planStatus ?? j?.user_status?.plan_status ?? {};
  // Its answer in either case: camelCase from the Connect JSON, snake_case from older servers.
  const s: Record<string, any> = { ...raw };
  for (const [k, v] of Object.entries(raw)) s[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] ??= v;
  if (s.planInfo && typeof s.planInfo === "object") for (const [k, v] of Object.entries(s.planInfo)) s.planInfo[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] ??= v;
  const windows: LimitWindow[] = [];
  // Zero values are left out of the answer: a reset time without a percentage left means none is.
  const left = (v: unknown) => num(v) ?? 0;
  if (!s.hideDailyQuota && !s.planInfo?.hideDailyQuota && s.dailyQuotaResetAtUnix) windows.push(window("daily", "Daily", 100 - left(s.dailyQuotaRemainingPercent), secs(s.dailyQuotaResetAtUnix), 1440));
  if (!s.hideWeeklyQuota && !s.planInfo?.hideWeeklyQuota && s.weeklyQuotaResetAtUnix) windows.push(window("weekly", "Weekly", 100 - left(s.weeklyQuotaRemainingPercent), secs(s.weeklyQuotaResetAtUnix), 10080));
  const acuLimit = num(s.acuLimit);
  if (acuLimit) windows.push(window("acu", "ACUs", pct(num(s.acuConsumed) ?? 0, acuLimit), secs(s.planEnd)));
  const extra = num(s.overageBalanceMicros);
  return { plan: typeof s.planInfo?.planName === "string" ? s.planInfo.planName : null, windows, ...(extra ? { balanceUsd: extra / 1e6 } : {}), at: Date.now() };
}

function toml(textIn: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of textIn.split(/\r?\n/)) {
    const m = /^\s*([\w.-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/\\(.)/g, "$1");
  }
  return out;
}

async function readDevin(): Promise<ToolAllowance | null> {
  const envKey = process.env.WINDSURF_API_KEY || process.env.DEVIN_API_KEY;
  let creds: Record<string, string> | null = envKey ? { windsurf_api_key: envKey, api_server_url: process.env.WINDSURF_API_SERVER_URL || process.env.DEVIN_API_SERVER_URL || "" } : null;
  for (const f of creds ? [] : devinCredentials()) {
    const t = await readFile(f, "utf8").catch(() => null);
    if (t !== null) {
      creds = toml(t);
      break;
    }
  }
  if (!creds) return null;
  const key = creds.windsurf_api_key ?? creds.api_key;
  if (!key) return kept("devin", "Sign in to Devin (devin auth login) to see this here.");
  const host = creds.api_server_url || "https://server.codeium.com";
  if (!ownHost(host, ["codeium.com", "windsurf.com", "devin.ai", "cognition.ai"])) return kept("devin", "Devin's usage server isn't one Friday recognises.");
  const r = await ask(`${host.replace(/\/+$/, "")}/exa.seat_management_pb.SeatManagementService/GetUserStatus`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
    body: JSON.stringify({ metadata: { apiKey: key, ...DEVIN_CLIENT } }),
  });
  if (r.status === 401) return kept("devin", "Sign in to Devin again (devin auth login) to see this here.");
  if (r.status !== 200) return kept("devin", "Devin's usage didn't answer just now.");
  return remember("devin", devinFrom(r.json));
}

// ── Cline ───────────────────────────────────────────────────────────

/** Cline's credits, from its balance in millionths of a dollar, with its plan when it has ClinePass. */
export function clineFrom(balance: Record<string, any> | null, plan: Record<string, any> | null): ToolAllowance {
  const micro = num(balance?.data?.balance ?? balance?.balance);
  const name = plan?.data?.displayName ?? plan?.data?.name ?? plan?.displayName;
  return { plan: typeof name === "string" && name ? name : "Pay as you go", windows: [], ...(micro !== null ? { balanceUsd: micro / 1e6 } : {}), at: Date.now() };
}

async function readCline(): Promise<ToolAllowance | null> {
  const j = await readJson(path.join(home(), ".cline", "data", "settings", "providers.json"));
  if (!j) return null;
  const auth = j?.providers?.cline?.settings?.auth;
  // Signed in to another provider instead: its limits are that provider's, not Cline's.
  if (!auth?.accessToken) return null;
  // Cline's sign-in lasts an hour and is renewed only while Cline runs.
  const expires = num(auth.expiresAt) ?? jwtExpiry(auth.accessToken);
  if (!expires || expires < Date.now() + 60_000) return kept("cline", lapsed("Cline"));
  const headers = { Authorization: `Bearer workos:${auth.accessToken}`, "Content-Type": "application/json" };
  const me = await ask("https://api.cline.bot/api/v1/users/me", { headers });
  if (me.status === 401) return kept("cline", lapsed("Cline"));
  const id = me.json?.data?.id;
  if (me.status !== 200 || typeof id !== "string") return kept("cline", "Cline's credits didn't answer just now.");
  // What the CLI shows: the organisation's balance when one is active, else the person's own.
  const org = (Array.isArray(me.json.data.organizations) ? me.json.data.organizations : []).find((o: any) => o?.active && typeof o.organizationId === "string");
  const [balance, plan] = await Promise.all([
    ask(org ? `https://api.cline.bot/api/v1/organizations/${encodeURIComponent(org.organizationId)}/balance` : `https://api.cline.bot/api/v1/users/${encodeURIComponent(id)}/balance`, { headers }),
    ask("https://api.cline.bot/api/v1/users/me/plan", { headers }).catch(() => ({ status: 0, json: null })),
  ]);
  if (balance.status !== 200) return kept("cline", "Cline's credits didn't answer just now.");
  return remember("cline", clineFrom(balance.json, plan.status === 200 ? plan.json : null));
}

// ── Kilo ────────────────────────────────────────────────────────────

/** Kilo's balance in dollars, and Kilo Pass's share of this billing period when there is a subscription. */
export function kiloFrom(balance: Record<string, any> | null, pass: unknown): ToolAllowance {
  const sub = (Array.isArray(pass) ? pass[0] : pass) as any;
  const s = sub?.result?.data?.subscription ?? sub?.result?.data?.json?.subscription ?? null;
  const windows: LimitWindow[] = [];
  if (s && num(s.currentPeriodBaseCreditsUsd)) {
    const base = num(s.currentPeriodBaseCreditsUsd)! + (num(s.currentPeriodBonusCreditsUsd) ?? 0);
    windows.push(window("pass", "Kilo Pass", pct(num(s.currentPeriodUsageUsd) ?? 0, base), secs(s.nextBillingAt)));
  }
  const usd = num(balance?.balance);
  return { plan: s ? "Kilo Pass" : "Credits", windows, ...(usd !== null ? { balanceUsd: usd } : {}), at: Date.now() };
}

async function readKilo(): Promise<ToolAllowance | null> {
  const j = await readJson(path.join(home(), ".local", "share", "kilo", "auth.json"));
  const k = j?.kilo;
  if (!k) return null;
  if (typeof k.access !== "string") return kept("kilo", "Sign in to Kilo (kilo auth login) to see this here.");
  const expires = num(k.expires) ?? jwtExpiry(k.access);
  if (expires && expires < Date.now() + 60_000) return kept("kilo", lapsed("Kilo"));
  const base = process.env.KILO_API_URL && ownHost(process.env.KILO_API_URL, ["kilo.ai", "kilocode.ai"]) ? process.env.KILO_API_URL.replace(/\/+$/, "") : "https://api.kilo.ai";
  const headers = { Authorization: `Bearer ${k.access}`, "X-KILOCODE-EDITORNAME": "Kilo CLI" };
  const [balance, pass] = await Promise.all([
    ask(`${base}/api/profile/balance`, { headers }),
    ask(`${base}/api/trpc/kiloPass.getState?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: null }))}`, { headers }).catch(() => ({ status: 0, json: null })),
  ]);
  if (balance.status === 401) return kept("kilo", "Sign in to Kilo again (kilo auth login) to see this here.");
  if (balance.status !== 200) return kept("kilo", "Kilo's balance didn't answer just now.");
  return remember("kilo", kiloFrom(balance.json, pass.status === 200 ? pass.json : null));
}

// ── OpenCode ────────────────────────────────────────────────────────

/** Where OpenCode keeps its data: the same on every system, with Windows' own folders after. */
const opencodeDirs = () =>
  [process.env.OPENCODE_DATA_DIR, path.join(process.env.XDG_DATA_HOME || path.join(home(), ".local", "share"), "opencode"), ...(win ? [path.join(roaming(), "opencode"), path.join(local(), "opencode")] : [])].filter((d): d is string => !!d);

/** OpenCode Go's usage answer: its rolling five hours, its week and its month, each a percentage and a reset. */
export function opencodeGoFrom(j: Record<string, any> | null): ToolAllowance | null {
  const u = j?.usage ?? j;
  const windows: LimitWindow[] = [];
  for (const [key, label, minutes] of [["rolling", "5h", 300], ["weekly", "Weekly", 10080], ["monthly", "Monthly", 43200]] as const) {
    const w = u?.[key];
    const used = num(w?.percent);
    if (used === null && !w?.limited) continue;
    windows.push(window(`go-${key}`, label, w?.limited ? 100 : Math.max(0, Math.min(100, used!)), secs(w?.resetsAt ?? w?.resets_at), minutes));
  }
  return windows.length ? { plan: "OpenCode Go", windows, at: Date.now() } : null;
}

/** OpenCode Go's keys, newest sign-in first: its env, its auth.json (v1), its database (v2), OPENCODE_API_KEY (as T3 Code and Orca find them). */
async function opencodeGoKeys(dirs: string[]): Promise<string[]> {
  const keys: string[] = [];
  const fromAuth = (a: any) => {
    for (const id of ["opencode-go", "opencode"]) if (typeof a?.[id]?.key === "string" && a[id].key) keys.push(a[id].key);
  };
  try {
    if (process.env.OPENCODE_AUTH_CONTENT) fromAuth(JSON.parse(process.env.OPENCODE_AUTH_CONTENT));
  } catch {
    /* not JSON */
  }
  for (const d of dirs) {
    fromAuth(await readJson(path.join(d, "auth.json")));
    const rows = await sqliteRows(path.join(d, process.env.OPENCODE_DB || "opencode.db"), "select integration_id, value from credential where integration_id in ('opencode-go', 'opencode') and active is not 0 order by integration_id = 'opencode-go' desc, active desc, time_created desc limit 8");
    for (const r of rows ?? []) {
      try {
        const v = JSON.parse(text(r.value));
        if (typeof v?.key === "string" && v.key) keys.push(v.key);
      } catch {
        /* the next */
      }
    }
  }
  if (process.env.OPENCODE_API_KEY) keys.push(process.env.OPENCODE_API_KEY);
  return [...new Set(keys)];
}

/** OpenCode Go's limits from its own usage endpoint; its free models report none, and its pay-as-you-go use only in its console. */
async function readOpenCode(): Promise<ToolAllowance | null> {
  const dirs = opencodeDirs();
  const there = (await Promise.all(dirs.map(exists))).some(Boolean);
  const keys = await opencodeGoKeys(dirs);
  if (!there && !keys.length) return null;
  if (!keys.length) {
    const auths = await Promise.all(dirs.map((d) => readJson(path.join(d, "auth.json"))));
    const other = auths.some((a) => a && typeof a === "object" && Object.keys(a).length > 0);
    return other
      ? { plan: null, windows: [], at: Date.now(), why: "OpenCode reports limits for its Go plan; other use shows only in its console." }
      : { plan: "Free models", windows: [], at: Date.now(), why: "OpenCode doesn't report its free models' limits." };
  }
  let refused = 0;
  for (const key of keys) {
    const r = await ask("https://opencode.ai/zen/go/v1/usage", { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
    if (r.status === 401 || r.status === 403) {
      refused = r.status;
      continue;
    }
    if (r.status !== 200) return kept("opencode", "OpenCode Go's usage didn't answer just now.");
    const a = opencodeGoFrom(r.json);
    if (a) return remember("opencode", a);
  }
  if (refused === 401) return kept("opencode", "Sign in to OpenCode again (opencode auth login) to see this here.");
  return { plan: null, windows: [], at: Date.now(), why: "OpenCode reports limits for its Go plan; other use shows only in its console." };
}

// ── Gemini CLI ──────────────────────────────────────────────────────

/** Gemini CLI's quota buckets: how much of each model's allowance is used, and when it resets. */
export function geminiFrom(quota: Record<string, any> | any[] | null, account: Record<string, any> | null): ToolAllowance {
  const buckets: any[] = Array.isArray(quota) ? quota : Array.isArray(quota?.buckets) ? quota!.buckets : [];
  const byModel = new Map<string, LimitWindow>();
  for (const b of buckets) {
    const left = num(b?.remainingFraction);
    if (typeof b?.modelId !== "string" || left === null) continue;
    const w = window(b.modelId, b.modelId.replace(/^gemini-/, "Gemini "), Math.max(0, Math.min(100, (1 - left) * 100)), secs(b.resetTime));
    const had = byModel.get(b.modelId);
    if (!had || (w.usedPercent ?? 0) > (had.usedPercent ?? 0)) byModel.set(b.modelId, w);
  }
  const tier = account?.paidTier?.name ?? account?.currentTier?.name;
  return { plan: typeof tier === "string" ? tier : null, windows: [...byModel.values()].sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0)).slice(0, 4), at: Date.now() };
}

async function readGemini(): Promise<ToolAllowance | null> {
  const creds = await readJson(path.join(process.env.GEMINI_CLI_HOME || home(), ".gemini", "oauth_creds.json"));
  if (!creds) return process.env.GEMINI_API_KEY ? { plan: "API key", windows: [], at: Date.now(), why: "Gemini CLI runs on an API key here: its usage is in Google AI Studio." } : null;
  if (typeof creds.access_token !== "string" || !(num(creds.expiry_date) ?? 0) || num(creds.expiry_date)! < Date.now() + 60_000) return kept("gemini", lapsed("Gemini CLI"));
  const host = "https://cloudcode-pa.googleapis.com/v1internal";
  const headers = { Authorization: `Bearer ${creds.access_token}`, "Content-Type": "application/json" };
  const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || undefined;
  const account = await ask(`${host}:loadCodeAssist`, {
    method: "POST",
    headers,
    body: JSON.stringify({ cloudaicompanionProject: project, metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI", duetProject: project } }),
  });
  if (account.status === 401) return kept("gemini", lapsed("Gemini CLI"));
  const id = project ?? account.json?.cloudaicompanionProject?.id ?? account.json?.cloudaicompanionProject;
  if (account.status !== 200 || typeof id !== "string") return kept("gemini", "Gemini CLI's quota didn't answer. Since June 2026 it serves only Code Assist Standard and Enterprise.");
  const quota = await ask(`${host}:retrieveUserQuota`, { method: "POST", headers, body: JSON.stringify({ project: id }) });
  if (quota.status !== 200) return kept("gemini", "Gemini CLI's quota didn't answer just now.");
  return remember("gemini", geminiFrom(quota.json, account.json));
}

// ── Grok Build ──────────────────────────────────────────────────────

/** Grok's billing answer: the share of this week's (or month's) credits used, the month's spend, and prepaid credits left. */
export function grokFrom(j: Record<string, any> | null): ToolAllowance {
  const c = j?.config ?? j ?? {};
  // Amounts come as numbers or as `{ val }`.
  const amount = (v: any) => num(v?.val ?? v);
  const type = String(c.currentPeriod?.type ?? "");
  const weekly = /WEEK/.test(type) || (c.isUnifiedBillingUser === true && !/MONTH/.test(type));
  const end = secs(c.currentPeriod?.end ?? c.billingPeriodEnd ?? c.billingCycle?.billingPeriodEnd);
  let used = num(c.creditUsagePercent);
  // Nothing used yet leaves the percentage out of a weekly answer.
  if (used === null && /WEEK/.test(type) && end !== null) used = 0;
  const windows = used === null ? [] : [window("period", weekly ? "Weekly" : /MONTH/.test(type) ? "Monthly" : "This period", Math.max(0, Math.min(100, Math.floor(used))), end, weekly ? 10080 : null)];
  const limit = amount(c.monthlyLimit);
  const spent = amount(c.used ?? c.usage?.totalUsed);
  if (limit && spent !== null && !windows.some((w) => w.label === "Monthly")) windows.push(window("monthly", "Monthly", pct(spent, limit), secs(c.billingPeriodEnd ?? c.billingCycle?.billingPeriodEnd), 43200));
  const prepaid = amount(c.prepaidBalance);
  const tier = c.subscriptionTier ?? c.subscription_tier_display;
  return { plan: typeof tier === "string" && tier ? tier : null, windows, ...(prepaid ? { balanceUsd: prepaid / 100 } : {}), at: Date.now() };
}

async function readGrok(): Promise<ToolAllowance | null> {
  let all: any = null;
  try {
    all = process.env.GROK_AUTH ? JSON.parse(process.env.GROK_AUTH) : null;
  } catch {
    all = null;
  }
  all ??= await readJson(path.join(process.env.GROK_HOME || path.join(home(), ".grok"), "auth.json"));
  if (!all || typeof all !== "object") return null;
  // Its grok.com sign-in, the newest kind first (as Orca, Synara and T3 Code pick it); an API key has no plan limits.
  const entries = Object.entries(all as Record<string, any>).filter(([, a]) => a && typeof a === "object" && a.auth_mode !== "api_key");
  const rank = ([scope, a]: [string, any]) => (scope === "https://auth.x.ai" || scope.startsWith("https://auth.x.ai::") ? 0 : /auth\.x\.ai/.test(String(a?.oidc_issuer ?? "")) ? 1 : scope.startsWith("https://accounts.x.ai") ? 2 : 3);
  const entry = entries.filter((e) => rank(e) < 3).sort((x, y) => rank(x) - rank(y))[0]?.[1];
  if (!entry?.key) return { plan: null, windows: [], at: Date.now(), why: "Grok Build's usage needs a grok.com sign-in (grok login)." };
  const expires = entry.expires_at ? Date.parse(entry.expires_at) : Date.parse(String(entry.create_time ?? "")) + 30 * 86_400_000;
  if (!(expires - 300_000 > Date.now())) return kept("grok", lapsed("Grok Build"));
  const base = process.env.GROK_CLI_CHAT_PROXY_BASE_URL && ownHost(process.env.GROK_CLI_CHAT_PROXY_BASE_URL, ["grok.com", "x.ai"]) ? process.env.GROK_CLI_CHAT_PROXY_BASE_URL.replace(/\/+$/, "") : "https://cli-chat-proxy.grok.com/v1";
  const headers = { Authorization: `Bearer ${entry.key}`, Accept: "application/json", "X-XAI-Token-Auth": "xai-grok-cli", ...(entry.user_id ? { "x-userid": String(entry.user_id) } : {}) };
  let r = await ask(`${base}/billing?format=credits`, { headers });
  if (r.status === 403 && /privacy-mode/i.test(JSON.stringify(r.json ?? ""))) return kept("grok", "Switch your xAI account to Privacy Mode to see Grok Build's usage here.");
  if (r.status === 401 || r.status === 403) return kept("grok", lapsed("Grok Build"));
  if (r.status === 200 && !grokFrom(r.json).windows.length) {
    const plain = await ask(`${base}/billing`, { headers }).catch(() => ({ status: 0, json: null }));
    if (plain.status === 200 && grokFrom(plain.json).windows.length) r = plain;
  }
  if (r.status !== 200) return kept("grok", "Grok Build's usage didn't answer just now.");
  return remember("grok", grokFrom(r.json));
}

// ── Factory Droid ───────────────────────────────────────────────────

const DROID_WINDOWS: [string, string, number][] = [
  ["fiveHour", "5h", 300],
  ["weekly", "Weekly", 10080],
  ["monthly", "Monthly", 43200],
];

/** Droid's limits: five hours, the week and the month, for its standard models and Droid Core apart, and extra usage left. */
export function droidFrom(j: Record<string, any> | null): ToolAllowance {
  const windows: LimitWindow[] = [];
  for (const [group, suffix] of [["standard", ""], ["core", " · Core"]] as const) {
    for (const [key, label, minutes] of DROID_WINDOWS) {
      const w = j?.limits?.[group]?.[key];
      if (!w) continue;
      // A window whose end has passed has nothing in it yet: Droid itself shows it empty.
      const end = secs(w.windowEnd);
      const idle = end !== null && end * 1000 <= Date.now();
      windows.push(window(`${group}-${key}`, `${label}${suffix}`, idle ? 0 : num(w.usedPercent), idle ? null : end, minutes));
    }
  }
  const cents = num(j?.extraUsageBalanceCents);
  return { plan: null, windows, ...(cents ? { balanceUsd: cents / 100 } : {}), at: Date.now() };
}

/** Droid's sign-in once opened: its token, and the organisation and region it is for. */
interface DroidLogin {
  token: string;
  org: string | null;
  region: string | null;
}

/** A keyring read that failed or timed out isn't tried again while Friday runs: macOS may have asked about it. */
const droidKeyringFailed = new Set<string>();

/** The key Droid seals its sign-in with, for each of the ways it keeps one (as Synara reads them). */
async function droidKey(dir: string, layout: "file" | "keyring" | "loginkeychain"): Promise<Buffer | null> {
  if (layout === "file") {
    const k = await readFile(path.join(dir, "auth.v2.key"), "utf8").catch(() => null);
    return k ? Buffer.from(k.trim(), "base64") : null;
  }
  const account = layout === "loginkeychain" ? "auth-encryption-key-security-cli" : "auth-encryption-key";
  if (droidKeyringFailed.has(account)) return null;
  const r = mac
    ? await execCli("/usr/bin/security", ["find-generic-password", "-s", "Factory CLI", "-a", account, "-w"], { timeoutMs: 3000 }).catch(() => null)
    : process.platform === "linux"
      ? await execCli("secret-tool", ["lookup", "service", "Factory CLI", "account", account], { timeoutMs: 3000 }).catch(() => null)
      : null;
  const key = r?.code === 0 ? r.stdout.trim() : "";
  if (!key) droidKeyringFailed.add(account);
  return key ? Buffer.from(key, "base64") : null;
}

/** Droid's sign-in: FACTORY_API_KEY, else AES-GCM sealed beside its key (auth.v2.*, its key in a file or the keyring), else the older plain file. */
async function droidLogin(): Promise<DroidLogin | null> {
  if (process.env.FACTORY_API_KEY) return { token: process.env.FACTORY_API_KEY, org: null, region: null };
  const dir = path.join(home(), ".factory");
  for (const [sealedName, layout] of [["auth.v2.loginkeychain", "loginkeychain"], ["auth.v2.keyring", "keyring"], ["auth.v2.file", "file"]] as const) {
    const sealedText = await readFile(path.join(dir, sealedName), "utf8").catch(() => null);
    if (!sealedText) continue;
    try {
      const key = await droidKey(dir, layout);
      if (!key) continue;
      const [iv, tag, sealed] = sealedText.trim().split(":").map((p) => Buffer.from(p, "base64"));
      const d = createDecipheriv("aes-256-gcm", key, iv!);
      d.setAuthTag(tag!);
      const j = JSON.parse(Buffer.concat([d.update(sealed!), d.final()]).toString("utf8"));
      if (typeof j?.access_token === "string") return { token: j.access_token, org: typeof j.active_organization_id === "string" ? j.active_organization_id : null, region: typeof j.region === "string" ? j.region : null };
    } catch {
      /* the next */
    }
  }
  const old = await readJson(path.join(dir, "auth.json"));
  return typeof old?.access_token === "string" ? { token: old.access_token, org: null, region: null } : null;
}

async function readDroid(): Promise<ToolAllowance | null> {
  if (!process.env.FACTORY_API_KEY && !(await exists(path.join(home(), ".factory")))) return null;
  const login = await droidLogin();
  if (!login) return kept("droid", "Sign in to Droid to see this here.");
  const exp = jwtExpiry(login.token);
  if (exp !== null && exp < Date.now() + 60_000) return kept("droid", lapsed("Droid"));
  const host = login.region === "eu" ? "https://api.eu.factory.ai" : "https://api.factory.ai";
  const r = await ask(`${host}/api/billing/limits`, {
    headers: { Authorization: `Bearer ${login.token}`, Accept: "application/json", "X-Factory-Client": "cli", ...(login.org ? { "X-Factory-Org-Id": login.org } : {}) },
  });
  if (r.status === 401 || r.status === 403) return kept("droid", lapsed("Droid"));
  if (r.status !== 200) return kept("droid", "Droid's limits didn't answer just now.");
  if (r.json?.usesTokenRateLimitsBilling === false || !r.json?.limits?.standard) {
    const cents = num(r.json?.extraUsageBalanceCents);
    return remember("droid", { plan: null, windows: [], ...(cents ? { balanceUsd: cents / 100 } : {}), at: Date.now(), why: "This Droid plan has no five-hour or weekly limits." });
  }
  return remember("droid", droidFrom(r.json));
}

// ── Amp ─────────────────────────────────────────────────────────────

/** Amp's balance line (the text `amp usage` prints) as a plan, windows and credits. */
export function ampFrom(line: string): ToolAllowance {
  const windows: LimitWindow[] = [];
  const days = /resets upon renewal in (\d+) days?/i.exec(line);
  const reset = days ? Math.round(Date.now() / 1000) + Number(days[1]) * 86_400 : null;
  const agent = /agent usage \$([\d.,]+) of \$([\d.,]+) remaining/i.exec(line);
  if (agent) windows.push(window("agent", "Agent credits", pct(Number(agent[2]!.replace(/,/g, "")) - Number(agent[1]!.replace(/,/g, "")), Number(agent[2]!.replace(/,/g, ""))), reset));
  const free = /Amp Free:\s*\$([\d.,]+)\s*\/\s*\$([\d.,]+) remaining/i.exec(line);
  if (free) windows.push(window("free", "Free credits", pct(Number(free[2]!) - Number(free[1]!), Number(free[2]!)), null));
  const credits = /Individual credits:\s*\$([\d.,]+) remaining/i.exec(line);
  const tier = /\bAmp ([A-Z][\w]*) Tier\b/.exec(line)?.[1] ?? (free ? "Free" : null);
  return { plan: tier, windows, ...(credits ? { balanceUsd: Number(credits[1]!.replace(/,/g, "")) } : {}), at: Date.now() };
}

async function readAmp(): Promise<ToolAllowance | null> {
  const secrets = await readJson(path.join(home(), ".local", "share", "amp", "secrets.json"));
  const key = process.env.AMP_API_KEY || (typeof secrets?.["apiKey@https://ampcode.com/"] === "string" ? secrets["apiKey@https://ampcode.com/"] : "");
  if (!secrets && !process.env.AMP_API_KEY) return null;
  if (!key) return kept("amp", "Sign in to Amp (amp login) to see this here.");
  const r = await ask("https://ampcode.com/api/internal?userDisplayBalanceInfo", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ method: "userDisplayBalanceInfo", params: {} }),
  });
  const line = r.json?.result?.displayText;
  if (r.status === 401 || r.json?.error?.code === "auth-required") return kept("amp", lapsed("Amp"));
  if (r.status !== 200 || typeof line !== "string") return kept("amp", "Amp's balance didn't answer just now.");
  return remember("amp", ampFrom(line));
}

// ── Antigravity ─────────────────────────────────────────────────────

/** Its windows by the name its buckets give them, in minutes. */
const AGY_WINDOWS: Record<string, [string, number]> = { "5h": ["5h", 300], daily: ["Daily", 1440], weekly: ["Weekly", 10080], monthly: ["Monthly", 43200] };

/**
 * Antigravity's quota, from either of the two answers that carry it: Google's `retrieveUserQuotaSummary` (camelCase:
 * `groups[].displayName`, `buckets[].bucketId`, `remainingFraction`, `resetTime`), or `agy -p /usage --output-format json`, which
 * wraps the same in `command.data` (snake_case: `groups[].name`, `buckets[].id`, `remaining_fraction`, `reset_time`). Its models
 * come in groups ("Gemini Models", "Claude and GPT models"), each with a five-hour and a weekly bucket; each bucket is a window of
 * its own, named with its group, so one group's five hours aren't taken for another's (issue #30). A disabled bucket is left out,
 * and a bucket nothing has touched keeps no reset: it reports a rolling one, a full window from whenever it is asked (as T3 Code
 * reads it).
 */
export function antigravityFrom(j: Record<string, any> | null, askedAt = Date.now()): ToolAllowance | null {
  const data = j?.command?.data ?? j?.data ?? j;
  const groups: any[] = Array.isArray(data?.groups) && data.groups.some((g: any) => Array.isArray(g?.buckets)) ? data.groups : Array.isArray(data?.buckets) ? [{ buckets: data.buckets }] : [];
  if (!groups.length) return null;
  const windows: LimitWindow[] = [];
  for (const g of groups) {
    const group = String(g?.displayName ?? g?.display_name ?? g?.name ?? "").replace(/\s+models?$/i, "").trim();
    for (const b of Array.isArray(g?.buckets) ? g.buckets : []) {
      const left = num(b?.remainingFraction ?? b?.remaining_fraction);
      if (left === null || b?.disabled === true) continue;
      const name = String(b?.window ?? "").toLowerCase();
      const hours = /^(\d+)\s*h$/.exec(name);
      const [label, minutes] = AGY_WINDOWS[name] ?? (hours ? [`${hours[1]}h`, Number(hours[1]) * 60] : [String(b?.displayName ?? b?.name ?? b?.window ?? "Limit"), null]);
      const id = String(b?.bucketId ?? b?.id ?? "") || `${group}-${name}`;
      let reset = secs(b?.resetTime ?? b?.reset_time);
      if (left >= 1 && minutes && reset !== null && b?.description === undefined && Math.abs(reset * 1000 - askedAt - minutes * 60_000) <= 60_000) reset = null;
      windows.push(window(id, group ? `${label} · ${group}` : label, Math.max(0, Math.min(100, (1 - left) * 100)), reset, minutes));
    }
  }
  if (!windows.length) return null;
  const plan = [data.plan, data.tier, data.tier_name, data.tierDisplayName].find((v) => typeof v === "string" && v.trim());
  return { plan: plan ?? null, windows, at: Date.now() };
}

/**
 * Antigravity's quota from Google's `fetchAvailableModels`, for an account `retrieveUserQuotaSummary` refuses (a free one says
 * SUBSCRIPTION_REQUIRED): each model's `quotaInfo`, grouped as agy's own /usage groups them (Gemini, and Claude and GPT sharing
 * one), the most used model standing for its group, as T3 Code reads it. The answer names no window, so its reset says which:
 * more than six hours off is the week. A model nothing has touched keeps no reset (it reports a full window from now), and a
 * five-hour window nothing has touched is left out, as agy leaves it out.
 */
export function antigravityModelsFrom(j: Record<string, any> | null, askedAt = Date.now()): ToolAllowance | null {
  const models = j?.models;
  if (!models || typeof models !== "object") return null;
  const best = new Map<string, LimitWindow>();
  for (const [id, m] of Object.entries<any>(models)) {
    const provider = String(m?.modelProvider ?? "");
    const family = provider === "MODEL_PROVIDER_GOOGLE" || id.startsWith("gemini-") ? "gemini" : /ANTHROPIC|OPENAI/.test(provider) || /^(claude|gpt)-/.test(id) ? "3p" : null;
    const left = num(m?.quotaInfo?.remainingFraction);
    const at = secs(m?.quotaInfo?.resetTime);
    if (!family || left === null || at === null) continue;
    const weekly = at * 1000 - askedAt > 6 * 3_600_000;
    if (!weekly && left >= 1) continue;
    const kind = `${family}-${weekly ? "weekly" : "5h"}`;
    const w = window(kind, `${weekly ? "Weekly" : "5h"} · ${family === "gemini" ? "Gemini" : "Claude and GPT"}`, Math.max(0, Math.min(100, (1 - left) * 100)), left >= 1 ? null : at, weekly ? 10080 : 300);
    const had = best.get(kind);
    if (!had || (w.usedPercent ?? 0) > (had.usedPercent ?? 0)) best.set(kind, w);
  }
  if (!best.size) return null;
  return { plan: null, windows: [...best.values()], at: Date.now() };
}

/** agy's own sign-in, as it keeps it: `{ auth_method, token: { access_token, refresh_token, expiry }, project_id, tier_display_name }`. */
interface AgyLogin {
  authMethod: string;
  accessToken: string;
  expiresAt: number | null;
  projectId: string | null;
  tier: string | null;
}

export function agyLoginFrom(contents: string): AgyLogin | null {
  let text = contents.trim();
  // go-keyring's encodings, on a Mac and on Linux.
  if (text.startsWith("go-keyring-base64:")) text = Buffer.from(text.slice(18), "base64").toString("utf8");
  else if (text.startsWith("go-keyring-encoded:")) text = Buffer.from(text.slice(19), "hex").toString("utf8");
  try {
    const v = JSON.parse(text);
    const t = v && typeof v === "object" ? (v.token && typeof v.token === "object" ? v.token : v) : null;
    if (typeof t?.access_token !== "string" || !t.access_token) return null;
    const exp = typeof t.expiry === "string" ? Date.parse(t.expiry) : num(t.expiry_date ?? t.expiry);
    const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : null);
    return { authMethod: str(v.auth_method) ?? "", accessToken: t.access_token, expiresAt: exp && Number.isFinite(exp) ? (exp > 1e11 ? exp : exp * 1000) : null, projectId: str(v.project_id), tier: str(v.tier_display_name) };
  } catch {
    return null;
  }
}

const geminiHome = () => process.env.GEMINI_HOME || path.join(home(), ".gemini");

/**
 * Where agy keeps its sign-in: a file where it has no keyring (SSH, WSL, Linux without a session bus), else the macOS keychain
 * (service "gemini", account "antigravity", read through /usr/bin/security as agy's keyring library writes it, so macOS asks for
 * nothing) or the Secret Service on Linux. Windows keeps it in the Credential Manager in a form only agy reads: there, agy itself is
 * asked. Read only, never written.
 */
async function agyLogin(): Promise<AgyLogin | null> {
  const file = await readFile(path.join(geminiHome(), "antigravity-cli", "antigravity-oauth-token"), "utf8").catch(() => null);
  if (file && agyLoginFrom(file)) return agyLoginFrom(file);
  if (mac) {
    const r = await execCli("/usr/bin/security", ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"], { timeoutMs: 3000 }).catch(() => null);
    return r?.code === 0 ? agyLoginFrom(r.stdout) : null;
  }
  if (process.platform === "linux") {
    const r = await execCli("secret-tool", ["lookup", "service", "gemini", "username", "antigravity"], { timeoutMs: 3000 }).catch(() => null);
    return r?.code === 0 ? agyLoginFrom(r.stdout) : null;
  }
  return null;
}

/** What agy calls itself to Google, which meters a consumer account on the daily host and a business one on prod (T3 Code). */
const AGY_AGENT = `antigravity/hub/2.24.0 (aidev_client; os_type=${process.platform}; arch=${process.arch}; cl=963137146)`;
const AGY_HOSTS = ["https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"];

/**
 * Asked of Google directly, with agy's own sign-in, the way agy asks: both hosts at once, a bucket from the host that meters this
 * account winning. Instant, and the same whatever version of agy is installed. Null when it can't say (then agy is asked).
 */
async function askAntigravity(login: AgyLogin): Promise<{ status: number; allowance: ToolAllowance | null }> {
  const hosts = login.authMethod === "oauth-business" ? [...AGY_HOSTS].reverse() : AGY_HOSTS;
  // A sign-in with no project (a consumer one keeps none) asks for the account's, as Synara does: without it Google reports every
  // model unused. The same answer names the plan.
  const account = login.projectId && login.tier ? null : await agyAccount(login, hosts[0]!);
  const project = login.projectId ?? account?.project ?? null;
  const plan = login.tier ?? account?.plan ?? null;
  const each = (op: string) => {
    const askedAt = Date.now();
    return Promise.all(
      hosts.map((h) =>
        ask(`${h}/v1internal:${op}`, {
          method: "POST",
          redirect: "manual",
          headers: { Authorization: `Bearer ${login.accessToken}`, "Content-Type": "application/json", "User-Agent": AGY_AGENT },
          body: JSON.stringify(project ? { project } : {}),
        })
          .then((a) => ({ ...a, askedAt }))
          .catch(() => ({ status: 0, json: null, askedAt })),
      ),
    );
  };
  const seen = new Set<string>();
  const windows: LimitWindow[] = [];
  let answers = await each("retrieveUserQuotaSummary");
  for (const a of answers) {
    for (const w of (a.status === 200 ? antigravityFrom(a.json, a.askedAt)?.windows : null) ?? []) {
      if (!seen.has(w.kind)) seen.add(w.kind), windows.push(w);
    }
  }
  // An account with no summary (a free one): each model's quota instead, the more used of the two hosts' readings winning.
  if (!windows.length && !answers.some((a) => a.status === 401)) {
    answers = await each("fetchAvailableModels");
    const best = new Map<string, LimitWindow>();
    for (const a of answers) {
      for (const w of (a.status === 200 ? antigravityModelsFrom(a.json, a.askedAt)?.windows : null) ?? []) {
        if ((w.usedPercent ?? 0) >= (best.get(w.kind)?.usedPercent ?? -1)) best.set(w.kind, w);
      }
    }
    windows.push(...best.values());
  }
  const status = windows.length ? 200 : (answers.find((a) => a.status === 401 || a.status === 403)?.status ?? answers[0]?.status ?? 0);
  return { status, allowance: windows.length ? { plan, windows, at: Date.now() } : null };
}

/** The account's project and plan, from `loadCodeAssist`, asked once per sign-in (a token lasts an hour). */
const agyAccounts = new Map<string, Promise<{ project: string | null; plan: string | null } | null>>();
function agyAccount(login: AgyLogin, host: string): Promise<{ project: string | null; plan: string | null } | null> {
  let p = agyAccounts.get(login.accessToken);
  if (!p) {
    agyAccounts.clear();
    p = ask(`${host}/v1internal:loadCodeAssist`, {
      method: "POST",
      redirect: "manual",
      headers: { Authorization: `Bearer ${login.accessToken}`, "Content-Type": "application/json", "User-Agent": AGY_AGENT },
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } }),
    })
      .then(({ status, json: j }) => {
        if (status !== 200 || !j) return null;
        const project = j.cloudaicompanionProject?.id ?? j.cloudaicompanionProject;
        const plan = [j.paidTier?.name, j.currentTier?.name].find((v) => typeof v === "string" && v.trim());
        return { project: typeof project === "string" && project ? project : null, plan: plan ?? null };
      })
      .catch(() => null);
    // A failed ask is asked again next time.
    void p.then((a) => a || agyAccounts.delete(login.accessToken));
    agyAccounts.set(login.accessToken, p);
  }
  return p;
}

/** The first JSON object in what a CLI printed that `from` makes sense of, whether it printed one object or a line of each. */
function jsonOut<T>(out: string, from: (j: any) => T | null): T | null {
  const tries = [out, ...out.split(/\r?\n/)];
  for (const t of tries) {
    const start = t.indexOf("{");
    if (start < 0) continue;
    try {
      const r = from(JSON.parse(t.slice(start)));
      if (r) return r;
    } catch {
      /* the next */
    }
  }
  return null;
}

/** Each agy's version, asked once: one older than 1.1.11 spends a model turn on /usage (Orca). */
const agyVersions = new Map<string, Promise<number[] | null>>();
/** Set once an agy answered /usage with a model turn: never asked that way again while Friday runs. */
let agyTurns = false;
/** agy is started at most every fifteen minutes: each start unpacks about a gigabyte. */
let agyRanAt = 0;
const AGY_EVERY_MS = 15 * 60_000;

/**
 * `agy -p /usage --output-format json`, hardened as Orca runs it: for when Google can't be asked directly (Windows, or a sign-in
 * agy hasn't renewed lately; running agy renews it, so the next look asks Google again). Its updater off, its log sent nowhere,
 * its own print timeout under ours; an `AGY_ERROR:` line says why it couldn't.
 */
async function runAgyUsage(bin: string): Promise<ToolAllowance | null> {
  if (agyTurns) return kept("antigravity", "This Antigravity CLI can't report its usage without a model turn: update agy.");
  if (Date.now() - agyRanAt < AGY_EVERY_MS) return (await keptAll()).antigravity ? kept("antigravity", "Antigravity's usage renews the next time it runs.") : null;
  const how = await launcher(bin).catch(() => null);
  if (!how) return kept("antigravity", "Antigravity's usage didn't answer just now.");
  const env = toolEnv("antigravity", { ...childEnv(), ...how.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" });
  if (!agyVersions.has(bin)) {
    agyVersions.set(
      bin,
      execCli(how.command, [...how.prefix, "--version"], { env, timeoutMs: 5000 })
        .then((r) => /(\d+)\.(\d+)\.(\d+)/.exec(`${r.stdout} ${r.stderr}`)?.slice(1).map(Number) ?? null)
        .catch(() => null),
    );
  }
  const v = await agyVersions.get(bin)!;
  if (v && (v[0]! * 1e6 + v[1]! * 1e3 + v[2]!) < 1_001_011) return kept("antigravity", "This Antigravity CLI doesn't report its usage: update agy (1.1.11 and later do).");
  agyRanAt = Date.now();
  const r = await execCli(how.command, [...how.prefix, "--log-file", devNull, "-p", "/usage", "--output-format", "json", "--print-timeout", "20s"], { env, timeoutMs: 30_000 });
  // A run that says nothing usable (signed out, or mid sign-in) may run again in two minutes, not fifteen: a reading follows the
  // sign-in without a restart.
  agyRanAt = Date.now() - AGY_EVERY_MS + 2 * 60_000;
  const all =`${r.stdout}\n${r.stderr}`;
  const err = jsonOut(all.split(/\r?\n/).filter((l) => l.startsWith("AGY_ERROR:")).map((l) => l.slice(9)).join("\n"), (j) => (j && typeof j === "object" ? j : null)) as Record<string, any> | null;
  const code = String(err?.status ?? err?.error_code ?? "");
  if (/UNAUTHENTICATED|401/.test(code) || /Authentication required|please sign in|not (?:logged|signed) in/i.test(all)) return kept("antigravity", "Sign in to Antigravity (run agy) to see this here.");
  if (/PERMISSION_DENIED|403/.test(code)) return kept("antigravity", "This Google account has no Antigravity plan.");
  if (/RESOURCE_EXHAUSTED|429/.test(code)) return kept("antigravity", "Antigravity's usage is rate limited right now.");
  const a = jsonOut(r.stdout, (j) => (j?.status && j.status !== "SUCCESS" ? null : antigravityFrom(j)));
  if (a) return (agyRanAt = Date.now()), remember("antigravity", a);
  if (jsonOut(r.stdout, (j) => ((num(j?.num_turns) ?? 0) > 0 || j?.conversation_id ? true : null))) {
    agyTurns = true;
    return kept("antigravity", "This Antigravity CLI can't report its usage without a model turn: update agy.");
  }
  if (r.code === -1) return kept("antigravity", "Antigravity's usage didn't answer just now.");
  return kept("antigravity", "This Antigravity CLI doesn't report its usage: update agy (1.1.11 and later do).");
}

/**
 * Antigravity's limits. Google is asked directly with agy's own sign-in (as T3 Code and Synara do): no agy started, nothing
 * written, and the same answer whatever agy's version. Where that sign-in can't be read, or has lapsed since agy last ran, agy
 * itself is asked (as Orca does), at most every fifteen minutes, which also renews the sign-in for the next look.
 */
async function readAntigravity(): Promise<ToolAllowance | null> {
  const bin = await findBin("antigravity");
  const login = await agyLogin();
  if (!bin && !login) return null;
  if (login && (login.expiresAt === null || login.expiresAt > Date.now() + 60_000)) {
    const r = await askAntigravity(login);
    if (r.allowance) return remember("antigravity", r.allowance);
    if (r.status === 403 && !bin) return kept("antigravity", "This Google account has no Antigravity plan.");
  }
  if (!bin) return kept("antigravity", lapsed("Antigravity"));
  // Only once it is known to be signed in (the answer Friday keeps from `agy models`): asked signed out, it could start signing in.
  if (!login && (await loginStatusCached("antigravity", bin).catch(() => null)) === false) return kept("antigravity", "Sign in to Antigravity (run agy) to see this here.");
  return runAgyUsage(bin);
}

// ── all of them ─────────────────────────────────────────────────────

const READERS: Partial<Record<EngineTool, () => Promise<ToolAllowance | null>>> = {
  kiro: readKiro,
  devin: readDevin,
  cline: readCline,
  kilo: readKilo,
  opencode: readOpenCode,
  gemini: readGemini,
  grok: readGrok,
  droid: readDroid,
  amp: readAmp,
  antigravity: readAntigravity,
};

/** The tools asked by starting them: never started for a lane that is starting a tool itself (limits.ts `askClaude: false`). */
const STARTED: ReadonlySet<EngineTool> = new Set<EngineTool>(["antigravity"]);

/**
 * Each tool asked at most every five minutes when it answered (the numbers only move while it runs, and nobody's server needs
 * asking more), and again after a minute when it didn't, so a passing failure doesn't stand for five.
 */
const asked = new Map<EngineTool, { at: number; read: Promise<ToolAllowance | null>; done: boolean; again: number }>();
const ANSWERED_MS = 5 * 60_000;
const FAILED_MS = 60_000;

/**
 * A reading as it stands now: a window whose reset has passed has started over since, so it shows empty with no reset rather than
 * as full as it last was (as Droid and Orca show one).
 */
export function asOfNow(a: ToolAllowance, now = Date.now()): ToolAllowance {
  if (!a.windows.some((w) => w.resetsAt !== null && w.resetsAt * 1000 <= now)) return a;
  return { ...a, windows: a.windows.map((w) => (w.resetsAt !== null && w.resetsAt * 1000 <= now ? { ...w, usedPercent: 0, resetsAt: null } : w)) };
}

/**
 * How long one tool is waited on before its last reading stands in, its own read carrying on for the next look. Antigravity is
 * asked by starting it, which takes seconds, and the others' answers don't wait for that.
 */
const TOOL_BUDGET_MS = 2000;

/** The tools being read that had no answer in time: worth asking again in a few seconds (toolLimits.ts). */
export const stillReading = (): EngineTool[] => [...asked].filter(([, a]) => !a.done).map(([t]) => t);

/**
 * The other tools' limits, for those signed in on this machine. A tool that isn't there is left out. `start`: false to read a
 * tool that must be started (Antigravity) as last read, without starting it.
 */
export async function readOtherTools(opts: { budgetMs?: number; start?: boolean } = {}): Promise<Partial<Record<EngineTool, ToolAllowance>>> {
  const budgetMs = opts.budgetMs ?? TOOL_BUDGET_MS;
  const entries = await Promise.all(
    (Object.entries(READERS) as [EngineTool, () => Promise<ToolAllowance | null>][]).map(async ([tool, read]) => {
      const had = asked.get(tool);
      if (opts.start === false && STARTED.has(tool)) return [tool, had?.done ? await had.read : ((await keptAll())[tool] ?? null)] as const;
      if (!had || Date.now() - had.at > (had.done ? had.again : 2 * ANSWERED_MS)) {
        const entry = { at: Date.now(), done: false, again: ANSWERED_MS, read: read().catch(() => kept(tool, "Its usage didn't answer just now.")) };
        void entry.read.then((a) => {
          entry.done = true;
          // Not there (not installed or signed in yet) is asked again in a minute too: one installed or signed in while Friday
          // runs shows without a restart. Looking costs a file read or two.
          if (!a || a.stale || (a.why && !a.windows.length && a.balanceUsd === undefined)) entry.again = FAILED_MS;
        });
        asked.set(tool, entry);
      }
      const late = Symbol("late");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const r = await Promise.race([asked.get(tool)!.read, new Promise<typeof late>((res) => (timer = setTimeout(() => res(late), budgetMs)))]);
      clearTimeout(timer);
      return [tool, r === late ? ((await keptAll())[tool] ?? null) : r] as const;
    }),
  );
  return Object.fromEntries(entries.filter(([, a]) => a).map(([t, a]) => [t, asOfNow(a!)])) as Partial<Record<EngineTool, ToolAllowance>>;
}
