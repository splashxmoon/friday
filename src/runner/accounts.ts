import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { EngineTool } from "../types.js";

/**
 * More than one account for a coding tool on one computer (Arun, 2026-10-24: "add support for multiple account support for the
 * coding tools"): two Claude Code logins, work and personal, or two Codex/ChatGPT accounts.
 *
 * Each tool is run as one of them by pointing it at a folder of its own, which is where it keeps its sign-in:
 * - Claude Code, CLAUDE_CONFIG_DIR: on a Mac its keychain item is then "Claude Code-credentials-" and the first 8 hex of the
 *   folder's SHA-256 (read from 2.1.307 itself), so two sign-ins sit side by side and neither signs the other out;
 * - Codex, CODEX_HOME: its auth.json is in there.
 * The tool's own folder (~/.claude, ~/.codex, or whatever the person set) is always the account "default". Each one added gets
 * ~/.friday/accounts/<tool>/<id>, linked back to the default folder for everything that isn't the sign-in or the tool's runtime
 * state: settings, skills, plugins, hooks and, above all, the conversations, so one account carries on a conversation another
 * started (SHARED). Claude Code's `.claude.json` (MCP servers, trusted folders) is merged in, less the sign-in's fields
 * (mergeClaudeState). Done as T3 Code and Orca do it: never HOME, which would hide the keychain sign-in.
 *
 * The other tools keep their sign-in where no setting moves it (Cursor's keychain item has one fixed name), or move their whole
 * history with it: they have one account each, as before.
 */

export const ACCOUNT_TOOLS = ["claude", "codex"] as const;
export type AccountTool = (typeof ACCOUNT_TOOLS)[number];
export const hasAccounts = (tool: EngineTool | undefined): tool is AccountTool => !!tool && (ACCOUNT_TOOLS as readonly string[]).includes(tool);

export const DEFAULT_ACCOUNT = "default";

export interface ToolAccount {
  id: string;
  label: string;
  /** Out of usage until then (ms), as its last run said; null when it didn't say when, from `outAt`. */
  outUntil?: number | null;
  /** When it last ran out. */
  outAt?: number;
}

type Store = Partial<Record<AccountTool, ToolAccount[]>>;

const stateDir = () => process.env.FRIDAY_STATE_DIR || path.join(homedir(), ".friday");
const storeFile = () => path.join(stateDir(), "accounts.json");
export const accountsRoot = () => path.join(stateDir(), "accounts");

/** The tool's own folder: the default account's. */
export function toolHome(tool: AccountTool): string {
  if (tool === "claude") return process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
  return process.env.CODEX_HOME || path.join(homedir(), ".codex");
}

/** An added account's folder. */
export const accountDir = (tool: AccountTool, id: string) => path.join(accountsRoot(), tool, id);

/** What a process of `tool` is started with to run as `account`. Nothing for the default account, or a tool with one. */
export function accountEnv(tool: EngineTool | undefined, account: string | null | undefined): Record<string, string> {
  if (!hasAccounts(tool) || !account || account === DEFAULT_ACCOUNT) return {};
  const dir = accountDir(tool, account);
  return tool === "claude" ? { CLAUDE_CONFIG_DIR: dir } : { CODEX_HOME: dir };
}

/**
 * What an added account's folder shares with the default one's, the way Orca shares a Claude profile (2026-11-05 review of its
 * code): everything at the top of the default folder but the tool's runtime state and the sign-in, linked, so a skill, plugin,
 * agent, hook or key binding set up once is there for every account. Both tools write through a linked file and keep the link
 * (checked against Claude Code 2.1.318 `plugin install` on settings.json, Codex 0.166 `mcp add` on config.toml).
 * - `always`: made in the default folder when missing, then linked: the conversations above all (and for Claude Code what a
 *   resumed conversation reads besides: its checkpoints, plans, pasted text and images, task lists), so one account carries
 *   on a conversation another started (`--resume`, and Codex's `thread/resume`, which finds a thread by its file when its
 *   database hasn't heard of it: checked through a linked sessions folder on 0.166).
 * - `private`: never shared, Claude Code's from the list Claude itself leaves out when it copies a config folder: sign-ins,
 *   caches, logs, its daemon's state and live sessions, prompt history.
 * - Codex: only what Orca shares too (its home holds databases and locks keyed to the account).
 */
const SHARED: Record<AccountTool, { always: string[]; extra: string[] | "rest"; private: Set<string> }> = {
  claude: {
    always: ["projects", "file-history", "plans", "paste-cache", "todos", "tasks", "shell-snapshots", "session-env", "transcripts", "agents", "skills", "commands", "plugins", "output-styles"],
    extra: "rest",
    private: new Set([
      ".claude.json", ".claude.json.backup", ".credentials.json", ".session_ingress_token", "active-time.json", "antproto.json", "api-dumps", "backups",
      "bridge-spawn", "cache", "ccr", "ccr-home-seed.json", "chrome", "computer-use.lock", "daemon", "debug", "downloads", "dump-prompts", "feedback",
      "feedback-bundles", "file-transfers", "gh-pr-status-cache.json", "hfi-auth.json", "history.jsonl", "ide", "image-cache", "jobs", "local",
      "local-settings", "logs", "loop.md", "mcp-discovery-cache", "mcp-needs-auth-cache.json", "mcp-skill-archives", "policy-limits.json",
      "project-settings", "remote", "remote-control", "remote-settings.json", "scratch", "seed-admin", "server-sessions.json", "server.lock", "sessions",
      "shares", "startup-perf", "state", "stats-cache.json", "statsig", "storage-v2", "systemd", "teams", "telemetry", "traces", "uploads", "usage-data",
    ]),
  },
  codex: {
    always: ["sessions", "archived_sessions", "skills", "prompts", "plugins"],
    extra: ["config.toml", "AGENTS.md", "hooks", "hooks.json", "plugin-state", "profile-v2", "themes", path.join(".tmp", "bundled-marketplaces")],
    private: new Set(),
  },
};

/** Claude Code's own leaving-out, by name, beside the list: hidden files, its daemon's, per-folder agent memory, its own sidecars. */
const claudeKeeps = (name: string) =>
  name.startsWith(".") || name.startsWith("daemon") || name.startsWith("agent-memory") || /\.(signature|signature-iat|stamp)\.json$|\.synced-at$|\.lock$|\.tmp/.test(name);

/** What of the default folder an added account links to: the names, each a folder or a file there. */
async function sharedNames(tool: AccountTool, home: string): Promise<string[]> {
  const spec = SHARED[tool];
  if (spec.extra !== "rest") return [...spec.always, ...spec.extra];
  const there = await readdir(home).catch(() => [] as string[]);
  return [...new Set([...spec.always, ...there.filter((n) => !spec.private.has(n) && !claudeKeeps(n))])];
}

async function readStore(): Promise<Store> {
  try {
    const j = JSON.parse(await readFile(storeFile(), "utf8")) as Store;
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}
async function writeStore(s: Store): Promise<void> {
  await mkdir(stateDir(), { recursive: true });
  await writeFile(storeFile(), JSON.stringify(s, null, 2));
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const slug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "account";

/** Every account of `tool`, the default first. The default's label is the one given it, else "Main". */
export async function listAccounts(tool: AccountTool): Promise<ToolAccount[]> {
  const kept = (await readStore())[tool] ?? [];
  const def = kept.find((a) => a.id === DEFAULT_ACCOUNT) ?? { id: DEFAULT_ACCOUNT, label: "Main" };
  return [def, ...kept.filter((a) => a.id !== DEFAULT_ACCOUNT && ID.test(a.id))];
}

/** One account, or null when there's no such one. */
export async function getAccount(tool: AccountTool, id: string): Promise<ToolAccount | null> {
  return (await listAccounts(tool)).find((a) => a.id === id) ?? null;
}

async function exists(p: string): Promise<boolean> {
  return lstat(p).then(
    () => true,
    () => false,
  );
}

/**
 * Its folder, linked back to the default one's for what is shared (above), and for Claude Code its `.claude.json` brought up to
 * date (claudeState). Made again where a link has gone, every time a lane opens on it (safe to run twice). Anything the account
 * already has of its own where a link would go is left as it is.
 */
export async function prepareAccountDir(tool: AccountTool, id: string): Promise<string> {
  const dir = accountDir(tool, id);
  const home = toolHome(tool);
  await mkdir(dir, { recursive: true });
  const always = new Set(SHARED[tool].always);
  for (const name of await sharedNames(tool, home)) {
    const at = path.join(dir, name);
    const from = path.join(home, name);
    if (await exists(at)) continue;
    if (always.has(name)) await mkdir(from, { recursive: true });
    const it = await stat(from).catch(() => null);
    if (!it || !(it.isDirectory() || it.isFile())) continue;
    await mkdir(path.dirname(at), { recursive: true });
    if (it.isDirectory()) {
      // A junction on Windows needs no developer mode, as a directory symlink does.
      await symlink(from, at, process.platform === "win32" ? "junction" : "dir").catch(() => {});
    } else {
      // Where a file can't be linked (Windows without developer mode), a copy: the default's as it was then.
      await symlink(from, at, "file").catch(() => copyFile(from, at).catch(() => {}));
    }
  }
  if (tool === "claude") await claudeState(dir).catch(() => {});
  return dir;
}

/**
 * The fields of Claude Code's `.claude.json` that belong to the sign-in, never taken to another account's: the account itself
 * and what Claude Code clears on sign-out, the ids of the install, a key that would go over the account's own sign-in, and its
 * caches (all from Orca's reading of Claude Code 2.1.295).
 */
const CLAUDE_ACCOUNT_KEYS = new Set([
  "oauthAccount", "additionalModelOptionsCache", "additionalModelOptionsAnsweredAt", "additionalModelCostsCache", "modelAccessCache",
  "orgModelDefaultCache", "cachedArtifactRoster", "artifactRosterDenied", "lastSeenOrgDefaultUpdatedAt", "clientDataCache", "clientDataCacheSlots",
  "autoCompactWindowsCache", "cachedUsageUtilization", "metricsStatusCache", "metricsStatusCacheByPrincipal", "githubWebConnectionStatusCache",
  "startupPrefetchedAt", "subscriptionNoticeCount", "hasAvailableSubscription", "userID", "machineID", "firstStartTime", "firstStartVersion",
  "primaryApiKey", "claudeCodeFirstTokenDate",
]);
export const isClaudeAccountKey = (k: string) => CLAUDE_ACCOUNT_KEYS.has(k) || k.includes("Cache") || k.startsWith("cached") || k.startsWith("passes");

/** The default account's `.claude.json`: in CLAUDE_CONFIG_DIR when that's set, else beside ~/.claude; the old `.config.json` first. */
async function claudeStateFile(configDir: string | null): Promise<string> {
  const legacy = path.join(configDir ?? path.join(homedir(), ".claude"), ".config.json");
  if (await exists(legacy)) return legacy;
  return configDir ? path.join(configDir, ".claude.json") : path.join(homedir(), ".claude.json");
}

/**
 * The default account's `.claude.json` taken into `account`'s, but for the sign-in's fields: MCP servers added for every
 * project, the folders trusted, onboarding seen, so an added account starts set up as the person's own Claude Code is.
 * `projects` and `mcpServers` are merged entry by entry (an entry only the account has stays; a folder it trusted stays
 * trusted); the rest is the default's. Done under Claude Code's own lock on the file, and written whole by a rename, so a Claude
 * Code running as that account never reads half of it or loses a write. Locked for longer than a moment: left for next time.
 */
export function mergeClaudeState(current: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...current };
  const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  for (const [k, v] of Object.entries(source)) {
    if (isClaudeAccountKey(k)) continue;
    if ((k === "projects" || k === "mcpServers") && rec(v) && rec(current[k])) {
      const was = current[k] as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...was, ...v };
      if (k === "projects")
        for (const [p, e] of Object.entries(v)) {
          const own = was[p];
          if (rec(own) && own.hasTrustDialogAccepted === true && rec(e)) merged[p] = { ...e, hasTrustDialogAccepted: true };
        }
      out[k] = merged;
    } else out[k] = v;
  }
  return out;
}

async function claudeState(dir: string): Promise<void> {
  const source = await claudeStateFile(process.env.CLAUDE_CONFIG_DIR || null);
  let from: Record<string, unknown>;
  try {
    const j = JSON.parse(await readFile(source, "utf8"));
    if (!j || typeof j !== "object" || Array.isArray(j)) return;
    from = j;
  } catch {
    return;
  }
  const target = await claudeStateFile(dir);
  const real = await realTarget(target);
  // Claude Code locks the file's own path (proper-lockfile: a folder beside it), even when the file is a link.
  const lock = `${target}.lock`;
  let held = false;
  for (let n = 0, wait = 50; n < 5; n++, wait = Math.min(wait * 2, 250)) {
    try {
      await mkdir(lock);
      held = true;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  if (!held) return;
  try {
    let current: Record<string, unknown> = {};
    try {
      const j = JSON.parse(await readFile(real, "utf8"));
      if (j && typeof j === "object" && !Array.isArray(j)) current = j;
    } catch (e) {
      // One there that can't be read or parsed is the account's: never written over.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    const next = mergeClaudeState(current, from);
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    const tmp = `${real}.friday-${process.pid}-${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, real).catch(async (e) => {
      await rm(tmp, { force: true });
      throw e;
    });
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

/** A link's file, so replacing it keeps the link. */
async function realTarget(p: string): Promise<string> {
  return realpath(p).catch(() => p);
}

/** A new account of `tool`, named by the person: its folder made, ready to sign in to. */
export async function addAccount(tool: AccountTool, label: string): Promise<ToolAccount> {
  const name = label.trim().slice(0, 40);
  if (!name) throw new Error("Give the account a name, like Work or Personal.");
  const s = await readStore();
  const list = (s[tool] ??= []);
  const taken = new Set([DEFAULT_ACCOUNT, ...list.map((a) => a.id)]);
  let id = slug(name);
  for (let n = 2; taken.has(id); n++) id = `${slug(name).slice(0, 28)}-${n}`;
  const account: ToolAccount = { id, label: name };
  list.push(account);
  await prepareAccountDir(tool, id);
  await writeStore(s);
  return account;
}

/** Renamed, the default too. */
export async function renameAccount(tool: AccountTool, id: string, label: string): Promise<void> {
  const name = label.trim().slice(0, 40);
  if (!name) throw new Error("Give the account a name.");
  const s = await readStore();
  const list = (s[tool] ??= []);
  const a = list.find((x) => x.id === id);
  if (a) a.label = name;
  else if (id === DEFAULT_ACCOUNT) list.unshift({ id, label: name });
  else throw new Error("There's no such account.");
  await writeStore(s);
}

/**
 * An added account gone, with its folder: its sign-in with it (a file for Codex; Claude Code's keychain item is the tool's to
 * remove, by signing out first, which local-api does). The links go, never what they point at. The default can't be removed.
 */
export async function removeAccount(tool: AccountTool, id: string): Promise<void> {
  if (id === DEFAULT_ACCOUNT) throw new Error("That's the tool's own sign-in. Sign out of it instead.");
  const s = await readStore();
  s[tool] = (s[tool] ?? []).filter((a) => a.id !== id);
  await writeStore(s);
  if (ID.test(id)) await rm(accountDir(tool, id), { recursive: true, force: true });
}

/** Ran out of usage, until `until` when its message said. */
export async function markOut(tool: AccountTool, id: string, until: number | null, now = Date.now()): Promise<void> {
  const s = await readStore();
  const list = (s[tool] ??= []);
  let a = list.find((x) => x.id === id);
  if (!a) {
    if (id !== DEFAULT_ACCOUNT) return;
    a = { id, label: "Main" };
    list.unshift(a);
  }
  a.outUntil = until;
  a.outAt = now;
  await writeStore(s);
}

/** Not out any more: a run went through on it. Nothing written when it wasn't marked. */
export async function markBack(tool: AccountTool, id: string): Promise<void> {
  const s = await readStore();
  const a = (s[tool] ?? []).find((x) => x.id === id);
  if (!a || (a.outAt === undefined && a.outUntil === undefined)) return;
  delete a.outAt;
  delete a.outUntil;
  await writeStore(s);
}

/** Out of usage now: until the time it said, or for five hours from when it said no time. */
export const isOut = (a: ToolAccount, now = Date.now()) => (a.outUntil ? a.outUntil > now : !!a.outAt && a.outUntil === null && now - a.outAt < 5 * 3_600_000);

/**
 * The account to carry on with once `current` is out: the next one that isn't out itself and is signed in (`signedIn` says,
 * null for "can't tell", which is tried). Null when there is none.
 */
export async function nextAccount(tool: AccountTool, current: string, signedIn: (id: string) => Promise<boolean | null>, now = Date.now()): Promise<ToolAccount | null> {
  const all = await listAccounts(tool);
  const at = all.findIndex((a) => a.id === current);
  // Tried in order from the one after it, so three accounts take turns rather than the first two passing it back and forth.
  const order = [...all.slice(at + 1), ...all.slice(0, Math.max(0, at))];
  for (const a of order) {
    if (a.id === current || isOut(a, now)) continue;
    if ((await signedIn(a.id)) !== false) return a;
  }
  return null;
}
