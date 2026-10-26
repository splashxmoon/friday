import { createDecipheriv } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { EngineTool } from "../types.js";
import type { LimitWindow } from "./limits.js";

/**
 * What the other coding tools say about their own limits, read on this machine (Claude Code, Codex, Cursor and Copilot are in
 * limits.ts).
 *
 * Each is asked the way the tool asks itself, worked out from what it sends: its own sign-in, read where the tool keeps it, sent
 * to the tool's own server and nowhere else, never refreshed. A sign-in that has lapsed is the tool's to renew the next time it
 * runs, and doing it here could sign the tool out; meanwhile the last reading is shown with its age. That is rarely old for long:
 * a tool only spends its limits while it runs, and running is what renews its sign-in.
 *
 * Kiro, Devin, Cline and Kilo were checked against real accounts (October 2026). Gemini CLI and Grok Build are read as their own
 * open source does; Factory Droid and Amp as the open-source usage trackers do. JetBrains Junie keeps its sign-in in the system
 * keychain under names nobody has documented, and OpenCode's free models report nothing: both say so instead.
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

const devinCredentials = () => [path.join(roaming(), "devin", "credentials.toml"), path.join(home(), ".config", "devin", "credentials.toml"), path.join(home(), "Library", "Application Support", "devin", "credentials.toml")];
/** What the CLI calls itself to its server. */
const DEVIN_CLIENT = { ideName: "chisel", ideVersion: "3000.11.3", extensionName: "chisel", extensionVersion: "3000.11.3", locale: "en" };

/** Devin's GetUserStatus answer: today's and this week's share of the quota, extra usage, ACUs, and the plan. */
export function devinFrom(j: Record<string, any> | null): ToolAllowance {
  const s = j?.userStatus?.planStatus ?? {};
  const windows: LimitWindow[] = [];
  // Zero values are left out of the answer: a reset time without a percentage left means none is.
  const left = (v: unknown) => num(v) ?? 0;
  if (!s.hideDailyQuota && s.dailyQuotaResetAtUnix) windows.push(window("daily", "Daily", 100 - left(s.dailyQuotaRemainingPercent), secs(s.dailyQuotaResetAtUnix), 1440));
  if (!s.hideWeeklyQuota && s.weeklyQuotaResetAtUnix) windows.push(window("weekly", "Weekly", 100 - left(s.weeklyQuotaRemainingPercent), secs(s.weeklyQuotaResetAtUnix), 10080));
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
  let creds: Record<string, string> | null = null;
  for (const f of devinCredentials()) {
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

/** OpenCode's free models report no limits, and its paid ones only in its console: said, not guessed at. */
async function readOpenCode(): Promise<ToolAllowance | null> {
  const dir = path.join(home(), ".local", "share", "opencode");
  if (!(await exists(dir))) return null;
  const auth = await readJson(path.join(dir, "auth.json"));
  const keyed = !!process.env.OPENCODE_API_KEY || (auth && typeof auth === "object" && Object.keys(auth).length > 0);
  return { plan: keyed ? null : "Free models", windows: [], at: Date.now(), why: keyed ? "OpenCode shows its usage only in its console." : "OpenCode doesn't report its free models' limits." };
}

// ── Gemini CLI ──────────────────────────────────────────────────────

/** Gemini CLI's quota buckets: how much of each model's allowance is used, and when it resets. */
export function geminiFrom(quota: Record<string, any> | null, account: Record<string, any> | null): ToolAllowance {
  const buckets: any[] = Array.isArray(quota?.buckets) ? quota!.buckets : [];
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

/** Grok's billing answer: the share of this week's (or month's) credits used, and prepaid credits left. */
export function grokFrom(j: Record<string, any> | null): ToolAllowance {
  const c = j?.config ?? {};
  const type = String(c.currentPeriod?.type ?? "");
  const weekly = /WEEK/.test(type);
  const used = num(c.creditUsagePercent);
  const windows = used === null ? [] : [window("period", weekly ? "Weekly" : /MONTH/.test(type) ? "Monthly" : "This period", Math.floor(used), secs(c.currentPeriod?.end), weekly ? 10080 : null)];
  const prepaid = num(c.prepaidBalance?.val);
  return { plan: null, windows, ...(prepaid ? { balanceUsd: prepaid / 100 } : {}), at: Date.now() };
}

async function readGrok(): Promise<ToolAllowance | null> {
  const all = await readJson(path.join(process.env.GROK_HOME || path.join(home(), ".grok"), "auth.json"));
  if (!all || typeof all !== "object") return null;
  const entry = Object.entries(all as Record<string, any>).find(([scope, a]) => /auth\.x\.ai/.test(scope) || /auth\.x\.ai/.test(String(a?.oidc_issuer ?? "")))?.[1];
  if (!entry?.key) return { plan: null, windows: [], at: Date.now(), why: "Grok Build's usage needs a grok.com sign-in (grok login)." };
  const expires = entry.expires_at ? Date.parse(entry.expires_at) : Date.parse(String(entry.create_time ?? "")) + 30 * 86_400_000;
  if (!(expires - 300_000 > Date.now())) return kept("grok", lapsed("Grok Build"));
  const r = await ask("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
    headers: { Authorization: `Bearer ${entry.key}`, "X-XAI-Token-Auth": "xai-grok-cli", ...(entry.user_id ? { "x-userid": String(entry.user_id) } : {}) },
  });
  if (r.status === 401 || r.status === 403) return kept("grok", lapsed("Grok Build"));
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

/** Droid's sign-in: AES-GCM sealed beside its key (auth.v2), or the older plain file. */
async function droidToken(): Promise<string | null> {
  const dir = path.join(home(), ".factory");
  try {
    const key = Buffer.from((await readFile(path.join(dir, "auth.v2.key"), "utf8")).trim(), "base64");
    const [iv, tag, sealed] = (await readFile(path.join(dir, "auth.v2.file"), "utf8")).trim().split(":").map((p) => Buffer.from(p, "base64"));
    const d = createDecipheriv("aes-256-gcm", key, iv!);
    d.setAuthTag(tag!);
    const j = JSON.parse(Buffer.concat([d.update(sealed!), d.final()]).toString("utf8"));
    if (typeof j?.access_token === "string") return j.access_token;
  } catch {
    /* the older file, then */
  }
  const old = await readJson(path.join(dir, "auth.json"));
  return typeof old?.access_token === "string" ? old.access_token : null;
}

async function readDroid(): Promise<ToolAllowance | null> {
  if (!(await exists(path.join(home(), ".factory")))) return null;
  const token = await droidToken();
  if (!token) return kept("droid", "Sign in to Droid to see this here.");
  const exp = jwtExpiry(token);
  if (exp !== null && exp < Date.now() + 60_000) return kept("droid", lapsed("Droid"));
  const r = await ask("https://api.factory.ai/api/billing/limits", { headers: { Authorization: `Bearer ${token}`, "X-Factory-Client": "cli" } });
  if (r.status === 401) return kept("droid", lapsed("Droid"));
  if (r.status !== 200) return kept("droid", "Droid's limits didn't answer just now.");
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
};

/** Each tool asked at most every five minutes: the numbers only move while it runs, and nobody's server needs asking more. */
const asked = new Map<EngineTool, { at: number; read: Promise<ToolAllowance | null> }>();

/** The other tools' limits, for those signed in on this machine. A tool that isn't there is left out. */
export async function readOtherTools(): Promise<Partial<Record<EngineTool, ToolAllowance>>> {
  const entries = await Promise.all(
    (Object.entries(READERS) as [EngineTool, () => Promise<ToolAllowance | null>][]).map(async ([tool, read]) => {
      const had = asked.get(tool);
      if (!had || Date.now() - had.at > 5 * 60_000) asked.set(tool, { at: Date.now(), read: read().catch(() => kept(tool, "Its usage didn't answer just now.")) });
      return [tool, await asked.get(tool)!.read] as const;
    }),
  );
  return Object.fromEntries(entries.filter(([, a]) => a)) as Partial<Record<EngineTool, ToolAllowance>>;
}
