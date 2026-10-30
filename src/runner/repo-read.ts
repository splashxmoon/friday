import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EngineMode, RepoCall } from "../types.js";
import { contains, folderKey } from "../folder-key.js";
import { childEnv } from "./adapters.js";
import { previewCommand, previewStatusLive, startPreview } from "./preview.js";
import { iosCommand, iosRun, iosStatus } from "./ios.js";
import { describeEnvironment, folderVars } from "./environment.js";
import { killTree, NON_INTERACTIVE, readBackground, shellLine, startBackground, stopBackground } from "./background.js";
import { applyPatch, branchesOf, checkpoint, commitAll, compareOf, diffTrees, discardFiles, gitDiffOf, logOf, prFailures, prFeedback, prStatusJson, publish, pullOf, remoteOf, restore, showOf, stageFiles, statusOf, switchTo, unstageFiles } from "./git.js";

/**
 * Reading the folder a coding agent is working in, for everyone else.
 *
 * The CLI on someone's machine can see the repo. Friday's own agent cannot —
 * it runs on a server that has never seen those files — so asking it to write
 * anything *about* the code produced a polite request for the code. The runner
 * is already connected and already has the folder open, so it answers these
 * three questions on the room's behalf.
 *
 * Confined to the folder the runner was pointed at, and to the mode its host
 * chose for this machine: `plan` reads, `edits` also writes files, and `full`
 * also runs commands. The mode is the one already shown in the session header
 * and already governing the CLI, so the room's agent gets exactly the reach
 * the host granted -- not more because it asked from a different direction.
 */

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".venv", "venv", "__pycache__", "target", ".turbo", ".cache", "coverage", "vendor", ".friday"]);
const MAX_FILES = 600;
const MAX_BYTES = 120_000;
const MAX_MATCHES = 80;
/** Text-ish by extension: reading a binary back as UTF-8 helps nobody. */
const TEXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|ya?ml|toml|ini|cfg|conf|log|html?|css|scss|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|graphql|prisma|env|lock|gitignore|dockerfile|makefile)$/i;
const NAMED = /^(dockerfile|makefile|readme|license|\.gitignore|\.env\.example)$/i;

const readable = (name: string) => TEXT.test(name) || NAMED.test(name);

/**
 * A path inside `root`, or nothing. Judged by where it really is: `..`, and a
 * symlink inside the folder pointing out of it (or a linked parent folder for
 * a file that doesn't exist yet), both land outside.
 * ponytail: checked, then used; a link swapped in between the two still wins. Opening with O_NOFOLLOW per segment closes that.
 */
function within(root: string, rel: string): string | null {
  const full = path.resolve(root, rel || ".");
  if (!contains(root, full)) return null;
  // Friday's own state on this computer (your models and their keys among it) is never an agent's to read, even in a
  // home folder, whatever case it is spelled in and whatever link leads to it.
  const segs = [...path.relative(root, full).split(path.sep), ...folderKey(full).slice(folderKey(root).length).split("/")];
  if (segs.some((s) => s.toLowerCase() === ".friday")) return null;
  return full;
}

/**
 * Secrets stay secret by default. A `.env` shows which variables it sets,
 * never their values; key files and package-registry logins aren't read at
 * all. Coding CLIs on the host's machine are their own business.
 */
const ENV = /^\.env(\..+)?$/i;
const ENV_SAMPLE = /^\.env\.(example|sample|template)$/i;
const CREDS = /(\.pem|\.key)$|^id_rsa|^id_ed25519|^\.(npmrc|pypirc|netrc)$/i;
const CREDS_WORDS = "That file holds credentials, so Friday's agent doesn't read it.";
/** By the name asked for and the name it really has, so a link called notes.txt doesn't open the .env behind it. */
const names = (file: string) => [path.basename(file), path.basename(folderKey(file))];
const secretEnv = (file: string) => names(file).some((n) => ENV.test(n) && !ENV_SAMPLE.test(n));
const credentials = (file: string) => names(file).some((n) => CREDS.test(n));

/** Each variable a .env sets, by the line it starts on: comments and the inside of multi-line values aren't variables, and can hold secrets too. */
function envVars(text: string): Map<number, string> {
  const out = new Map<number, string>();
  let quote = "";
  text.split(/\r?\n/).forEach((line, i) => {
    if (quote) {
      if (line.includes(quote)) quote = "";
      return;
    }
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/);
    if (!m) return;
    out.set(i + 1, m[1]!);
    const v = m[2]!.trim();
    if ((v[0] === '"' || v[0] === "'") && !v.slice(1).includes(v[0])) quote = v[0];
  });
  return out;
}
/** `KEY=<hidden>` for every variable a .env sets, and nothing else. */
const envNames = (text: string) => [...envVars(text).values()].map((n) => `${n}=<hidden>`).join("\n");

export type RepoOp = RepoCall["op"];
/** What each op needs the host to have allowed. Anything above it is refused. */
const NEEDS: Record<RepoOp, EngineMode> = { tree: "plan", read: "plan", search: "plan", write: "edits", edit: "edits", shell: "full", checkpoint: "edits", restore: "edits", commit: "edits", publish: "full", remote: "plan", branches: "plan", switch: "edits", prcomments: "plan", prstatus: "plan", prchecks: "plan", preview: "full", ios: "full", environment: "plan", context: "plan", bgstart: "full", bgread: "plan", bgstop: "plan", diff: "plan", commands: "plan", terminal: "plan", apply: "edits", status: "plan", log: "plan", show: "plan", gitdiff: "plan", compare: "plan", stage: "edits", unstage: "edits", hunk: "edits", discard: "edits", pull: "edits" };
const RANK: Record<EngineMode, number> = { plan: 0, edits: 1, full: 2 };

export interface RepoRequest extends RepoCall {
  /** What the host allowed. Absent means the cautious end of the scale. */
  mode?: EngineMode;
  /**
   * This folder is not the person's own machine.
   *
   * On a linked machine a command should see the environment its owner has,
   * because that is the point — their toolchain, their PATH, their tokens.
   * An uploaded folder runs on Friday's server, where the environment holds
   * Friday's own secrets, and `env` is a one-line command. So that case gets
   * a built environment rather than this process's.
   */
  isolate?: boolean;
}

export async function readRepo(root: string, req: RepoRequest): Promise<string> {
  const base = path.resolve(root);
  const mode = req.mode ?? "plan";
  // A command a person approved on a Manual machine runs there, and so does a push they pressed for: "Commit and push" is
  // the same yes as a permission card. An uploaded folder, which is Friday's own server, never takes that road.
  // A preview is asked about first (below), so on a Manual machine it is let as far as the question.
  const need = ((req.op === "shell" || req.op === "bgstart" || req.op === "publish") && req.approved) || req.op === "preview" || req.op === "ios" ? (req.isolate ? NEEDS[req.op] : "edits") : NEEDS[req.op];
  if (need === undefined) return "Unknown request.";
  if (RANK[mode] < RANK[need]) {
    return need === "full"
      ? `This machine is connected in "${MODE_WORDS[mode]}" mode, so commands can't be run on it. Its host can change that in the session header.`
      : `This machine is connected in "${MODE_WORDS[mode]}" mode, so files can't be changed on it. Its host can change that in the session header.`;
  }
  // A folder lent without a coding tool has none of a tool's own commands (a runner with one answers this itself).
  if (req.op === "commands") return JSON.stringify({ commands: [] });
  // A folder lent with no coding tool of its own has no conversation to carry on (the runner's own answers it otherwise).
  if (req.op === "terminal") return JSON.stringify({ error: "There's no coding tool here to open in a terminal." });
  if (req.op === "tree") return tree(base, req.path ?? "");
  if (req.op === "read") return read(base, req.path ?? "", req.offset ?? 0, !!req.raw, !!req.person);
  if (req.op === "search") return search(base, req.query ?? "", req.path ?? "");
  if (req.op === "write") return write(base, req.path ?? "", req.content ?? "");
  if (req.op === "edit") return edit(base, req.path ?? "", req.find ?? "", req.content ?? "");
  if (req.op === "remote") return JSON.stringify(await remoteOf(base));
  if (req.op === "branches") return JSON.stringify(await branchesOf(base).catch((e: Error) => ({ error: e.message })));
  if (req.op === "preview") {
    try {
      // On a Manual machine the dev server is a command like any other: say exactly what would run (the install
      // included), and run it only once a person has said yes to that. Serving a folder of HTML, or showing a server
      // already running, runs nothing new and isn't asked about.
      if (RANK[mode] < RANK.full) {
        const would = await previewCommand(base, req.query || undefined);
        if (would && !(req.approved && req.command === would)) return JSON.stringify({ needsApproval: would });
      }
      // On Friday's own server (an uploaded folder) nothing the project declares
      // is run: files are served, and that is all.
      // Installing and booting can take minutes. Answer within a few seconds
      // either way: with the server, or with "still starting", which the
      // Preview panel and a second call both pick up as it comes up.
      const started = startPreview(base, req.query || undefined, undefined, !!req.isolate, { install: true });
      const first = await Promise.race([started, new Promise<"slow">((r) => setTimeout(() => r("slow"), 15_000))]);
      if (first === "slow") {
        started.catch(() => {});
        const now = await previewStatusLive(base);
        if (now) return JSON.stringify({ preview: { url: now.url, port: now.port, command: now.command, ready: false, stage: now.stage, log: now.log.slice(-6) } });
        return JSON.stringify({ error: "The preview didn't come up. Run it once yourself to see why." });
      }
      const info = first;
      return JSON.stringify({ preview: { url: info.url, port: info.port, command: info.command, ready: info.ready, stage: info.stage, log: info.log.slice(-6) } });
    } catch (e) {
      return JSON.stringify({ error: (e as Error).message });
    }
  }
  // The session's environment, as its Environment button shows it (environment.ts): the machine, the toolchain, variable names.
  if (req.op === "environment") {
    if (req.isolate) return JSON.stringify({ error: "This session works in a folder uploaded to Friday, not on a computer of its own." });
    return JSON.stringify({ environment: await describeEnvironment(base) });
  }
  if (req.op === "ios") {
    // An iOS app, on the Mac this folder is on: built for a simulator and run there (ios.ts), and shown in the Preview
    // panel's iOS side. Like a dev server, a build on a Manual machine is put to a person first, as the command it is.
    if (req.isolate) return JSON.stringify({ error: "iOS apps are built on a Mac with Xcode. Connect one to this session." });
    try {
      const now = (await iosStatus(base)).build;
      // Asked while a build is still going: how far it has got, rather than a second build over the first.
      const going = !!now && ["booting", "building", "installing", "launching"].includes(now.stage);
      if (req.query === "status" || going) return JSON.stringify({ ios: now ? { ...now, log: now.log.slice(-8) } : null });
      if (RANK[mode] < RANK.full) {
        const would = await iosCommand(base);
        if (would && !(req.approved && req.command === would)) return JSON.stringify({ needsApproval: would });
      }
      await iosRun(base, {});
      // A build takes from seconds to minutes: answer with how far it got in the first 20, and status says the rest.
      const t0 = Date.now();
      let b = (await iosStatus(base)).build;
      while (b && ["booting", "building", "installing", "launching"].includes(b.stage) && Date.now() - t0 < 20_000) {
        await new Promise((r) => setTimeout(r, 1000));
        b = (await iosStatus(base)).build;
      }
      return JSON.stringify({ ios: b ? { ...b, log: b.log.slice(-8) } : null });
    } catch (e) {
      return JSON.stringify({ error: (e as Error).message });
    }
  }
  if (req.op === "bgstart" || req.op === "bgread" || req.op === "bgstop") {
    // Commands that outlive their request are for the person's own machine. Friday's server is shared, and a process left running on it is nobody's to hand out.
    if (req.isolate) return JSON.stringify({ error: "Background commands aren't started on Friday's server. Connect a machine to this session to run them there." });
    try {
      if (req.op === "bgstart") return JSON.stringify({ background: await startBackground(base, req.command ?? "") });
      const info = req.op === "bgread" ? readBackground(base, req.query ?? "", req.offset || 80) : await stopBackground(base, req.query ?? "");
      return JSON.stringify(info ? { background: info } : { error: `There's no background command ${req.query ?? ""}. They are listed in the Tasks panel.` });
    } catch (e) {
      return JSON.stringify({ error: (e as Error).message });
    }
  }
  if (req.op === "prcomments") return JSON.stringify(await prFeedback(base, req.query ?? ""));
  if (req.op === "prstatus") return JSON.stringify(await prStatusJson(base, req.query ?? ""));
  if (req.op === "prchecks") return JSON.stringify(await prFailures(base, req.query ?? ""));
  if (req.op === "checkpoint") return (await checkpoint(base, req.query ?? "run")) ?? "";
  // What is not yet committed, against HEAD or a checkpoint: the change a run made, to show and to review. Only reads.
  // The Git panel's reads and moves (git.ts), each answering in JSON so a refusal reaches the person as its reason.
  if (req.op === "status" || req.op === "log" || req.op === "show" || req.op === "gitdiff" || req.op === "compare" || req.op === "stage" || req.op === "unstage" || req.op === "discard" || req.op === "hunk" || req.op === "pull") {
    try {
      if (req.op === "status") return JSON.stringify(await statusOf(base));
      if (req.op === "log") return JSON.stringify({ commits: await logOf(base, req.limit ?? 30, req.path || undefined) });
      if (req.op === "show" || req.op === "gitdiff") {
        const files = req.op === "show" ? await showOf(base, req.ref ?? "") : await gitDiffOf(base, !!req.staged, req.path || undefined);
        return JSON.stringify({ files: [...files], ...(files.more ? { more: files.more } : {}) });
      }
      if (req.op === "compare") return JSON.stringify(await compareOf(base, req.ref ?? ""));
      if (req.op === "stage") return JSON.stringify(await stageFiles(base, req.paths ?? []));
      if (req.op === "unstage") return JSON.stringify(await unstageFiles(base, req.paths ?? []));
      if (req.op === "discard") return JSON.stringify(await discardFiles(base, req.paths ?? [], !!req.untracked));
      if (req.op === "hunk") return JSON.stringify(await applyPatch(base, req.patch ?? "", { cached: !!req.cached, reverse: !!req.reverse }));
      return JSON.stringify(await pullOf(base));
    } catch (e) {
      return JSON.stringify({ error: (e as Error).message });
    }
  }
  if (req.op === "diff") {
    const ref = req.ref && /^[0-9a-f]{40}$/.test(req.ref) ? req.ref : "HEAD";
    try {
      const files = await diffTrees(base, ref);
      return JSON.stringify({ base: ref, files, ...(files.more ? { more: files.more } : {}) });
    } catch (e) {
      return JSON.stringify({ error: (e as Error).message });
    }
  }
  // Git operations answer in JSON either way, so a refusal ("nothing to
  // commit") reaches the person as the reason, wherever the folder lives.
  if (req.op === "restore" || req.op === "commit" || req.op === "publish" || req.op === "switch") {
    try {
      if (req.op === "restore") return JSON.stringify(await restore(base, req.ref ?? "", req.until));
      if (req.op === "switch") return JSON.stringify(await switchTo(base, req.branch ?? "", !!req.create));
      if (req.op === "commit") return JSON.stringify(await commitAll(base, req.message ?? "", req.branch || undefined, req.only));
      const [title, ...rest] = (req.message ?? "").split("\n");
      return JSON.stringify(await publish(base, { pr: !!req.pr, title: title ?? "", body: rest.join("\n").trim(), ...(req.base ? { base: req.base } : {}) }));
    } catch (e) {
      return JSON.stringify({ error: (e as Error).message });
    }
  }
  return shell(base, req.command ?? "", !!req.isolate, req.timeoutSec);
}

const MODE_WORDS: Record<EngineMode, string> = { plan: "Plan", edits: "Manual", full: "Auto" };

async function walk(base: string, dir: string, out: string[], depth: number, max = MAX_FILES): Promise<void> {
  if (out.length >= max || depth < 0) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries.sort((a, b) => Number(a.isDirectory()) - Number(b.isDirectory()) || a.name.localeCompare(b.name))) {
    if (out.length >= max) return;
    if (SKIP.has(e.name) || (e.name.startsWith(".") && e.name !== ".env.example")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(base, full, out, depth - 1, max);
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
}

async function tree(base: string, rel: string): Promise<string> {
  const dir = within(base, rel);
  if (!dir) return "That path is outside the folder this agent is working in.";
  const files: string[] = [];
  await walk(base, dir, files, 8);
  if (!files.length) return "(no files)";
  const more = files.length >= MAX_FILES ? `\n\n[listing stopped at ${MAX_FILES} files]` : "";
  return `${files.length} files under ${rel || "the repository root"}:\n${files.join("\n")}${more}`;
}

async function read(base: string, rel: string, offset: number, raw = false, person = false): Promise<string> {
  const file = within(base, rel);
  if (!file) return "That path is outside the folder this agent is working in.";
  const s = await stat(file).catch(() => null);
  if (!s) return `There's no file at ${rel}.`;
  if (s.isDirectory()) return tree(base, rel);
  if (credentials(file)) return CREDS_WORDS;
  if (secretEnv(file) && !person) {
    const vars = envNames(await readFile(file, "utf8").catch(() => ""));
    return `${rel} sets these variables (values are hidden from Friday's agent):\n${vars || "(none)"}`;
  }
  if (!readable(path.basename(file))) return `${rel} isn't a text file, so there's nothing useful to read.`;
  const text = await readFile(file, "utf8").catch(() => "");
  // An editor needs the bytes, not a rendering of them: no header, no numbers.
  if (raw) return text;
  const lines = text.split("\n");
  const from = Math.max(0, offset);
  const slice: string[] = [];
  let bytes = 0;
  for (let i = from; i < lines.length && bytes < MAX_BYTES; i++) {
    slice.push(`${i + 1}\t${lines[i]}`);
    bytes += (lines[i]?.length ?? 0) + 1;
  }
  const shown = from + slice.length;
  const tail = shown < lines.length ? `\n\n[${lines.length - shown} more lines; read again with offset ${shown}]` : "";
  return `${rel} (${lines.length} lines)\n${slice.join("\n")}${tail}`;
}

/**
 * git's own search: a repository of any size, indexed, ignoring what its
 * .gitignore ignores. Null when this isn't a repository or git can't run it,
 * so the caller can look at the files itself.
 */
function gitSearch(base: string, rel: string, query: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      // -z: names come NUL-separated and never C-quoted, so "donn\303\251es/.env" can't slip past the filters below.
      ["grep", "-z", "--untracked", "-n", "-I", "-i", "-F", "--no-color", "-e", query, "--", rel || "."],
      { cwd: base, timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        const code = (err as (Error & { code?: unknown }) | null)?.code;
        // 1 is "no matches"; anything else that failed means git couldn't answer.
        if (err && code !== 1 && !(stdout && String(stdout).length)) return resolve(code === 1 ? [] : null);
        resolve(
          String(stdout)
            .split("\n")
            .filter(Boolean)
            .slice(0, MAX_MATCHES)
            .flatMap((l) => {
              const m = l.match(/^([^\0]*)\0(\d+)\0(.*)$/);
              // A line we can't read as name, line, text is dropped: the filters below need the file it came from.
              return m ? [`${m[1]}:${m[2]}: ${m[3]!.trim().slice(0, 200)}`] : [];
            }),
        );
      },
    );
  });
}

/** How far a search through plain files goes: a lot of files, a fair time, and nothing huge. */
const SEARCH_FILES = 25_000;
const SEARCH_MS = 8_000;
const SEARCH_MAX_BYTES = 1_000_000;

async function search(base: string, query: string, rel: string): Promise<string> {
  if (!query.trim()) return "Give something to search for.";
  const dir = within(base, rel);
  if (!dir) return "That path is outside the folder this agent is working in.";
  const relPath = path.relative(base, dir).split(path.sep).join("/");
  const hits: string[] = (await gitSearch(base, relPath, query)) ?? [];
  // Files left unread when time ran out, and how many there were: a search that stopped early says so, rather than
  // answering "no matches" as if it had looked everywhere, which told an agent something wasn't there when it was.
  let unread = 0;
  let total = 0;
  if (!hits.length) {
    // Not a repository (or git had nothing): look at the files, as far as time allows.
    const files: string[] = [];
    await walk(base, dir, files, 12, SEARCH_FILES);
    const wanted = files.filter((f) => readable(path.basename(f)));
    total = wanted.length;
    // A plain substring, case-insensitive: the agent asked for a string, not a
    // regex, and a regex it wrote badly would fail in ways it can't see.
    const needle = query.toLowerCase();
    const until = Date.now() + SEARCH_MS;
    // Sixteen at a time: one by one, a thousand small files on a busy machine took longer than the time allowed.
    const found = new Map<number, string[]>();
    let next = 0;
    let count = 0;
    const worker = async () => {
      while (next < wanted.length && count < MAX_MATCHES && Date.now() <= until) {
        const at = next++;
        const f = wanted[at]!;
        const full = path.join(base, f);
        // A link in the folder to a file outside it is listed, never opened.
        if (!within(base, f)) continue;
        if (((await stat(full).catch(() => null))?.size ?? 0) > SEARCH_MAX_BYTES) continue;
        const text = await readFile(full, "utf8").catch(() => "");
        if (!text.toLowerCase().includes(needle)) continue;
        const lines: string[] = [];
        text.split("\n").forEach((line, i) => {
          if (line.toLowerCase().includes(needle)) lines.push(`${f}:${i + 1}: ${line.trim().slice(0, 200)}`);
        });
        found.set(at, lines);
        count += lines.length;
      }
    };
    await Promise.all(Array.from({ length: 16 }, worker));
    // Unread for want of time: stopping at enough matches is said as that, below.
    unread = count >= MAX_MATCHES ? 0 : wanted.length - next;
    // In the files' own order, whichever finished first.
    for (const at of [...found.keys()].sort((a, b) => a - b)) hits.push(...found.get(at)!);
    hits.splice(MAX_MATCHES);
  }
  // Whichever way the matches were found: a .env match shows only a variable name it matched on, a key file nothing.
  // A hit counts only on a line that starts a variable, judged against the whole file: a line inside a quoted
  // multi-line value (a key's base64 ending in "=") looks like NAME=..., and isn't one.
  const vars = new Map<string, Map<number, string>>();
  const shown: string[] = [];
  for (const h of hits) {
    const m = h.match(/^(.*?):(\d+): (.*)$/);
    // Fail closed: a hit whose file can't be named and found is not shown.
    if (!m) continue;
    const full = path.join(base, m[1]!);
    if (!within(base, m[1]!) || credentials(full)) continue;
    if (!(await stat(full).catch(() => null))?.isFile()) continue;
    if (!secretEnv(full)) { shown.push(h); continue; }
    if (!vars.has(full)) vars.set(full, envVars(await readFile(full, "utf8").catch(() => "")));
    const name = vars.get(full)!.get(Number(m[2]));
    if (name && name.toLowerCase().includes(query.toLowerCase())) shown.push(`${m[1]}:${m[2]}: ${name}=<hidden>`);
  }
  hits.splice(0, hits.length, ...shown);
  const partial = unread > 0 ? `${total - unread} of ${total} files searched before the time ran out (${SEARCH_MS / 1000}s); search a narrower path for the rest` : "";
  if (!hits.length) return partial ? `No matches for "${query}" in the ${partial}.` : `No matches for "${query}".`;
  const more = hits.length >= MAX_MATCHES ? `\n\n[stopped at ${MAX_MATCHES} matches]` : partial ? `\n\n[${partial}]` : "";
  return `${hits.length} matches for "${query}":\n${hits.join("\n")}${more}`;
}

const MAX_WRITE = 400_000;

/** Why the agent may not change an existing .env: it can't see the values, so any change would be blind. */
const envHands = (rel: string) =>
  `Friday's agent can't see the values in ${rel}, so it doesn't change that file. Ask a person in the room to make the change on the host's machine.`;

async function write(base: string, rel: string, content: string): Promise<string> {
  const file = within(base, rel);
  if (!file) return "That path is outside the folder this agent is working in.";
  if (!rel.trim()) return "Which file?";
  if (credentials(file)) return CREDS_WORDS;
  if (content.length > MAX_WRITE) return `That's ${content.length} characters; write at most ${MAX_WRITE} in one go.`;
  const before = await readFile(file, "utf8").catch(() => null);
  // Overwriting would wipe values the agent never saw; a brand-new .env holds nothing to lose.
  if (before !== null && secretEnv(file)) return envHands(rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  const lines = content.split("\n").length;
  return before === null ? `Created ${rel} (${lines} lines).` : `Rewrote ${rel} (${lines} lines, was ${before.split("\n").length}).`;
}

/**
 * Replace one exact stretch of a file.
 *
 * Exactly once, or not at all: a `find` that matches twice is a sign the agent
 * did not read enough context to know which one it meant, and guessing there
 * silently corrupts the other. It gets told, and can widen the match.
 */
async function edit(base: string, rel: string, find: string, replace: string): Promise<string> {
  const file = within(base, rel);
  if (!file) return "That path is outside the folder this agent is working in.";
  if (credentials(file)) return CREDS_WORDS;
  // Whether find matched would answer yes or no about a hidden value, one guessed character at a time.
  if (secretEnv(file)) return envHands(rel);
  if (!find) return "Give the exact text to replace. To create or overwrite a whole file, use write_file.";
  const before = await readFile(file, "utf8").catch(() => null);
  if (before === null) return `There's no file at ${rel}.`;
  const first = before.indexOf(find);
  if (first === -1) return `That text isn't in ${rel}. Read the file and copy the lines exactly, whitespace included.`;
  if (before.indexOf(find, first + 1) !== -1) {
    return `That text appears more than once in ${rel}. Include enough surrounding lines to pick out the one you mean.`;
  }
  await writeFile(file, before.slice(0, first) + replace + before.slice(first + find.length), "utf8");
  return `Edited ${rel} at line ${before.slice(0, first).split("\n").length}.`;
}

/**
 * How long a command may run, in seconds: two minutes unless the agent asks for longer, and thirty minutes at most (raised
 * from ten, 2026-10-18: a full build, an Xcode archive or a long test run on somebody's own machine takes that).
 */
export const SHELL_SECONDS = 120;
export const MAX_SHELL_SECONDS = 1800;
export const shellSeconds = (asked?: number): number => Math.min(MAX_SHELL_SECONDS, Math.max(10, Math.round(Number(asked) || SHELL_SECONDS)));
/**
 * What of a command's output comes back: the start, and the end, which is
 * where a test summary or the last compiler error is. The middle of a long
 * output is what matters least, so that is what is left out.
 */
const HEAD = 8_000;
const TAIL = 52_000;

/**
 * The environment a command gets when the folder is not somebody's machine.
 *
 * Built up rather than filtered down. A denylist of secret-looking names is
 * a list somebody has to remember to add to, and the first variable anybody
 * forgets is the one that matters; this way a new secret in the server's
 * environment is absent from here without anyone doing anything.
 *
 * It keeps the keys out of the command's own environment, and that is all it
 * does. It is not a boundary: on Linux a process running as the same user can
 * read /proc/<server pid>/environ, and any file the server can read is open to
 * it too, the server's own .env and every other session's folder included.
 * That is why commands on uploaded folders stay off (see uploaded.ts).
 *
 * HOME points at the folder, so a tool that writes a cache or a config file
 * writes it inside the thing that is about to be thrown away.
 */
function isolatedEnv(base: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: base,
    TMPDIR: path.join(base, ".tmp"),
    LANG: process.env.LANG ?? "en_US.UTF-8",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

/** Commands running now. Detached into their own process group, they would outlive the runner and its time limit. */
const live = new Set<ChildProcess>();
// On exit only, as for background commands: a signal handler here would change how whatever imports this shuts down.
process.once("exit", () => {
  // On Windows not a shell that has already exited: its PID may be someone else's by now (see the leftover below).
  for (const c of live) if (process.platform !== "win32" || c.exitCode === null) killTree(c, "SIGKILL");
});

/**
 * Run a command in the folder, and say what happened.
 *
 * Through the machine's own shell, because the point is to run the things
 * people actually run -- pipes, `&&`, npm scripts -- not a curated subset. The
 * gate is the host's mode, not a list of blessed binaries: a blocklist here
 * would give the false impression of a sandbox while `sh -c` sits behind it.
 *
 * With the same environment as a background command and the coding CLIs, so
 * a tool one of them finds this finds too. Its input is closed and nothing it
 * starts may prompt. However much it prints, it runs to the end: only the
 * time limit stops it, and then everything it started stops with it.
 *
 * Every answer is a transcript: `$ command`, then `(exited N)` or `(timed out
 * …)`, then the output. Anything else is a refusal, and is read as one.
 */
async function shell(base: string, command: string, isolate = false, timeoutSec?: number): Promise<string> {
  if (!command.trim()) return "Give a command to run.";
  // Friday's own server keeps the plain two minutes, whatever is asked.
  const secs = isolate ? SHELL_SECONDS : shellSeconds(timeoutSec);
  const { bin, args } = shellLine(command);
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: base,
      windowsHide: true,
      // Its own process group, so the time limit stops what it started too.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      // On someone's own machine, the folder's own variables too (Environment); never on Friday's server.
      env: { ...(isolate ? isolatedEnv(base) : { ...childEnv(), ...folderVars(base) }), ...NON_INTERACTIVE, NO_COLOR: "1", CI: "1" },
    });
    live.add(child);
    let head = "";
    let tail = "";
    let dropped = 0;
    let timedOut = false;
    const take = (d: string) => {
      if (head.length < HEAD) {
        const room = HEAD - head.length;
        head += d.slice(0, room);
        d = d.slice(room);
      }
      tail += d;
      if (tail.length > TAIL * 2) {
        dropped += tail.length - TAIL;
        tail = tail.slice(-TAIL);
      }
    };
    child.stdout?.setEncoding("utf8").on("data", take);
    child.stderr?.setEncoding("utf8").on("data", take);
    const timer = setTimeout(() => {
      timedOut = true;
      // Politely first, as stopBackground does: git removes its lock files on SIGTERM and can't on SIGKILL, and a
      // .git/index.lock left behind stops every git command after it. Then not politely. On Windows taskkill /F has
      // already been used, so only while the shell is still there: once it has exited, its PID may be someone else's.
      killTree(child, "SIGTERM");
      setTimeout(() => (process.platform !== "win32" || child.exitCode === null) && killTree(child, "SIGKILL"), 3000).unref();
    }, secs * 1000);
    // Something it left running in the background (`server &`) keeps the output open after the shell has gone, and the
    // answer would wait on it for ever. A moment for the last of the output, then it is stopped with the rest and the
    // answer is given.
    // ponytail: on Windows a tree can't be walked from a parent that has gone, so what was left running there only ends
    // the next time it writes to the closed output; a job object per command would catch the rest. Nor is taskkill
    // sent: the shell's PID is free by now and may already be another process's.
    let leftover: NodeJS.Timeout | undefined;
    child.once("exit", () => {
      leftover = setTimeout(() => {
        if (process.platform !== "win32") killTree(child, "SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 1000);
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      live.delete(child);
      resolve(`$ ${command}
(exited ${(err as NodeJS.ErrnoException).code ?? 1})
Couldn't start the shell: ${err.message}`);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(leftover);
      live.delete(child);
      if (tail.length > TAIL) {
        dropped += tail.length - TAIL;
        tail = tail.slice(-TAIL);
      }
      const body = (dropped ? `${head}\n\n[${dropped} characters left out of the middle]\n\n${tail}` : head + tail).trimEnd();
      const status = timedOut ? `timed out after ${secs}s, and it was stopped along with everything it started` : `exited ${code ?? signal ?? 1}`;
      resolve(`$ ${command}
(${status})
${body || "(no output)"}`);
    });
  });
}
