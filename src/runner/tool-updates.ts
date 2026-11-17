import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ENGINE_NAMES, ENGINE_TOOLS, TOOL_INFO, type EngineTool } from "../types.js";
import { childEnv, findBin, launcher } from "./adapters.js";

/**
 * The coding tools Friday drives, kept up to date (Arun, 2026-11-17: "make sure Friday is able to detect outdated CLI things we are
 * driving these agents from and auto update them"). An old Claude Code or Codex misses the flags and protocol Friday speaks to it
 * with (Adapter.optional, Codex's app-server), so its turns lose features one by one without saying why.
 *
 * - Which version is installed: the tool's own `--version`.
 * - Which is newest: the npm registry, where each of these publishes (Claude Code as @anthropic-ai/claude-code, whatever installed
 *   it). A tool published nowhere Friday can ask is left alone.
 * - How to update it, the way it was installed (read from where its command really lives): npm's own global install, Homebrew's
 *   upgrade, or Claude Code's own `claude update` for its native install. Installed any other way, it says so and offers its
 *   install line instead of guessing.
 * - When: a while after Friday starts and every six hours, and only while none of that tool's turns is running, so no agent
 *   has its tool replaced under it mid-turn; one at work is tried again a little later. A version tried once and not reached
 *   (Homebrew a release behind npm, say) isn't tried again for a day. Off in Settings, it only says an update is there.
 */

/** Where its npm package is, for the newest version: the install line's own package, else the one it is published as. */
const NPM_PACKAGE: Partial<Record<EngineTool, string>> = {
  ...(Object.fromEntries(ENGINE_TOOLS.flatMap((t) => (TOOL_INFO[t]?.install?.npm ? [[t, TOOL_INFO[t].install.npm!]] : []))) as Partial<Record<EngineTool, string>>),
  claude: "@anthropic-ai/claude-code",
};

export type UpdateWay = { kind: "npm"; pkg: string; npm: string; prefix: string } | { kind: "brew"; name: string; cask: boolean; brew: string } | { kind: "self"; argv: string[] } | { kind: "manual" };

export interface ToolUpdate {
  tool: EngineTool;
  version: string | null;
  latest: string | null;
  /** How it would be updated, in words: "npm", "Homebrew", "its own updater", or "" when Friday can't. */
  how: string;
  outdated: boolean;
  /** Being updated right now. */
  updating?: boolean;
  /** Its last update, by Friday: from and to, when, and why not when it failed. */
  last?: { from: string | null; to: string | null; target: string; at: number; ok: boolean; error?: string };
}

interface Kept {
  /** Updated by itself; on unless turned off. */
  auto?: boolean;
  tools: Partial<Record<EngineTool, Pick<ToolUpdate, "version" | "latest" | "last"> & { checkedAt?: number }>>;
}

const stateDir = () => process.env.FRIDAY_STATE_DIR || path.join(homedir(), ".friday");
const keptFile = () => path.join(stateDir(), "tool-updates.json");
let kept: Kept | null = null;
async function load(): Promise<Kept> {
  if (kept) return kept;
  try {
    kept = JSON.parse(await readFile(keptFile(), "utf8")) as Kept;
    kept.tools ??= {};
  } catch {
    kept = { tools: {} };
  }
  return kept;
}
async function save(): Promise<void> {
  if (!kept) return;
  await mkdir(stateDir(), { recursive: true });
  await writeFile(keptFile(), JSON.stringify(kept, null, 2));
}

/** "codex-cli 0.166.0", "2.1.307 (Claude Code)" → "0.166.0", "2.1.307". */
export function versionIn(text: string): string | null {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(text)?.[1] ?? null;
}

/** Whether `a` is older than `b`, by their numbers (a pre-release is older than its release). */
export function older(a: string, b: string): boolean {
  const parts = (v: string) => {
    const [main, pre] = v.split("-", 2);
    return { n: main!.split(".").map((x) => Number(x) || 0), pre: pre ?? "" };
  };
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) < (y.n[i] ?? 0);
  return !!x.pre && !y.pre;
}

const run = (cmd: string, args: string[], ms: number) =>
  new Promise<{ ok: boolean; out: string }>((resolve) => {
    // npm on Windows is npm.cmd, which Node starts only through a shell; the arguments are package names and flags, nothing quoted.
    execFile(cmd, args, { timeout: ms, env: childEnv(), maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd) }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout ?? ""}${stderr ?? ""}`.trim() || (err?.message ?? "") }),
    );
  });

async function installedVersion(bin: string): Promise<string | null> {
  const l = await launcher(bin);
  const r = await run(l.command, [...l.prefix, "--version"], 15_000);
  return r.ok ? versionIn(r.out) : null;
}

/** How a tool's command was installed, from where it really lives. */
export function wayOf(tool: EngineTool, real: string, platform = process.platform): UpdateWay {
  const p = real.replace(/\\/g, "/");
  const win = platform === "win32";
  const npm = /^(.*?)\/(?:lib\/)?node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(p);
  if (npm) {
    // The npm that owns that folder: <prefix>/bin/npm (or <prefix>/npm.cmd on Windows), so it updates the copy that runs.
    const prefix = npm[1]!.replace(/\/lib$/, "");
    return { kind: "npm", pkg: npm[2]!, npm: win ? path.join(prefix, "npm.cmd") : path.join(prefix, "bin", "npm"), prefix };
  }
  const cellar = /^(.*?)\/(Cellar|Caskroom)\/([^/]+)\//.exec(p);
  if (cellar) return { kind: "brew", name: cellar[3]!, cask: cellar[2] === "Caskroom", brew: path.join(cellar[1]!, "bin", "brew") };
  if (tool === "claude") return { kind: "self", argv: ["update"] };
  return { kind: "manual" };
}

const howWords = (w: UpdateWay) => (w.kind === "npm" ? "npm" : w.kind === "brew" ? "Homebrew" : w.kind === "self" ? "its own updater" : "");

async function latestOf(tool: EngineTool): Promise<string | null> {
  const pkg = NPM_PACKAGE[tool];
  if (!pkg) return null;
  try {
    const r = await fetch(`https://registry.npmjs.org/${pkg.replace("/", "%2F")}/latest`, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
    if (!r.ok) return null;
    return versionIn(String(((await r.json()) as { version?: unknown }).version ?? ""));
  } catch {
    return null;
  }
}

async function wayFor(tool: EngineTool, bin: string): Promise<UpdateWay> {
  return wayOf(tool, await realpath(bin).catch(() => bin));
}

/** Tools being updated now, so two looks don't update one twice. */
const updating = new Set<EngineTool>();

/** Every installed tool Friday can tell about: its version, the newest, and how it would update. */
export async function checkUpdates(): Promise<ToolUpdate[]> {
  const k = await load();
  const out: ToolUpdate[] = [];
  await Promise.all(
    ENGINE_TOOLS.filter((t) => NPM_PACKAGE[t]).map(async (tool) => {
      const bin = await findBin(tool).catch(() => null);
      if (!bin) return;
      const [version, latest, way] = await Promise.all([installedVersion(bin), latestOf(tool), wayFor(tool, bin)]);
      const was = k.tools[tool];
      k.tools[tool] = { version, latest: latest ?? was?.latest ?? null, checkedAt: Date.now(), ...(was?.last ? { last: was.last } : {}) };
      const best = latest ?? was?.latest ?? null;
      out.push({ tool, version, latest: best, how: howWords(way), outdated: !!version && !!best && older(version, best), ...(updating.has(tool) ? { updating: true } : {}), ...(was?.last ? { last: was.last } : {}) });
    }),
  );
  await save();
  return out.sort((a, b) => ENGINE_TOOLS.indexOf(a.tool) - ENGINE_TOOLS.indexOf(b.tool));
}

/** Update one tool now, the way it was installed. Its new version, or why it couldn't. */
export async function updateTool(tool: EngineTool): Promise<ToolUpdate> {
  if (!ENGINE_TOOLS.includes(tool)) throw new Error("Unknown coding agent.");
  const bin = await findBin(tool);
  if (!bin) throw new Error(`${ENGINE_NAMES[tool]} isn't installed on this machine.`);
  if (updating.has(tool)) throw new Error(`${ENGINE_NAMES[tool]} is being updated already.`);
  const way = await wayFor(tool, bin);
  if (way.kind === "manual") throw new Error(`${ENGINE_NAMES[tool]} wasn't installed in a way Friday can update. Its install line updates it.`);
  const k = await load();
  const from = await installedVersion(bin);
  const target = (await latestOf(tool)) ?? "latest";
  updating.add(tool);
  try {
    const r =
      way.kind === "npm"
        ? await (async () => {
            // Into the folder it runs from (--prefix), with that folder's own npm when it has one, else the one on the PATH: never
            // into whichever global folder the PATH's npm happens to use.
            const args = ["install", "-g", "--prefix", way.prefix, `${way.pkg}@latest`, "--no-audit", "--no-fund"];
            const own = await run(way.npm, args, 10 * 60_000);
            return own.ok || !/ENOENT|not found|not recognized/i.test(own.out) ? own : run(process.platform === "win32" ? "npm.cmd" : "npm", args, 10 * 60_000);
          })()
        : way.kind === "brew"
          ? await run(way.brew, ["upgrade", ...(way.cask ? ["--cask"] : []), way.name], 10 * 60_000)
          : await (async () => {
              const l = await launcher(bin);
              return run(l.command, [...l.prefix, ...way.argv], 10 * 60_000);
            })();
    const to = await installedVersion((await findBin(tool)) ?? bin);
    const ok = r.ok && !!to && (!from || to !== from || target === to);
    const error = ok ? undefined : r.ok ? `${howWords(way)} finished, but ${ENGINE_NAMES[tool]} is still ${to ?? "the same version"}.` : r.out.split("\n").filter(Boolean).slice(-3).join("\n").slice(0, 400);
    const last = { from, to, target, at: Date.now(), ok, ...(error ? { error } : {}) };
    k.tools[tool] = { ...k.tools[tool], version: to, latest: target === "latest" ? (k.tools[tool]?.latest ?? null) : target, last };
    await save();
    return { tool, version: to, latest: k.tools[tool]!.latest ?? null, how: howWords(way), outdated: !!to && target !== "latest" && older(to, target), last };
  } finally {
    updating.delete(tool);
  }
}

export async function autoUpdates(): Promise<boolean> {
  return (await load()).auto !== false;
}
export async function setAutoUpdates(on: boolean): Promise<void> {
  const k = await load();
  k.auto = on;
  await save();
}

/**
 * Updates by itself, when on: a while after Friday starts, then every six hours. A tool whose turn is running (`busy`) waits and
 * is tried again in ten minutes; a version tried and not reached waits a day.
 */
export function startToolUpdates(o: { busy: (tool: EngineTool) => boolean; log: (line: string) => void; firstMs?: number; everyMs?: number }): () => void {
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, f: () => void) => {
    const t = setTimeout(() => (timers.delete(t), stopped || f()), ms);
    t.unref?.();
    timers.add(t);
  };
  const pass = async () => {
    try {
      if (!(await autoUpdates())) return;
      const k = await load();
      for (const u of await checkUpdates()) {
        if (!u.outdated || !u.how || !u.latest) continue;
        const tried = k.tools[u.tool]?.last;
        if (tried && tried.target === u.latest && Date.now() - tried.at < 24 * 3_600_000) continue;
        if (o.busy(u.tool)) {
          later(10 * 60_000, () => void pass());
          continue;
        }
        o.log(`updating ${ENGINE_NAMES[u.tool]} ${u.version} → ${u.latest} with ${u.how}`);
        const r = await updateTool(u.tool).catch((e: Error) => ({ last: { ok: false, error: e.message } }) as Pick<ToolUpdate, "last">);
        o.log(r.last?.ok ? `${ENGINE_NAMES[u.tool]} is now ${r.last.to}` : `${ENGINE_NAMES[u.tool]} wasn't updated: ${r.last?.error ?? "no reason given"}`);
      }
    } catch (e) {
      o.log(`couldn't look for coding tool updates: ${(e as Error).message}`);
    }
  };
  later(o.firstMs ?? 2 * 60_000, function again() {
    void pass().finally(() => later(o.everyMs ?? 6 * 3_600_000, again));
  });
  return () => {
    stopped = true;
    for (const t of timers) clearTimeout(t);
  };
}
