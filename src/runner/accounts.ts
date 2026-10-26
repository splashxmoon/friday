import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
 * ~/.friday/accounts/<tool>/<id>, linked back to the default folder for everything that isn't the sign-in: settings, skills,
 * plugins and, above all, the conversations, so one account carries on a conversation another started (`--resume`, and
 * Codex's own lookup, which falls back to its sessions folder when its database hasn't heard of a thread).
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

/** Linked from an added account's folder to the default one's: everything but the sign-in. Folders first, made where missing. */
const SHARED: Record<AccountTool, { dirs: string[]; files: string[] }> = {
  claude: { dirs: ["projects", "agents", "skills", "commands", "plugins", "output-styles", "todos"], files: ["settings.json", "CLAUDE.md"] },
  codex: { dirs: ["sessions", "archived_sessions", "skills", "prompts", "plugins"], files: ["config.toml", "AGENTS.md"] },
};

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

/** Its folder, linked back to the default one's for what is shared. Made again where a link has gone (safe to run twice). */
export async function prepareAccountDir(tool: AccountTool, id: string): Promise<string> {
  const dir = accountDir(tool, id);
  const home = toolHome(tool);
  await mkdir(dir, { recursive: true });
  for (const d of SHARED[tool].dirs) {
    const at = path.join(dir, d);
    if (await exists(at)) continue;
    await mkdir(path.join(home, d), { recursive: true });
    // A junction on Windows needs no developer mode, as a directory symlink does.
    await symlink(path.join(home, d), at, process.platform === "win32" ? "junction" : "dir").catch(() => {});
  }
  for (const f of SHARED[tool].files) {
    const at = path.join(dir, f);
    if ((await exists(at)) || !(await exists(path.join(home, f)))) continue;
    await symlink(path.join(home, f), at, "file").catch(() => {});
  }
  return dir;
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
