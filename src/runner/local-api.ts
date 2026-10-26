import { readLimits } from "./limits.js";
import { findApp, forgetLoginStatus, loginStatusQuick } from "./adapters.js";
import { mkdir, rm, rmdir, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { ENGINE_NAMES, ENGINE_TOOLS, toolList, type EngineMode, type EngineTool } from "../types.js";
import { ADAPTERS, childEnv, findBin, isClaudeAppBundled, launcher, loginStatus, readCustomAcp, runCli, saveCustomAcp } from "./adapters.js";
import { discoverAgentFiles, parseModelList } from "./agent-files.js";
import { addWorktree, branchesOf, dropSpares, dropWorktree, primeSpares, remoteBranchesOf, repoInfo, startRepo, worktreeState } from "./git.js";
import { listCliSessions } from "./imports.js";
import { knownModels, Runner, stayAttached } from "./runner.js";
import { askCli } from "./ask.js";
import { installSkill } from "./tool-commands.js";
import { listBackground, startBackground, stopBackground } from "./background.js";
import { listServers, stopServer } from "./ports.js";
import { fetchPreview, previewOptions, previewStatusLive, startPreview, stopPreview } from "./preview.js";
import { iosInput, iosRun, iosScreen, iosStatus, iosStop, type IosInput } from "./ios.js";
import { iosLiveUrl } from "./ios-live.js";
import { folderSetup, saveEnvironment } from "./environment.js";
import { cancelLogin, finishLogin, openInTerminal, startLogin } from "./terminal.js";
import { accountEnv, addAccount, DEFAULT_ACCOUNT, getAccount, hasAccounts, isOut, listAccounts, removeAccount, renameAccount, type AccountTool } from "./accounts.js";
import { browse, cloneRepo, defaultCloneRoot, describe, findByName, ghBin, githubRepos, issues, pullRequests, recentReposCached, teamPullRequests } from "./workspace.js";
import { githubCancel, githubConnect, githubDisconnect, githubStatus } from "./github.js";
import { githubItem, localRepo, prAct, prReview, type DraftComment, type PrAction } from "./pr-actions.js";
import { savedDirs, startDirs } from "./extra-dirs.js";
import { detectLocal, discoverModels, listOwnModels, ownComplete, ownVision, removeOwnModel, saveOwnModel, testOwnModel } from "./own-models.js";

/**
 * Everything Friday can ask someone's machine to do on their behalf: what
 * coding CLIs are installed, which repos and past sessions are there, clone
 * from GitHub, sign a CLI in, and start a runner.
 *
 * One implementation, two callers. When Friday runs on your own machine the
 * server calls this directly; when Friday is hosted, your linked machine runs
 * the very same code and answers over the link. The hosted UI is then exactly
 * the local one, because it is asking exactly the same questions.
 */

export interface MachineInfo {
  name: string;
  platform: string;
  home: string;
}

export const machineInfo = (): MachineInfo => ({ name: process.env.FRIDAY_MACHINE_NAME || hostname().replace(/\.local$/i, ""), platform: process.platform, home: homedir() });

export interface HostContext {
  /** The Friday server runners started here should connect back to. */
  serverUrl: string;
  /** Who these runners act as in a session. */
  user: { id: string; name: string };
  /** Runners started on this machine, keyed `sessionId|lane`. */
  runners: Map<string, Runner>;
  log?: (line: string) => void;
  /** Word back to whoever asked, before the answer: the agent builder's text as the CLI writes it. */
  progress?: (value: unknown) => void;
}

export const HOST_METHODS = [
  "tools",
  "folders",
  "browse",
  "describe",
  "find",
  "github",
  "prs",
  "prs.team",
  "issues",
  "pr.act",
  "pr.review",
  "github.status",
  "github.connect",
  "github.cancel",
  "github.disconnect",
  "github.item",
  "repo.local",
  "models.own.list",
  "models.own.save",
  "models.own.remove",
  "models.own.test",
  "models.own.discover",
  "models.own.detect",
  "models.own.vision",
  "llm.complete",
  "skills.install",
  "sessions",
  "acp.get",
  "acp.set",
  "login",
  "login.code",
  "login.cancel",
  "logout",
  // More than one account of Claude Code or Codex on this computer (accounts.ts).
  "accounts",
  "accounts.add",
  "accounts.rename",
  "accounts.remove",
  "gh-login",
  "clone",
  "start",
  "stop",
  "worktree.drop",
  "worktree.state",
  "agents.discover",
  "models",
  "preview.options",
  "preview.start",
  "preview.status",
  "preview.stop",
  "preview.fetch",
  // An iOS app on a Mac with Xcode, built and run in a simulator for the Preview panel (ios.ts).
  "ios.status",
  "ios.run",
  "ios.stop",
  "ios.screen",
  "ios.input",
  // The simulator live, on a page this runner serves on 127.0.0.1 (ios-live.ts).
  "ios.live",
  // A session's environment on this computer (environment.ts): what is kept for a folder, and its setup run now.
  "env.save",
  "env.setup",
  "background.list",
  "servers.list",
  "servers.stop",
  "background.stop",
  "usage",
] as const;
export type HostMethod = (typeof HOST_METHODS)[number];

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * A directory for an agent that was not given one.
 *
 * Under the home folder, per session, so two sessions never share it and it is
 * obvious where it is. Nothing in it is anybody's work: it exists so the agent
 * has somewhere to stand while it reads, plans and answers.
 */
async function scratchFolder(sid: string, lane: string): Promise<string> {
  // Per lane as well as per session: the one-writer-per-folder rule would
  // otherwise refuse a second "no folder" agent for sharing a directory that
  // holds nothing worth protecting.
  const clean = (v: string, fallback: string) => v.replace(/[^\w-]/g, "").slice(0, 40) || fallback;
  const dir = path.join(homedir(), "Friday", "sessions", clean(sid, "session"), clean(lane, "agent"));
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * What a removed agent leaves behind on this computer, cleared: its separate copy, unless it has uncommitted changes (its
 * branch stays, so what was committed is kept), or its scratch folder, and the session's folder of those once it is empty.
 */
async function clearAfter(sid: string, cwd: string, made: { copy: boolean; scratch: boolean }): Promise<void> {
  if (made.copy) await dropWorktree(cwd, "committed").catch(() => false);
  if (!made.scratch) return;
  const sessions = path.join(homedir(), "Friday", "sessions");
  // Only ever a folder scratchFolder made, never one somebody chose.
  if (path.dirname(path.dirname(cwd)) !== sessions) return;
  await rm(cwd, { recursive: true, force: true }).catch(() => {});
  await rmdir(path.dirname(cwd)).catch(() => {});
}

/** Words that say what is wanted rather than what it is: "help me build a…" names nothing. */
const FILLER = new Set(
  "a an the and or of for to in on with from me my us our i we you your it this that some something very really just please can could would will help make build create write add start new let lets let's want need get do code app quick simple small basic".split(" "),
);

/** A folder name from what was asked: its first few words that name something, lowercase, with dashes. */
export function projectName(ask: string): string {
  const words = ask
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w));
  let name = "";
  for (const w of words.slice(0, 4)) {
    if (name && name.length + w.length + 1 > 40) break;
    name = name ? `${name}-${w}` : w.slice(0, 40);
  }
  return name || "project";
}

/**
 * A project folder for a session started with no folder, the way Claude Code makes one when no folder is picked (Arun,
 * 2026-10-22: "allow coding tools and agents and stuff create folders when there is no folder when starting a session, like
 * how claude code does it"). ~/Friday/Projects/<name>, named from what was asked, a new one each time (a -2 after a name
 * taken), and made a git repository on this computer, so the agents added to the session later each work in a copy of it.
 *
 * Unlike scratchFolder above, this is the session's code: the Files tab, the Preview and every agent that joins find it as
 * they would a folder somebody picked.
 */
export async function projectFolder(ask: string, who: { name: string }, root = path.join(homedir(), "Friday", "Projects")): Promise<string> {
  await mkdir(root, { recursive: true });
  const base = projectName(ask);
  for (let n = 1; n <= 200; n++) {
    const dir = path.join(root, n === 1 ? base : `${base}-${n}`);
    // Made, not found: one that is already there is somebody's other project.
    const made = await mkdir(dir).then(
      () => true,
      (e: NodeJS.ErrnoException) => {
        if (e.code === "EEXIST") return false;
        throw e;
      },
    );
    if (!made) continue;
    await startRepo(dir, who);
    return dir;
  }
  throw new Error(`Couldn't make a new folder for this in ${root}.`);
}

/** A sign-in's key, so two accounts of one tool can't take each other's code. */
const loginKey = (tool: EngineTool, account?: string) => (account ? `${tool}:${account}` : tool);

/** The account a call names, checked to be one of the tool's: undefined for its own sign-in. */
async function accountParam(tool: EngineTool, v: unknown): Promise<string | undefined> {
  const id = str(v, 40);
  if (!id || id === DEFAULT_ACCOUNT || !hasAccounts(tool)) return undefined;
  if (!(await getAccount(tool, id))) throw new Error(`${ENGINE_NAMES[tool]} has no account called “${id}” here.`);
  return id;
}

/** A tool's accounts for its row: only when it has more than one, unless `always`. */
async function accountRows(tool: AccountTool, bin: string, always = false): Promise<{ accounts?: { id: string; label: string; loggedIn: boolean | null; out?: boolean; outUntil?: number | null }[] }> {
  const all = await listAccounts(tool);
  if (all.length < 2 && !always) return {};
  return {
    accounts: await Promise.all(
      all.map(async (a) => ({
        id: a.id,
        label: a.label,
        loggedIn: await loginStatusQuick(tool, bin, 1_500, a.id === DEFAULT_ACCOUNT ? undefined : a.id),
        ...(isOut(a) ? { out: true, outUntil: a.outUntil ?? null } : {}),
      })),
    ),
  };
}

export async function callHost(method: string, params: Record<string, unknown> = {}, ctx: HostContext): Promise<unknown> {
  const home = homedir();
  // "~\code" is as valid as "~/code" for someone typing on Windows.
  const at = (p: unknown) => path.resolve(str(p, 600).replace(/^~(?=$|[\\/])/, home) || home);
  const isDir = (p: string) => stat(p).then((s) => s.isDirectory(), () => false);

  switch (method) {
    case "tools": {
      // `tool`: just that one, for a start that only needs to know about the agent it is starting.
      const one = str(params.tool, 20) as EngineTool;
      const tools = await Promise.all(
        (ENGINE_TOOLS.includes(one) ? [one] : ENGINE_TOOLS).map(async (t) => {
          const bin = await findBin(t);
          return {
            tool: t,
            name: ENGINE_NAMES[t],
            path: bin,
            // A slow answer is "don't know yet", not a reason to hold the whole card
            // back: the check carries on in the background and the next look has it.
            loggedIn: bin ? await loginStatusQuick(t, bin) : null,
            // Claude Code bundled in the Claude desktop app signs in separately from the app.
            source: bin ? (isClaudeAppBundled(bin) ? "claude-app" : "cli") : null,
            // The app is here though the agent isn't (Cursor's editor, without its CLI).
            ...(!bin && (await findApp(t)) ? { app: true } : {}),
            // Installed, but it can't run here (Kilo's ACP on Windows): said on its row rather than found out from a turn.
            ...(bin && ADAPTERS[t].unavailable?.() ? { unavailable: ADAPTERS[t].unavailable!()! } : {}),
            // Its accounts here, when it has more than one (accounts.ts): each signed in or not, and out of usage or not.
            ...(bin && hasAccounts(t) ? await accountRows(t, bin) : {}),
          };
        }),
      );
      const running = [...ctx.runners.values()].map((r) => ({ sid: r.opts.session, lane: r.lane, tool: r.opts.tool, cwd: r.opts.cwd }));
      return { tools, home, machine: machineInfo(), running };
    }
    case "folders":
      return { home, cloneRoot: defaultCloneRoot(), recent: await recentReposCached() };
    case "browse":
      return browse(at(params.path));
    case "describe": {
      const p = at(params.path);
      if (!(await isDir(p))) throw new Error(`There's no folder at ${p}.`);
      // Whether it has uncommitted work is four git processes, so only for whoever asks (`dirty`): every other look at a
      // folder (finding the session's code, the picker's recent folders) paid for it and never read it.
      // The folders kept for it (`dirs`), for the picker that offers them again.
      // Its branches (`branches`), for the new-session page's pick of which one to work on: this checkout's, and origin's as
      // last fetched. Nothing is fetched, so it is quick and never asks for a password.
      const [folder, repo, dirs, branches, remote] = await Promise.all([
        describe(p),
        params.dirty ? repoInfo(p) : null,
        params.dirs ? savedDirs(p) : null,
        params.branches ? branchesOf(p).catch(() => null) : null,
        params.branches ? remoteBranchesOf(p) : null,
      ]);
      const branchList = branches ? [...branches.branches.map((b) => ({ name: b.name, ...(b.elsewhere ? { elsewhere: b.elsewhere } : {}) })), ...(remote ?? []).map((name) => ({ name, remote: true as const }))] : null;
      return { folder: { ...folder, ...(repo ? { dirty: repo.dirty } : {}), ...(dirs ? { dirs } : {}), ...(branchList ? { branches: branchList } : {}) } };
    }
    case "find":
      return { matches: await findByName(str(params.name, 200)) };
    case "github":
      return githubRepos();
    case "prs":
      return pullRequests();
    case "issues":
      return issues();
    case "prs.team":
      return teamPullRequests((Array.isArray(params.repos) ? params.repos : String(params.repos ?? "").split(",")).map((r) => str(r, 140)).filter(Boolean));
    // Code Review's buttons: each one something the person pressed, done as them through this computer's GitHub login.
    case "pr.act":
      return prAct({
        url: str(params.url, 300),
        action: str(params.action, 30) as PrAction,
        method: str(params.method, 10),
        body: str(params.body, 8000),
        head: str(params.head, 64),
        id: str(params.id, 100),
        comments: (Array.isArray(params.comments) ? params.comments : []).slice(0, 30).map((c: Record<string, unknown>) => ({ path: str(c?.path, 300), body: str(c?.body, 4000), ...(Number(c?.line) > 0 ? { line: Math.floor(Number(c.line)) } : {}) }) as DraftComment),
      });
    case "pr.review":
      return prReview({ url: str(params.url, 300), tool: str(params.tool, 20), model: str(params.model, 60) || undefined });
    case "github.status":
      return githubStatus();
    case "github.connect":
      return githubConnect(str(params.clientId, 64));
    case "github.cancel":
      githubCancel();
      return githubStatus();
    case "github.disconnect":
      return githubDisconnect();
    case "github.item":
      return githubItem({ url: str(params.url, 300) });
    case "repo.local":
      return localRepo({ repo: str(params.repo, 200) });
    // Your own models, kept on this computer with their keys (own-models.ts). Nothing here sends a key anywhere but its model's server.
    case "models.own.list":
      return listOwnModels();
    case "models.own.save":
      return saveOwnModel({
        ...(str(params.id, 20) ? { id: str(params.id, 20) } : {}),
        ...(typeof params.name === "string" ? { name: str(params.name, 60) } : {}),
        ...(typeof params.baseUrl === "string" ? { baseUrl: str(params.baseUrl, 300) } : {}),
        ...(typeof params.model === "string" ? { model: str(params.model, 200) } : {}),
        ...(typeof params.apiKey === "string" ? { apiKey: str(params.apiKey, 500) } : {}),
        ...(typeof params.provider === "string" ? { provider: str(params.provider, 30) } : {}),
        ...(typeof params.vision === "boolean" ? { vision: params.vision } : {}),
      });
    case "models.own.vision":
      return ownVision({ id: str(params.id, 20) });
    case "models.own.remove":
      return removeOwnModel({ id: str(params.id, 20) });
    case "models.own.test":
      return testOwnModel({ id: str(params.id, 20) });
    case "models.own.discover":
      return discoverModels({ baseUrl: str(params.baseUrl, 300), apiKey: str(params.apiKey, 500), id: str(params.id, 20) });
    case "models.own.detect":
      return detectLocal();
    // A step of Friday's agent on one of those models: asked by the server, answered here, the text passed back as it comes.
    case "llm.complete": {
      let gathered = "";
      let thought = "";
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (gathered || thought) ctx.progress?.({ ...(gathered ? { d: gathered } : {}), ...(thought ? { r: thought } : {}) });
        gathered = thought = "";
      };
      const soon = () => (timer ??= setTimeout(flush, 60));
      try {
        return await ownComplete(
          {
            id: str(params.id, 20),
            system: typeof params.system === "string" ? params.system : "",
            messages: Array.isArray(params.messages) ? (params.messages as never) : [],
            tools: Array.isArray(params.tools) ? (params.tools as never) : [],
            ...(str(params.reasoningEffort, 10) ? { reasoningEffort: str(params.reasoningEffort, 10) } : {}),
          },
          ctx.progress ? { delta: (t) => ((gathered += t), soon()), reasoning: (t) => ((thought += t), soon()) } : {},
        );
      } finally {
        flush();
      }
    }
    case "skills.install": {
      const tools = (Array.isArray(params.tools) ? params.tools : []).filter((t): t is EngineTool => ENGINE_TOOLS.includes(t as EngineTool));
      const name = str(params.name, 60);
      const instructions = str(params.instructions, 20_000);
      if (!name || !instructions || !tools.length) throw new Error("Which skill, and which of your tools?");
      return installSkill({ name, description: str(params.description, 300), instructions }, tools);
    }
    case "sessions": {
      const tool = str(params.tool, 20) as EngineTool;
      return listCliSessions({ tools: ENGINE_TOOLS.includes(tool) ? [tool] : undefined });
    }
    // The agent for "Other ACP agent", as a command line.
    case "acp.get": {
      const set = await readCustomAcp();
      return { line: set ? [set.command, ...set.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ") : "" };
    }
    case "acp.set": {
      const set = await saveCustomAcp(str(params.line, 1000));
      return { ok: true, found: set ? !!(await findBin("acp")) : false };
    }
    case "login": {
      const tool = str(params.tool, 20) as EngineTool;
      if (!ENGINE_TOOLS.includes(tool)) throw new Error("Unknown coding agent.");
      const bin = await findBin(tool);
      if (!bin) throw new Error(`${ENGINE_NAMES[tool]} isn't installed on this machine.`);
      // Signing in to one of its accounts (accounts.ts) is the same sign-in, pointed at that account's folder.
      const account = await accountParam(tool, params.account);
      const env = accountEnv(tool, account);
      const how = await launcher(bin);
      const argv = [how.command, ...how.prefix, ...ADAPTERS[tool].login];
      // The tools spoken to over ACP sign in their own ways (a device code typed on the vendor's site, a choice of provider, the
      // tool itself asking as it starts), none of them a code pasted back here: their own terminal shows whatever they ask.
      if (ADAPTERS[tool].interactive || !ADAPTERS[tool].login.length) return openInTerminal(argv, env);
      // A sign-in is a web page, so hand back the link. Only if the CLI
      // prints none does this fall back to opening a terminal.
      const started = await startLogin(loginKey(tool, account), argv, { env: { ...childEnv(), ...how.env, ...env } });
      // The CLI opens the page itself and then waits on stdin for the code it
      // shows. So the link comes back to be offered, not opened — opening it
      // here is the second browser people were getting — and the sign-in stays
      // running until "login.code" hands it what they pasted.
      if (started.url) return { url: started.url, command: started.command, opened: true, needsCode: true };
      return openInTerminal(argv, env);
    }
    // The code from that page. The CLI judges it; this only carries it.
    case "login.code": {
      forgetLoginStatus();
      const tool = str(params.tool, 20) as EngineTool;
      if (!ENGINE_TOOLS.includes(tool)) throw new Error("Unknown coding agent.");
      const code = str(params.code, 400);
      if (!code) throw new Error("Paste the code the sign-in page showed.");
      const account = await accountParam(tool, params.account);
      const r = await finishLogin(loginKey(tool, account), code);
      if (!r.ok) throw new Error(r.output || "That code wasn't accepted. Start the sign-in again.");
      const bin = await findBin(tool);
      return { ok: true, loggedIn: bin ? await loginStatus(tool, bin, account) : null };
    }
    case "login.cancel": {
      const tool = str(params.tool, 20) as EngineTool;
      if (ENGINE_TOOLS.includes(tool)) cancelLogin(loginKey(tool, await accountParam(tool, params.account).catch(() => undefined)));
      return { ok: true };
    }
    // Signing out needs no browser, so it happens here rather than in a
    // terminal. It signs that CLI out on this machine for every use of it,
    // not just Friday's — which is why the UI asks first.
    case "logout": {
      forgetLoginStatus();
      const tool = str(params.tool, 20) as EngineTool;
      if (!ENGINE_TOOLS.includes(tool)) throw new Error("Unknown coding agent.");
      const bin = await findBin(tool);
      if (!bin) throw new Error(`${ENGINE_NAMES[tool]} isn't installed on this machine.`);
      if (!ADAPTERS[tool].logout.length) throw new Error(`${ENGINE_NAMES[tool]} has no command to sign out with. Sign out in ${ENGINE_NAMES[tool]} itself.`);
      const account = await accountParam(tool, params.account);
      const r = await runCli(bin, ADAPTERS[tool].logout, 20_000, accountEnv(tool, account));
      const still = await loginStatus(tool, bin, account);
      if (still === true) throw new Error(`${ENGINE_NAMES[tool]} is still signed in${r.out ? `: ${r.out.slice(0, 200)}` : "."}`);
      return { ok: true, output: r.out.slice(0, 400) };
    }
    // Claude Code's and Codex's accounts on this computer, each signed in or not (accounts.ts).
    case "accounts": {
      const one = str(params.tool, 20) as EngineTool;
      const tools = (hasAccounts(one) ? [one] : (["claude", "codex"] as AccountTool[])) as AccountTool[];
      const out: Record<string, unknown> = {};
      for (const t of tools) {
        const bin = await findBin(t);
        out[t] = bin ? (await accountRows(t, bin, true)).accounts : (await listAccounts(t)).map((a) => ({ id: a.id, label: a.label, loggedIn: null }));
      }
      return { accounts: out };
    }
    // A new account, named: its folder made, and its sign-in started as "login" starts one, so the person goes straight to it.
    case "accounts.add": {
      const tool = str(params.tool, 20) as EngineTool;
      if (!hasAccounts(tool)) throw new Error(`${ENGINE_NAMES[tool] ?? "That agent"} keeps one account on a computer. Claude Code and Codex can have more.`);
      if (!(await findBin(tool))) throw new Error(`${ENGINE_NAMES[tool]} isn't installed on this machine.`);
      const account = await addAccount(tool, str(params.label, 40));
      forgetLoginStatus();
      const login = (await callHost("login", { tool, account: account.id }, ctx)) as Record<string, unknown>;
      return { account, login };
    }
    case "accounts.rename": {
      const tool = str(params.tool, 20) as EngineTool;
      if (!hasAccounts(tool)) throw new Error("Unknown account.");
      await renameAccount(tool, str(params.id, 40), str(params.label, 40));
      return { ok: true };
    }
    // Gone from this computer: signed out first, so Claude Code's keychain item goes with it, then its folder.
    case "accounts.remove": {
      const tool = str(params.tool, 20) as EngineTool;
      const id = str(params.id, 40);
      if (!hasAccounts(tool) || !(await getAccount(tool, id))) throw new Error("There's no such account.");
      if (id === DEFAULT_ACCOUNT) throw new Error("That's the tool's own sign-in. Sign out of it instead.");
      const using = [...ctx.runners.values()].find((r) => r.opts.tool === tool && r.opts.account === id);
      if (using) throw new Error(`An agent in a session is running on that account. Stop it first.`);
      const bin = await findBin(tool);
      if (bin) await runCli(bin, ADAPTERS[tool].logout, 20_000, accountEnv(tool, id)).catch(() => null);
      await removeAccount(tool, id);
      forgetLoginStatus();
      return { ok: true };
    }
    case "gh-login": {
      const gh = await ghBin();
      if (!gh) throw new Error("The GitHub CLI (gh) isn't installed. Install it from cli.github.com, then try again.");
      return openInTerminal([gh, "auth", "login"]);
    }
    case "clone": {
      const parent = str(params.parent, 600);
      return { folder: await cloneRepo(str(params.repo, 400), parent ? at(parent) : undefined) };
    }
    case "start": {
      // A lane brought back by itself (the page's quiet reconnect, `ifOffline`) that this computer already has attached, or on its
      // way back (stayAttached keeps it here while it waits to retry): left as it is. Started again, it took the lane from the
      // runner already on it, mid-turn, once for every window that asked.
      const kept = params.ifOffline === true && str(params.lane, 40) ? ctx.runners.get(`${str(params.sid, 64)}|${str(params.lane, 40)}`) : undefined;
      if (kept && !kept.stopped) return { lane: kept.lane, laneName: kept.laneName, already: true };
      // No tool is a folder lent to the session with no CLI behind it: Friday's
      // own agent reads, edits and runs commands in it through this runner.
      const tool = str(params.tool, 20) as EngineTool | "";
      if (tool && !ENGINE_TOOLS.includes(tool)) throw new Error(`Pick ${toolList()}.`);
      const sid = str(params.sid, 64);
      /**
       * No folder, on purpose.
       *
       * Somebody joining a session from another computer does not have the
       * folder it is working in, and should still be able to bring their own
       * agent into it. That agent needs a directory to stand in, and `at()` of
       * an empty path is the home directory — so "no folder" has to be said
       * explicitly and given a place of its own, rather than left to fall
       * through to somebody's home.
       */
      const noFolder = params.noFolder === true && !str(params.cwd, 600);
      if (!noFolder && !str(params.cwd, 600)) throw new Error("Which folder should it work in?");
      // With what was asked (`project`), a session's first agent gets a project folder of its own to build in; without, an
      // agent joining from elsewhere gets somewhere to stand.
      const project = noFolder ? str(params.project, 400) : "";
      // Only somewhere to stand, not anybody's code: no spare copies, no setup run.
      const scratch = noFolder && !project;
      let cwd = project ? await projectFolder(project, ctx.user) : noFolder ? await scratchFolder(sid, str(params.lane, 40) || str(params.newLane, 40)) : at(params.cwd);
      if (!(await isDir(cwd))) throw new Error(`There's no folder at ${cwd}.`);
      // A racing agent works in a checkout of its own, cut from the folder as it is now.
      let raceBranch = "";
      // The copy's repository as it was made, and what its .worktreeinclude names, still to come (addWorktree).
      let made: Awaited<ReturnType<typeof addWorktree>> | null = null;
      // Where a separate copy came from, so its work can be brought back there (Apply).
      // Started again in a copy it already has (Reconnect, or a new mode or model from the page): said by the page, since the
      // copy can't say what it was cut from, and without it Apply went away for that agent.
      let copyOf = params.worktree ? "" : str(params.copyOf, 600);
      // The folders beside it that its tool may work in too, as chosen now or as kept for the folder it was started from.
      // Before any copy is made, so a folder refused here leaves none behind.
      const dirs = await startDirs(params.dirs, copyOf || cwd, at);
      if (params.worktree) {
        // A folder never put in git is made a repository first, on this computer only (startRepo): a copy is a git worktree.
        if (!(await repoInfo(cwd))) await startRepo(cwd, { name: ctx.user.name });
        copyOf = cwd;
        const w = await addWorktree(cwd, params.worktree === "lane" ? str(params.newLane, 40) || str(params.copyName, 40) || "agent" : undefined, params.carry === true).catch((e: Error) => {
          throw new Error(`Couldn't make a separate copy to race in: ${e.message}`);
        });
        cwd = w.path;
        raceBranch = w.branch;
        made = w;
      }
      const runner = new Runner({
        server: ctx.serverUrl,
        session: sid,
        invite: str(params.invite, 400),
        userId: ctx.user.id,
        name: ctx.user.name,
        actorToken: str(params.actorToken, 400) || undefined,
        ...(tool ? { tool } : {}),
        cwd,
        ...(copyOf ? { copyOf } : {}),
        // Brought back by itself (the page's quiet reconnect, the server as this computer links): the lane coming back after a
        // drop, as stayAttached's own retries are. Its tool isn't started warm, a few hundred MB for a lane nobody may give a
        // turn, and its base is the one it had; a dozen lanes coming back at launch would otherwise start a dozen CLIs.
        ...(params.ifOffline === true ? { reattach: true } : {}),
        // In the folder beside an agent already editing it, by choice, with no copy made (EngineInfo.shared).
        ...(params.share === true && !params.worktree ? { share: true } : {}),
        ...(dirs.length ? { dirs } : {}),
        ...(made ? { repo: made.repo, ...(made.include ? { include: made.include } : {}) } : {}),
        // Auto when none is said: what every agent starts in (Arun, 2026-10-18).
        mode: (["plan", "edits", "full"].includes(String(params.mode)) ? params.mode : "full") as EngineMode,
        // Chosen automatically for the host's own work: what was picked by hand, which everyone else's turns are held to.
        ...(["plan", "edits", "full"].includes(String(params.handMode)) ? { handMode: params.handMode as EngineMode } : {}),
        lane: str(params.lane, 40) || undefined,
        newLane: str(params.newLane, 40) || undefined,
        branch: raceBranch || str(params.branch, 100) || undefined,
        // Where a branch that has to be made starts: the one picked on the new-session page (runner.ts branchFrom).
        ...(!raceBranch && str(params.branch, 100) && /^[\w./-]{1,108}$/.test(str(params.branchFrom, 108)) && !str(params.branchFrom, 108).startsWith("-") ? { branchFrom: str(params.branchFrom, 108) } : {}),
        ...(!raceBranch && str(params.followBranch, 100) ? { followBranch: str(params.followBranch, 100) } : {}),
        // One of that CLI's own models, if the person picked one.
        model: str(params.model, 60) || undefined,
        // Which of its accounts here (accounts.ts), if the person picked one.
        ...(tool && hasAccounts(tool) && str(params.account, 40) ? { account: str(params.account, 40) } : {}),
        // Continuing one of this CLI's own past conversations.
        resumeId: str(params.resumeId, 100) || undefined,
        // A hand-off's: resumed only if this machine has it (Runner.start).
        ...(params.resumeIfHere === true ? { resumeIfHere: true } : {}),
        // Picked from a shared link: the conversation is still open where it was shared, so carry on from a copy of it.
        ...(params.resumeFork === true ? { resumeFork: true } : {}),
        resumeTitle: str(params.resumeTitle, 120) || undefined,
        resumeMessages: Number(params.resumeMessages) || undefined,
        ...(["claude", "codex", "cursor"].includes(String(params.resumeTool)) ? { resumeTool: params.resumeTool as EngineTool } : {}),
        // An explicit binary, for people whose CLI lives somewhere unusual.
        bin: str(params.bin, 600) || undefined,
        log: ctx.log ? (l) => ctx.log!(`[${sid}] ${l}`) : undefined,
      });
      await runner.start().catch(async (e) => {
        if (params.worktree) await dropWorktree(cwd);
        throw e;
      });
      const key = `${sid}|${runner.lane}`;
      ctx.runners.get(key)?.stop();
      ctx.runners.set(key, runner);
      // Connected again by itself after a deploy, a restart or a dropped network, to the same lane, until the server turns it
      // away or it is stopped here. The list always holds the current one, so Stop reaches it even while it waits to retry.
      let current = runner;
      void stayAttached(runner, (r) => {
        current = r;
        ctx.runners.set(key, r);
      }).then((end) => {
        if (ctx.runners.get(key) === current) ctx.runners.delete(key);
        // Nothing attached on this machine any more: the spare copies made for the next one go with the last.
        if (!ctx.runners.size) void dropSpares();
        // The agent removed, or its session deleted (4004): what was made on this computer for it goes too (Arun, 2026-10-25:
        // "make sure deleting sessions and stuff clears up storage on the machine too").
        if (end.code === 4004) void clearAfter(sid, cwd, { copy: !!made || !!copyOf, scratch });
      });
      // A spare copy of the folder, made in the background now the lane is there, for whoever brings a second tool to it.
      if (!params.worktree && !scratch) void primeSpares(cwd);
      // The folder's setup command, when it is set to run whenever an agent starts here (Environment): left running, in Tasks.
      if (!scratch) {
        const { setup, autoSetup } = folderSetup(cwd);
        if (autoSetup) void startBackground(cwd, setup).catch((e: Error) => ctx.log?.(`[${sid}] setup didn't start: ${e.message}`));
      }
      return {
        lane: runner.lane,
        laneName: runner.laneName,
        ...(raceBranch ? { cwd, branch: raceBranch } : {}),
        // Whether it is on the session's branch as pushed, so the person is told what came along rather than what was hoped.
        ...(runner.opts.followBranch ? { followed: runner.followed } : {}),
      };
    }
    // Running the project: only scripts it already declares, or Friday's own
    // file server for a folder of HTML. Never a command someone typed.
    // What each CLI says about its own limits, read here and shown by the page; nothing leaves the machine but the numbers.
    // One question to the person's own CLI, for the agent builder: plan mode, a scratch folder, text back.
    case "ask": {
      const tool = str(params.tool, 20) as EngineTool;
      if (!ENGINE_TOOLS.includes(tool)) throw new Error(`Pick ${toolList()}.`);
      // The answer as it is written, gathered for a moment at a time so a fast CLI is not a message per word. Whatever is
      // still gathered goes before the answer does, so the asker has every piece before the whole.
      let gathered = "";
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (gathered) ctx.progress?.({ text: gathered });
        gathered = "";
      };
      const onText = ctx.progress
        ? (chunk: string) => {
            gathered += chunk;
            timer ??= setTimeout(flush, 60);
          }
        : undefined;
      try {
        return await askCli({ tool, system: str(params.system, 40_000), prompt: str(params.prompt, 120_000), ...(str(params.model, 60) ? { model: str(params.model, 60) } : {}) }, onText);
      } finally {
        flush();
      }
    }
    case "usage":
      return readLimits();
    case "preview.options":
      return previewOptions(at(params.cwd));
    case "preview.start":
      return { preview: await startPreview(at(params.cwd), str(params.script, 40) || undefined) };
    case "preview.status":
      return { preview: await previewStatusLive(at(params.cwd)) };
    case "preview.stop":
      return { stopped: stopPreview(at(params.cwd)) };
    // What the agent left running, for the Tasks panel: what each has printed lately, and a way to stop it.
    case "background.list":
      return { tasks: listBackground(at(params.cwd)).map((t) => ({ ...t, log: t.log.slice(-30) })) };
    // Every web server running for this folder, whoever started it (ports.ts): the Preview's server menu and the
    // Environment's "running" list read this, not only what Friday itself started.
    case "servers.list":
      return { servers: await listServers(at(params.cwd)) };
    // Its stop button in the same menu.
    case "servers.stop":
      return await stopServer(at(params.cwd), Number(params.port) || 0);
    case "background.stop": {
      const stopped = await stopBackground(at(params.cwd), str(params.id, 20));
      return { task: stopped ? { ...stopped, log: stopped.log.slice(-30) } : null };
    }
    case "preview.fetch":
      return fetchPreview(Number(params.port) || 0, str(params.path, 2000) || "/", params.headers);
    case "ios.status":
      return { ios: await iosStatus(at(params.cwd)) };
    case "ios.run":
      return { build: await iosRun(at(params.cwd), { project: str(params.project, 400) || undefined, scheme: str(params.scheme, 200) || undefined, udid: str(params.udid, 60) || undefined }) };
    case "ios.stop":
      return { stopped: iosStop(at(params.cwd)) };
    case "ios.screen":
      return iosScreen(str(params.udid, 60));
    case "env.save": {
      const vars = params.vars && typeof params.vars === "object" ? (params.vars as Record<string, string | null>) : undefined;
      return { saved: saveEnvironment(at(params.cwd), { ...(typeof params.setup === "string" ? { setup: params.setup } : {}), ...(typeof params.autoSetup === "boolean" ? { autoSetup: params.autoSetup } : {}), ...(vars ? { vars } : {}) }) };
    }
    case "env.setup": {
      const cwd = at(params.cwd);
      const { setup } = folderSetup(cwd);
      if (!setup) throw new Error("There's no setup command for this folder yet.");
      const started = await startBackground(cwd, setup);
      return { task: { ...started, log: started.log.slice(-30) } };
    }
    case "ios.live":
      return iosLiveUrl(str(params.udid, 60));
    case "ios.input":
      return iosInput(str(params.udid, 60), (params.input ?? {}) as IosInput);
    case "worktree.drop":
      return { dropped: await dropWorktree(str(params.path, 600), params.force !== false) };
    case "agents.discover": {
      // The person's own agent files, and those of the folders they have worked in: nothing else is looked at.
      const roots = Array.isArray(params.roots) ? params.roots.slice(0, 12).map((r) => at(r)) : [];
      const dirs: string[] = [];
      for (const r of roots) if (await isDir(r)) dirs.push(r);
      return { found: await discoverAgentFiles(dirs) };
    }
    case "models": {
      // Cursor's list is per-account and long enough to ask it for. A tool spoken to over ACP lists its own as a conversation
      // opens, and the last list it gave is what the picker offers (see knownModels); Claude Code's, Codex's and Amp's are in it already.
      const tool = str(params.tool, 20);
      if (tool !== "cursor") return { models: (ENGINE_TOOLS as string[]).includes(tool) && ADAPTERS[tool as EngineTool].interactive && !ADAPTERS[tool as EngineTool].dialect ? await knownModels(tool as EngineTool) : [] };
      const bin = await findBin("cursor");
      if (!bin) return { models: [] };
      for (const args of [["models"], ["--list-models"]]) {
        const r = await runCli(bin, args, 15_000).catch(() => null);
        const models = r && r.code === 0 ? parseModelList(r.out) : [];
        if (models.length) return { models };
      }
      return { models: [] };
    }
    case "worktree.state":
      return { state: await worktreeState(str(params.path, 600)) };
    case "stop": {
      const key = `${str(params.sid, 64)}|${str(params.lane, 40) || "main"}`;
      const r = ctx.runners.get(key);
      if (!r) throw new Error("No agent of yours is running there.");
      r.stop();
      return { ok: true };
    }
  }
  throw new Error(`Unknown request “${method}”.`);
}
