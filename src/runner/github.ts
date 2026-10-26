import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { childPath } from "./adapters.js";

/**
 * This computer's GitHub login: finding the one it has, and connecting one when it has none.
 *
 * Most people already have one — `gh`, or the credential git keeps for github.com — and those are used as they are. For
 * somebody who has neither (the usual case on Solo, where there is no Connections page to send them to), Connect runs
 * GitHub's device flow: a code to type on github.com, approved in the browser, nothing pasted. The token goes where git
 * keeps its own logins (Git Credential Manager, the keychain), so a clone or push from a terminal uses it too, and to `gh`
 * when it is installed and signed out. Only when git has no credential store does it stay in a file of Friday's, readable
 * by this user alone. It is sent to GitHub and nowhere else.
 */

const HOST = "github.com";
/** What the connected login may do: read and write the repos and pull requests it can see, and tell which teams it's in. */
const SCOPES = "repo read:org workflow";
const RECORD = () => path.join(homedir(), ".friday", "github.json");

export type TokenSource = "env" | "gh" | "git" | "friday";
interface Found {
  token: string;
  source: TokenSource;
}
/** What Friday saved, so it can say the login is its own and take it back out. Holds the token only when git couldn't. */
interface Saved {
  login: string;
  git?: boolean;
  gh?: boolean;
  token?: string;
}

export interface GithubStatus {
  connected: boolean;
  login?: string;
  avatar?: string;
  source?: TokenSource;
  /** Friday put this login here, so Disconnect can take it out again. */
  managed?: boolean;
  ghInstalled: boolean;
  /** A connect waiting on the person: the code to type and where. */
  pending?: { userCode: string; uri: string; expiresAt: number };
  error?: string;
}

function exec(cmd: string, args: string[], input?: string, timeout = 10_000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      // No prompts of any kind: a missing login is an answer, not a window. GCM_INTERACTIVE stops Git Credential Manager's sign-in dialog.
      { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PATH: childPath(), GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GH_PROMPT_DISABLED: "1" } },
      (err, out, errOut) => resolve({ ok: !err, out: String(out), err: String(errOut) }),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
}

let ghPath: Promise<string | null> | null = null;
/** The GitHub CLI, if it's installed. */
export function ghBin(): Promise<string | null> {
  ghPath ??= (async () => {
    const { stat } = await import("node:fs/promises");
    const names = process.platform === "win32" ? ["gh.exe", "gh.cmd", "gh.bat", "gh"] : ["gh"];
    for (const d of childPath().split(path.delimiter)) {
      for (const n of names) {
        const p = path.join(d, n);
        if (await stat(p).then((s) => s.isFile(), () => false)) return p;
      }
    }
    return null;
  })();
  return ghPath;
}

async function readSaved(): Promise<Saved | null> {
  try {
    const j = JSON.parse(await readFile(RECORD(), "utf8")) as Saved;
    return j && typeof j.login === "string" ? j : null;
  } catch {
    return null;
  }
}

async function writeSaved(s: Saved): Promise<void> {
  await mkdir(path.dirname(RECORD()), { recursive: true });
  await writeFile(RECORD(), JSON.stringify(s), { mode: 0o600 });
  await chmod(RECORD(), 0o600).catch(() => {});
}

const credential = (extra = "") => `protocol=https\nhost=${HOST}\n${extra}\n`;

async function find(): Promise<Found | null> {
  for (const k of ["GITHUB_TOKEN", "GH_TOKEN"]) {
    const v = process.env[k]?.trim();
    if (v) return { token: v, source: "env" };
  }
  const gh = await ghBin();
  if (gh) {
    const r = await exec(gh, ["auth", "token", "--hostname", HOST]);
    const t = r.ok ? r.out.trim() : "";
    if (t && !/\s/.test(t)) return { token: t, source: "gh" };
  }
  const fill = await exec("git", ["credential", "fill"], credential(), 5_000);
  const pass = fill.out.match(/^password=(.+)$/m)?.[1]?.trim();
  if (pass) return { token: pass, source: "git" };
  const saved = await readSaved();
  if (saved?.token) return { token: saved.token, source: "friday" };
  return null;
}

let memo: { at: number; v: Promise<Found | null>; none?: boolean } | null = null;
/** The login this computer has for GitHub, looked for at most every few minutes; having none is asked again sooner. */
export function machineToken(): Promise<Found | null> {
  if (memo && Date.now() - memo.at < (memo.none ? 15_000 : 5 * 60_000)) return memo.v;
  const v = find().catch(() => null);
  const m: NonNullable<typeof memo> = { at: Date.now(), v };
  memo = m;
  void v.then((f) => (m.none = !f));
  return v;
}
/**
 * The environment that lets git and gh use the login Friday keeps itself, on a machine where neither git nor gh could
 * keep it: a credential helper that answers from the environment (the token never goes on a command line, where any
 * process could read it) and GH_TOKEN for gh. Empty where git or gh hold a login of their own, so theirs is the one
 * that pushes. Set by name, so it stacks with whatever `-c` options a call already passes.
 */
export async function authEnv(): Promise<Record<string, string>> {
  const found = await machineToken();
  if (!found || found.source !== "friday") return {};
  return {
    FRIDAY_GH_TOKEN: found.token,
    GH_TOKEN: found.token,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `credential.https://${HOST}.helper`,
    GIT_CONFIG_VALUE_0: `!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' "$FRIDAY_GH_TOKEN"; }; f`,
  };
}

/** Look again next time: the login changed, or GitHub stopped accepting it. */
export function forgetToken(): void {
  memo = null;
  who = null;
}

const API = "https://api.github.com";
const headers = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "friday" });

let who: { token: string; at: number; login: string; avatar: string } | null = null;
async function whoAmI(token: string): Promise<{ login: string; avatar: string } | { status: number }> {
  if (who?.token === token && Date.now() - who.at < 10 * 60_000) return who;
  const r = await fetch(`${API}/user`, { headers: headers(token), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return { status: r.status };
  const j = (await r.json()) as { login?: string; avatar_url?: string };
  who = { token, at: Date.now(), login: String(j.login ?? ""), avatar: String(j.avatar_url ?? "") };
  return who;
}

// ── connecting ───────────────────────────────────────────────────────

let pending: { userCode: string; uri: string; expiresAt: number; cancelled: boolean } | null = null;
let lastError = "";

export async function githubStatus(): Promise<GithubStatus> {
  const ghInstalled = !!(await ghBin());
  if (pending && pending.expiresAt > Date.now()) return { connected: false, ghInstalled, pending: { userCode: pending.userCode, uri: pending.uri, expiresAt: pending.expiresAt } };
  const found = await machineToken();
  if (!found) return { connected: false, ghInstalled, ...(lastError ? { error: lastError } : {}) };
  const me = await whoAmI(found.token).catch(() => ({ status: 0 }));
  if ("status" in me) {
    if (me.status === 401) forgetToken();
    return { connected: false, ghInstalled, source: found.source, error: me.status === 401 ? "GitHub no longer accepts the login on this computer. Connect again." : "GitHub didn't answer. Try again in a moment." };
  }
  const saved = await readSaved();
  const managed = !!saved && saved.login === me.login && ((found.source === "git" && !!saved.git) || (found.source === "gh" && !!saved.gh) || found.source === "friday");
  return { connected: true, login: me.login, avatar: me.avatar, source: found.source, managed, ghInstalled };
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
async function post(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const r = await fetch(url, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "friday" }, body: form(body), signal: AbortSignal.timeout(15_000) });
  return (await r.json().catch(() => ({}))) as Record<string, unknown>;
}

const FLOW_ERRORS: Record<string, string> = {
  device_flow_disabled: "GitHub sign-in by code isn't switched on for Friday's GitHub app yet.",
  incorrect_client_credentials: "Friday's GitHub app isn't set up on this server.",
  unauthorized_client: "Friday's GitHub app isn't set up on this server.",
  access_denied: "The sign-in was cancelled on GitHub.",
  expired_token: "The code expired before it was used. Start again.",
};

/**
 * Start a connect: ask GitHub for a code, hand it back to be shown, and wait for the person to approve it in the browser.
 * The waiting carries on here after this returns; `githubStatus` says when it's done.
 */
export async function githubConnect(clientId: string): Promise<GithubStatus> {
  if (!/^[\w.-]{8,64}$/.test(clientId)) throw new Error("Connecting GitHub isn't set up on this Friday server yet.");
  if (pending && pending.expiresAt > Date.now()) return githubStatus();
  lastError = "";
  const code = await post(`https://${HOST}/login/device/code`, { client_id: clientId, scope: SCOPES });
  if (typeof code.error === "string") throw new Error(FLOW_ERRORS[code.error] ?? String(code.error_description ?? code.error));
  const device = String(code.device_code ?? "");
  const userCode = String(code.user_code ?? "");
  if (!device || !userCode) throw new Error("GitHub didn't give a sign-in code. Try again.");
  const flow = { userCode, uri: String(code.verification_uri ?? `https://${HOST}/login/device`), expiresAt: Date.now() + Number(code.expires_in ?? 900) * 1000, cancelled: false };
  pending = flow;
  void wait(clientId, device, Math.max(5, Number(code.interval ?? 5)), flow);
  return githubStatus();
}

export function githubCancel(): void {
  if (pending) pending.cancelled = true;
  pending = null;
}

async function wait(clientId: string, device: string, interval: number, flow: NonNullable<typeof pending>): Promise<void> {
  const done = (error = "") => {
    if (pending === flow) pending = null;
    lastError = error;
  };
  while (!flow.cancelled && Date.now() < flow.expiresAt) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    if (flow.cancelled) return;
    const r = await post(`https://${HOST}/login/oauth/access_token`, { client_id: clientId, device_code: device, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }).catch(() => ({}) as Record<string, unknown>);
    if (typeof r.access_token === "string" && r.access_token) {
      try {
        await keep(r.access_token);
        done();
      } catch (e) {
        done((e as Error).message);
      }
      return;
    }
    const err = typeof r.error === "string" ? r.error : "";
    if (err === "authorization_pending" || err === "") continue;
    if (err === "slow_down") {
      interval += 5;
      continue;
    }
    return done(FLOW_ERRORS[err] ?? String(r.error_description ?? err));
  }
  if (!flow.cancelled) done(FLOW_ERRORS.expired_token);
}

/** Put a new token where this computer's tools will find it: git's credential store, gh, or Friday's own file. */
async function keep(token: string): Promise<void> {
  const me = await whoAmI(token);
  if ("status" in me) throw new Error("GitHub gave a login it then didn't accept. Try again.");
  const saved: Saved = { login: me.login };
  const login = `username=${me.login}\npassword=${token}\n`;
  await exec("git", ["credential", "approve"], credential(login), 15_000);
  // Only kept if it can be read back: with no credential helper configured, git accepts it and forgets it.
  const back = await exec("git", ["credential", "fill"], credential(`username=${me.login}\n`), 5_000);
  if (back.out.match(/^password=(.+)$/m)?.[1]?.trim() === token) saved.git = true;
  const gh = await ghBin();
  if (gh) {
    const signedIn = (await exec(gh, ["auth", "token", "--hostname", HOST])).out.trim();
    if (!signedIn && (await exec(gh, ["auth", "login", "--hostname", HOST, "--with-token"], token, 20_000)).ok) saved.gh = true;
  }
  if (!saved.git) saved.token = token;
  await writeSaved(saved);
  forgetToken();
}

/** Take out the login Friday put here. One somebody set up themselves (gh, their own git login) is theirs to remove. */
export async function githubDisconnect(): Promise<GithubStatus> {
  githubCancel();
  const saved = await readSaved();
  if (!saved) throw new Error("This GitHub login wasn't added by Friday. Sign out with `gh auth logout` or your git credential manager.");
  if (saved.git) await exec("git", ["credential", "reject"], credential(`username=${saved.login}\n`), 10_000);
  const gh = await ghBin();
  if (saved.gh && gh) await exec(gh, ["auth", "logout", "--hostname", HOST, "--user", saved.login], undefined, 15_000);
  await rm(RECORD(), { force: true });
  forgetToken();
  lastError = "";
  return githubStatus();
}

// ── asking GitHub ────────────────────────────────────────────────────

/** A call to GitHub's REST API as this computer's login. Errors are GitHub's own words, made readable. */
export async function githubRest<T>(method: string, route: string, body?: unknown): Promise<T> {
  const found = await machineToken();
  if (!found) throw new Error("Connect GitHub first.");
  const r = await fetch(`${API}${route}`, {
    method,
    headers: { ...headers(found.token), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status === 204) return undefined as T;
  const j = (await r.json().catch(() => ({}))) as { message?: string; errors?: { message?: string }[] } & Record<string, unknown>;
  if (!r.ok) {
    if (r.status === 401) forgetToken();
    const why = [j.message, ...(j.errors ?? []).map((e) => e.message)].filter(Boolean).join(": ");
    throw new Error(r.status === 401 ? "GitHub didn't accept the login on this computer. Connect GitHub again." : why || `GitHub answered ${r.status}.`);
  }
  return j as T;
}

export async function githubGraphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const j = await githubRest<{ data?: T; errors?: { message?: string }[] }>("POST", "/graphql", { query, variables });
  if (!j.data && j.errors?.length) throw new Error(j.errors.map((e) => e.message).join("; "));
  return j.data as T;
}
