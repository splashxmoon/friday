import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { childEnv, formatCommandLine, nodeForScripts } from "./adapters.js";

/**
 * "Other ACP agent", picked from the ACP registry (Arun, 2026-11-10: "ensure everything is stable and ready", after T3 Code,
 * which installs any agent the registry lists). The registry (agentclientprotocol.com) names each agent's exact version and how it
 * comes: an npm package, a download for each platform with its SHA-256, or a Python package for uvx. Friday installs it into a
 * folder of its own (~/.friday/agents/<id>/<version>), checks a download against its SHA-256 before anything in it runs, and
 * sets the command that starts it, the same as one typed in. Nothing global is installed.
 */
export const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

type Binary = { archive: string; cmd: string; args?: string[]; sha256?: string };
export interface RegistryAgent {
  id: string;
  name: string;
  version: string;
  description?: string;
  website?: string;
  repository?: string;
  distribution: { npx?: { package: string; args?: string[] }; binary?: Record<string, Binary>; uvx?: { package: string; args?: string[] } };
}
export type RegistryRow = { id: string; name: string; version: string; description: string; how: "npm" | "download" | "uvx"; website?: string };

/** This computer as the registry names platforms: darwin-aarch64, linux-x86_64, windows-x86_64. */
export function platformKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const os = platform === "win32" ? "windows" : platform;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;
  return `${os}-${cpu}`;
}

/** How an agent can be put on this computer: a download for it first (no Node or Python needed), then npm, then uvx. */
export function howFor(a: RegistryAgent, key = platformKey()): RegistryRow["how"] | null {
  if (a.distribution?.binary?.[key]?.archive) return "download";
  if (a.distribution?.npx?.package) return "npm";
  if (a.distribution?.uvx?.package) return "uvx";
  return null;
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const safeId = (id: string) => /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id);

let cached: { at: number; agents: RegistryAgent[] } | null = null;
const cacheFile = () => path.join(homedir(), ".friday", "acp-registry.json");

/** The registry's agents: fetched at most once an hour, the last copy kept on disk for when it can't be reached. */
export async function registryAgents(fetchImpl: typeof fetch = fetch): Promise<RegistryAgent[]> {
  const real = fetchImpl === fetch;
  if (real && cached && Date.now() - cached.at < 3_600_000) return cached.agents;
  let body: unknown = null;
  try {
    const r = await fetchImpl(REGISTRY_URL, { signal: AbortSignal.timeout(20_000) });
    if (r.ok) {
      body = await r.json();
      if (real) {
        await mkdir(path.dirname(cacheFile()), { recursive: true });
        await writeFile(cacheFile(), JSON.stringify(body)).catch(() => {});
      }
    }
  } catch {}
  if (!body && real) body = await readFile(cacheFile(), "utf8").then((t) => JSON.parse(t) as unknown, () => null);
  const list = (body as { agents?: unknown })?.agents;
  if (!Array.isArray(list)) throw new Error("The ACP registry couldn't be reached. Check the connection and try again.");
  const agents = list.filter((a): a is RegistryAgent => !!a && typeof a === "object" && safeId(String((a as RegistryAgent).id)) && typeof (a as RegistryAgent).version === "string");
  if (real) cached = { at: Date.now(), agents };
  return agents;
}

export async function registryRows(fetchImpl: typeof fetch = fetch): Promise<RegistryRow[]> {
  return (await registryAgents(fetchImpl))
    .map((a) => {
      const how = howFor(a);
      return how ? { id: a.id, name: text(a.name, 60) || a.id, version: text(a.version, 40), description: text(a.description, 160), how, ...(a.website ? { website: text(a.website, 300) } : {}) } : null;
    })
    .filter((r): r is RegistryRow => !!r)
    .sort((x, y) => x.name.localeCompare(y.name));
}

/** Run a command to its end (npm, tar), with what it said when it failed. */
function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const win = process.platform === "win32";
    const c = spawn(cmd, args, { cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: win && /\.cmd$/i.test(cmd) });
    let out = "";
    c.stdout?.on("data", (d: Buffer) => void (out = (out + d.toString()).slice(-4_000)));
    c.stderr?.on("data", (d: Buffer) => void (out = (out + d.toString()).slice(-4_000)));
    const t = setTimeout(() => c.kill("SIGKILL"), timeoutMs);
    c.on("error", (e) => (clearTimeout(t), reject(e)));
    c.on("close", (code) => (clearTimeout(t), code === 0 ? resolve() : reject(new Error(out.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ") || `${path.basename(cmd)} failed (${code})`))));
  });
}

/** Where a command is on PATH, if it is. */
async function onPath(name: string): Promise<string | null> {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const d of (childEnv().PATH ?? "").split(path.delimiter).filter(Boolean))
    for (const e of exts) {
      const p = path.join(d, name + e);
      if ((await stat(p).catch(() => null))?.isFile()) return p;
    }
  return null;
}

/** The JS file an npm package's command runs, from its package.json: one named like the package, or its only one. */
export function binOf(pkg: { name?: string; bin?: string | Record<string, string> }): string | null {
  if (typeof pkg.bin === "string") return pkg.bin;
  if (!pkg.bin || typeof pkg.bin !== "object") return null;
  const entries = Object.entries(pkg.bin);
  const short = (pkg.name ?? "").split("/").pop() ?? "";
  return (entries.find(([k]) => k === short) ?? (entries.length === 1 ? entries[0] : entries[0]))?.[1] ?? null;
}

/** "@scope/name@1.2.3" → "@scope/name". */
const pkgName = (spec: string) => spec.replace(/^(@?[^@]+)@.*$/, "$1");

export interface Installed {
  command: string;
  args: string[];
  line: string;
  name: string;
  version: string;
}

/**
 * Install one of the registry's agents and say how it is started. `fetchImpl` and `root` are for tests; a download is only ever
 * taken from https and only run once its SHA-256 matches the registry's.
 */
export async function installFromRegistry(id: string, o: { fetchImpl?: typeof fetch; root?: string; key?: string } = {}): Promise<Installed> {
  if (!safeId(id)) throw new Error("That isn't an agent in the ACP registry.");
  const a = (await registryAgents(o.fetchImpl ?? fetch)).find((x) => x.id === id);
  if (!a) throw new Error("That agent isn't in the ACP registry any more.");
  const version = a.version.replace(/[^\w.+-]/g, "");
  const dir = path.join(o.root ?? path.join(homedir(), ".friday", "agents"), id, version);
  await mkdir(dir, { recursive: true });
  const key = o.key ?? platformKey();
  const how = howFor(a, key);
  const done = (command: string, args: string[]): Installed => ({ command, args, line: formatCommandLine(command, args), name: text(a.name, 60) || id, version });

  if (how === "download") {
    const b = a.distribution.binary![key]!;
    const url = new URL(b.archive);
    if (url.protocol !== "https:") throw new Error("The registry gave a download that isn't https, so it wasn't taken.");
    if (!/^[0-9a-f]{64}$/i.test(b.sha256 ?? "")) throw new Error("The registry gave no checksum for this download, so it wasn't taken.");
    const cmd = path.resolve(dir, b.cmd);
    if (!cmd.startsWith(dir + path.sep)) throw new Error("The registry named a command outside the agent's folder.");
    if (!(await stat(cmd).catch(() => null))?.isFile()) {
      const r = await (o.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(10 * 60_000) });
      if (!r.ok) throw new Error(`The download failed (${r.status}).`);
      const bytes = Buffer.from(await r.arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex") !== b.sha256!.toLowerCase()) throw new Error("The download didn't match the registry's checksum, so it wasn't used.");
      const file = path.join(dir, path.basename(url.pathname) || "agent-archive");
      await writeFile(file, bytes);
      // bsdtar (macOS, Windows 10 and later) opens zip, tar.gz and tar.bz2 alike; Linux's tar has no zip, so unzip there.
      if (/\.zip$/i.test(file) && process.platform === "linux") await run("unzip", ["-oq", file, "-d", dir], dir, 120_000);
      else if (/\.(zip|tar|tgz|tar\.gz|tar\.bz2|tbz2?|tar\.xz|txz)$/i.test(file)) await run("tar", ["-xf", file, "-C", dir], dir, 120_000);
      else await writeFile(cmd, bytes);
      await rm(file, { force: true }).catch(() => {});
      if (process.platform !== "win32") await chmod(cmd, 0o755).catch(() => {});
      if (!(await stat(cmd).catch(() => null))?.isFile()) throw new Error(`The download didn't hold ${b.cmd}.`);
    }
    return done(cmd, b.args ?? []);
  }
  if (how === "npm") {
    const spec = a.distribution.npx!.package;
    if (!/^(@[\w.-]+\/)?[\w.-]+@[\w.+-]+$/.test(spec)) throw new Error("The registry gave a package Friday couldn't read.");
    const name = pkgName(spec);
    const pj = path.join(dir, "node_modules", ...name.split("/"), "package.json");
    if (!(await stat(pj).catch(() => null))) {
      await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: `friday-agent-${id}`, private: true }));
      await run(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund", "--omit=dev", "--prefix", dir, spec], dir, 10 * 60_000);
    }
    const pkg = JSON.parse(await readFile(pj, "utf8")) as { name?: string; bin?: string | Record<string, string> };
    const bin = binOf(pkg);
    if (!bin) throw new Error(`${name} has no command to start.`);
    // Its script run by Node itself, never through npm's .cmd shim (which Windows can't start without a shell).
    return done(await nodeForScripts(), [path.join(path.dirname(pj), bin), ...(a.distribution.npx!.args ?? [])]);
  }
  if (how === "uvx") {
    const uvx = await onPath("uvx");
    if (!uvx) throw new Error(`${text(a.name, 60) || id} comes as a Python package: install uv (docs.astral.sh/uv), then choose it again.`);
    return done(uvx, [a.distribution.uvx!.package, ...(a.distribution.uvx!.args ?? [])]);
  }
  throw new Error(`${text(a.name, 60) || id} has nothing in the registry for this computer.`);
}
