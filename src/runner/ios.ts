import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { childEnv, childPath } from "./adapters.js";
import { folderVars } from "./environment.js";
import { hidNow, hidSend, hidSize, type Helper } from "./ios-hid.js";

/**
 * An iOS app, built and run for the Preview panel, on a Mac with Xcode (Arun, 2026-10-18).
 *
 * The same idea as the web preview (preview.ts): what runs is the project's own, built the way Xcode builds it. A scheme the
 * project declares is built for a simulator with xcodebuild, installed and launched with simctl, and the simulator's screen
 * is read back a frame at a time for the panel. Touches happen in Simulator itself, which is opened beside it. Nothing typed
 * by whoever is driving is run: the project, the scheme and the simulator are each one of those the Mac lists.
 */

export interface IosSimulator {
  udid: string;
  name: string;
  /** "iOS 26.0". */
  runtime: string;
  /** "Booted", "Shutdown". */
  state: string;
}

export interface IosProject {
  /** The .xcworkspace or .xcodeproj, relative to the folder. */
  path: string;
  kind: "workspace" | "project";
  schemes: string[];
}

export interface IosBuild {
  cwd: string;
  project: string;
  scheme: string;
  udid: string;
  stage: "booting" | "building" | "installing" | "launching" | "running" | "failed" | "stopped";
  /** The last lines xcodebuild printed, for when it fails. */
  log: string[];
  error?: string;
  bundleId?: string;
  startedAt: number;
  endedAt?: number;
}

export interface IosStatus {
  /** Xcode is installed and usable. When it isn't, `error` says what to do. */
  xcode: boolean;
  error?: string;
  /** Xcode is, but no simulator could be listed: why, and what to do. */
  simError?: string;
  /** The panel's taps, swipes and typing reach the simulator: AXe is on this Mac (iosInput). */
  input: boolean;
  version?: string;
  simulators: IosSimulator[];
  projects: IosProject[];
  build: IosBuild | null;
}

const LOG_LINES = 200;
const builds = new Map<string, { info: IosBuild; child?: ChildProcess }>();

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; maxBuffer?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: opts.cwd, env: childEnv(), timeout: opts.timeoutMs ?? 30_000, maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stdout, stderr }));
      resolve({ stdout, stderr });
    });
  });
}

/** What Xcode said when it refused, cut to its first useful line: the licence not yet agreed, no Xcode selected. */
function xcodeError(e: unknown): string {
  const text = `${(e as { stderr?: string }).stderr ?? ""}\n${(e as Error).message ?? ""}`;
  if (/license/i.test(text)) return "Xcode's licence hasn't been agreed yet. Run sudo xcodebuild -license accept in Terminal, then try again.";
  // Xcode is there but its first-launch parts aren't: no simulator to run anything in.
  if (/CoreSimulator|simctl: No such file/i.test(text)) return "Xcode's simulator isn't installed yet. Open Xcode once and let it install its components (or run sudo xcodebuild -runFirstLaunch), then add an iOS simulator in Xcode › Settings › Components.";
  if (/requires Xcode|active developer directory|xcode-select/i.test(text)) return "Xcode isn't selected. Install Xcode from the App Store, then run sudo xcode-select -s /Applications/Xcode.app.";
  if (/ENOENT|not found/i.test(text)) return "Xcode isn't installed. Get it from the App Store to build and run iOS apps here.";
  return text.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 300) ?? "Xcode didn't answer.";
}

/** The simulators this Mac has that can run an iOS app, booted ones first. */
export async function listSimulators(): Promise<IosSimulator[]> {
  const { stdout } = await run("xcrun", ["simctl", "list", "devices", "available", "-j"]);
  const devices = (JSON.parse(stdout) as { devices?: Record<string, { udid: string; name: string; state: string; isAvailable?: boolean }[]> }).devices ?? {};
  const out: IosSimulator[] = [];
  for (const [runtimeId, list] of Object.entries(devices)) {
    // com.apple.CoreSimulator.SimRuntime.iOS-26-0 → iOS 26.0; watchOS, tvOS and visionOS aren't for an iPhone app.
    const m = runtimeId.match(/SimRuntime\.iOS-(\d+)-(\d+)/);
    if (!m) continue;
    for (const d of list) if (d.isAvailable !== false) out.push({ udid: d.udid, name: d.name, runtime: `iOS ${m[1]}.${m[2]}`, state: d.state });
  }
  const ver = (s: IosSimulator) => s.runtime.replace(/\D+/g, " ").trim().split(" ").map(Number);
  return out.sort((a, b) => (a.state === "Booted" ? -1 : 0) - (b.state === "Booted" ? -1 : 0) || (ver(b)[0]! - ver(a)[0]! || ver(b)[1]! - ver(a)[1]!) || (/iPhone/.test(b.name) ? 1 : 0) - (/iPhone/.test(a.name) ? 1 : 0) || a.name.localeCompare(b.name));
}

const SKIP = new Set(["node_modules", "Pods", "DerivedData", ".build", ".git", "build", "Carthage", ".friday"]);

/** The Xcode workspaces and projects in a folder, two levels down at most: a workspace is what CocoaPods and SwiftPM apps open. */
async function findProjects(cwd: string): Promise<{ path: string; kind: "workspace" | "project" }[]> {
  const found: { path: string; kind: "workspace" | "project" }[] = [];
  const walk = async (dir: string, depth: number) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.name.endsWith(".xcworkspace")) found.push({ path: path.relative(cwd, full), kind: "workspace" });
      // A project's own inner workspace (Foo.xcodeproj/project.xcworkspace) is the project itself, not one more to choose.
      else if (e.name.endsWith(".xcodeproj")) found.push({ path: path.relative(cwd, full), kind: "project" });
      else if (depth < 2) await walk(full, depth + 1);
    }
  };
  await walk(cwd, 0);
  // A workspace first: it is what holds the project and its packages together.
  return found.sort((a, b) => (a.kind === b.kind ? a.path.length - b.path.length : a.kind === "workspace" ? -1 : 1)).slice(0, 8);
}

const schemeCache = new Map<string, { at: number; schemes: string[] }>();

/** The schemes a workspace or project declares, as xcodebuild lists them. Cached until the project changes: listing takes seconds. */
async function schemesOf(cwd: string, p: { path: string; kind: "workspace" | "project" }): Promise<string[]> {
  const full = path.join(cwd, p.path);
  const changed = (await stat(full).catch(() => null))?.mtimeMs ?? 0;
  const hit = schemeCache.get(full);
  if (hit && hit.at === changed) return hit.schemes;
  const { stdout } = await run("xcodebuild", ["-list", "-json", p.kind === "workspace" ? "-workspace" : "-project", full], { cwd, timeoutMs: 60_000 });
  const j = JSON.parse(stdout.slice(stdout.indexOf("{"))) as { workspace?: { schemes?: string[] }; project?: { schemes?: string[] } };
  const schemes = (j.workspace?.schemes ?? j.project?.schemes ?? []).filter((s) => !/Tests?$|UITests$/.test(s));
  schemeCache.set(full, { at: changed, schemes });
  return schemes;
}

/** Whether this Mac can build an iOS app, the simulators it has, the projects in the folder and the build under way there. */
export async function iosStatus(cwd: string): Promise<IosStatus> {
  const build = builds.get(cwd)?.info ?? null;
  if (process.platform !== "darwin") return { xcode: false, error: "iOS apps build and run on a Mac with Xcode.", simulators: [], projects: [], build, input: false };
  let version: string | undefined;
  try {
    version = (await run("xcodebuild", ["-version"])).stdout.split("\n")[0]?.trim();
  } catch (e) {
    return { xcode: false, error: xcodeError(e), simulators: [], projects: [], build, input: false };
  }
  let simError: string | undefined;
  const [simulators, found] = await Promise.all([
    listSimulators().catch((e) => ((simError = xcodeError(e)), [] as IosSimulator[])),
    findProjects(cwd),
  ]);
  if (!simError && !simulators.length) simError = "This Mac has no iOS simulator yet. Add one in Xcode › Settings › Components (the iOS platform), then try again.";
  const projects = await Promise.all(found.map(async (p) => ({ ...p, schemes: await schemesOf(cwd, p).catch(() => []) })));
  return { xcode: true, ...(version ? { version } : {}), ...(simError ? { simError } : {}), simulators, projects, build, input: !!axePath() };
}

const push = (info: IosBuild, text: string) => {
  for (const line of text.split("\n")) if (line.trim()) info.log.push(line.length > 400 ? `${line.slice(0, 400)}…` : line);
  if (info.log.length > LOG_LINES) info.log.splice(0, info.log.length - LOG_LINES);
};

/** Where a folder's builds go: one place per folder, outside it, so the project isn't filled with build products. */
const derivedData = (cwd: string) => path.join(homedir(), "Friday", "ios-build", createHash("sha1").update(cwd).digest("hex").slice(0, 12));

/**
 * Build the scheme for the simulator, install it and launch it. Returns at once: the build goes on in the background, and
 * iosStatus says how far it has got. A build already going in this folder is stopped first.
 */
export async function iosRun(cwd: string, want: { project?: string; scheme?: string; udid?: string }): Promise<IosBuild> {
  const status = await iosStatus(cwd);
  if (!status.xcode) throw new Error(status.error ?? "Xcode isn't available.");
  // Only what the Mac lists: a project in this folder, one of its schemes, one of its simulators.
  const project = status.projects.find((p) => p.path === want.project) ?? status.projects[0];
  if (!project) throw new Error("There's no Xcode project or workspace in this folder.");
  const scheme = project.schemes.find((s) => s === want.scheme) ?? project.schemes[0];
  if (!scheme) throw new Error(`${path.basename(project.path)} has no scheme to build. Open it in Xcode once so it makes one, or share a scheme.`);
  const sim = status.simulators.find((s) => s.udid === want.udid) ?? status.simulators.find((s) => /iPhone/.test(s.name)) ?? status.simulators[0];
  if (!sim) throw new Error(status.simError ?? "This Mac has no iOS simulator. Add one in Xcode › Settings › Components.");
  iosStop(cwd);
  const info: IosBuild = { cwd, project: project.path, scheme, udid: sim.udid, stage: "booting", log: [], startedAt: Date.now() };
  const entry: { info: IosBuild; child?: ChildProcess } = { info };
  builds.set(cwd, entry);
  const live = () => builds.get(cwd) === entry && info.stage !== "stopped";
  const fail = (e: unknown) => {
    if (!live()) return;
    info.stage = "failed";
    info.error = (e as Error).message?.slice(0, 500) || "It didn't run.";
    info.endedAt = Date.now();
  };
  void (async () => {
    // Already booted is fine; anything else is a reason it won't run.
    if (sim.state !== "Booted") await run("xcrun", ["simctl", "boot", sim.udid], { timeoutMs: 120_000 }).catch((e) => {
      if (!/current state: Booted/i.test(`${e.stderr ?? ""}`)) throw e;
    });
    // Simulator itself, on that device: where the app is touched and typed into.
    void run("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", sim.udid]).catch(() => {});
    if (!live()) return;
    info.stage = "building";
    const out = derivedData(cwd);
    const args = [
      project.kind === "workspace" ? "-workspace" : "-project", path.join(cwd, project.path),
      "-scheme", scheme,
      "-configuration", "Debug",
      "-destination", `id=${sim.udid}`,
      "-derivedDataPath", out,
      // A simulator build needs no signing, and asking for it fails on a Mac with no developer account.
      "CODE_SIGNING_ALLOWED=NO",
      "build",
    ];
    push(info, `$ xcodebuild ${args.join(" ")}`);
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn("xcodebuild", args, { cwd, env: { ...childEnv(), ...folderVars(cwd), NSUnbufferedIO: "YES" } });
      entry.child = child;
      child.stdout.on("data", (d: Buffer) => push(info, d.toString()));
      child.stderr.on("data", (d: Buffer) => push(info, d.toString()));
      child.on("error", reject);
      child.on("close", (c) => resolve(c ?? 1));
    });
    entry.child = undefined;
    if (!live()) return;
    if (code !== 0) {
      const why = info.log.filter((l) => /error:|\*\* BUILD FAILED \*\*/.test(l)).slice(-3).join(" · ");
      throw new Error(why || `xcodebuild stopped with code ${code}.`);
    }
    info.stage = "installing";
    const products = path.join(out, "Build", "Products", "Debug-iphonesimulator");
    const apps = (await readdir(products).catch(() => [])).filter((f) => f.endsWith(".app"));
    if (!apps.length) throw new Error("The build finished but made no .app for the simulator.");
    const newest = (await Promise.all(apps.map(async (a) => ({ a, at: (await stat(path.join(products, a))).mtimeMs })))).sort((x, y) => y.at - x.at)[0]!.a;
    const app = path.join(products, newest);
    const plist = (await run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", path.join(app, "Info.plist")])).stdout.trim();
    info.bundleId = plist;
    await run("xcrun", ["simctl", "install", sim.udid, app], { timeoutMs: 120_000 });
    if (!live()) return;
    info.stage = "launching";
    // Started fresh each time, so what is on screen is the build that just finished.
    await run("xcrun", ["simctl", "terminate", sim.udid, plist]).catch(() => {});
    await run("xcrun", ["simctl", "launch", sim.udid, plist], { timeoutMs: 60_000 });
    if (!live()) return;
    info.stage = "running";
    info.endedAt = Date.now();
  })().catch(fail);
  return info;
}

/** The build iosRun would start here, in words, for a person on a Manual machine to say yes to; null when there is nothing to build. */
export async function iosCommand(cwd: string): Promise<string | null> {
  const s = await iosStatus(cwd);
  const p = s.projects[0];
  const scheme = p?.schemes[0];
  const sim = s.simulators.find((x) => /iPhone/.test(x.name)) ?? s.simulators[0];
  if (!s.xcode || !p || !scheme || !sim) return null;
  return `xcodebuild ${p.kind === "workspace" ? "-workspace" : "-project"} ${p.path} -scheme ${scheme} -destination "${sim.name}, ${sim.runtime}" build, then install and launch it in the simulator`;
}

/** Stop the build under way in this folder, and the app it launched. */
export function iosStop(cwd: string): boolean {
  const entry = builds.get(cwd);
  if (!entry) return false;
  entry.child?.kill("SIGTERM");
  if (entry.info.bundleId) void run("xcrun", ["simctl", "terminate", entry.info.udid, entry.info.bundleId]).catch(() => {});
  entry.info.stage = "stopped";
  entry.info.endedAt = Date.now();
  builds.delete(cwd);
  return true;
}

/** One frame of a booted simulator's screen, as a JPEG data address for an <img>. */
export async function iosScreen(udid: string): Promise<{ image: string } | { error: string }> {
  if (!/^[0-9A-F-]{36}$/i.test(udid)) return { error: "That isn't a simulator." };
  const file = path.join(tmpdir(), `friday-ios-${udid}.jpg`);
  try {
    await run("xcrun", ["simctl", "io", udid, "screenshot", "--type=jpeg", file], { timeoutMs: 10_000 });
    const data = await readFile(file);
    return { image: `data:image/jpeg;base64,${data.toString("base64")}` };
  } catch (e) {
    const text = `${(e as { stderr?: string }).stderr ?? ""}`;
    return { error: /No devices are booted|Unable to lookup|not booted/i.test(text) ? "That simulator isn't running." : xcodeError(e) };
  } finally {
    void rm(file, { force: true }).catch(() => {});
  }
}

/**
 * Touching the app from the Preview panel (Arun, 2026-10-18). simctl has no way to tap or type, so this goes through AXe
 * (github.com/cameroncooke/AXe, `brew install cameroncooke/axe/axe`), which sends a simulator real touches and keys. Without
 * it the panel stays a view and says how to get it. Positions come from the panel as shares of the screen (0 to 1), turned
 * into the simulator's own points here, so the panel never needs to know a device's size.
 */
export type IosInput =
  | { kind: "tap"; x: number; y: number }
  | { kind: "swipe"; x: number; y: number; x2: number; y2: number; seconds?: number }
  | { kind: "type"; text: string }
  | { kind: "key"; code: number }
  | { kind: "button"; name: "home" | "lock" }
  /** A finger put down, moved and lifted as it happens, so a drag scrolls with it (the live view, ios-live.ts). */
  | { kind: "down" | "move" | "up"; x: number; y: number };

/** Where AXe is: the copy inside the Mac app (FRIDAY_AXE, from desktop/main.ts), then the PATH, then where Homebrew puts it. */
export function axePath(): string | null {
  const bundled = process.env.FRIDAY_AXE;
  if (bundled && existsSync(bundled)) return bundled;
  for (const dir of [...childPath().split(path.delimiter), "/opt/homebrew/bin", "/usr/local/bin"]) {
    if (dir && existsSync(path.join(dir, "axe"))) return path.join(dir, "axe");
  }
  return null;
}

const pointsCache = new Map<string, { w: number; h: number }>();

/** A simulator's screen in points, from the root of what AXe reads off it. Kept: a device's size doesn't change while it runs. */
async function screenPoints(axe: string, udid: string): Promise<{ w: number; h: number }> {
  const hit = pointsCache.get(udid);
  if (hit) return hit;
  const { stdout } = await run(axe, ["describe-ui", "--udid", udid], { timeoutMs: 20_000 });
  const root = (JSON.parse(stdout) as { frame?: { width: number; height: number } }[])[0]?.frame;
  if (!root?.width || !root.height) throw new Error("Couldn't read the simulator's screen size.");
  const size = { w: root.width, h: root.height };
  pointsCache.set(udid, size);
  return size;
}

/** One touch, swipe, string of text, key or button, sent to a booted simulator. */
/**
 * Touches and keys through an AXe process started ahead of them (Arun, 2026-10-20: "the iOS simulator… is so slow"). Every
 * AXe command loads its frameworks and finds the simulator before it does anything, about a tenth of a second of a tap's
 * two-thirds; one batch process per simulator is started beforehand and waits on its input, so a press only pays for the
 * touch itself, and the next is started as it goes. They run one at a time, in the order they were made, so a tap and the
 * key after it never swap places. A waiting one that nothing uses for a minute is let go. Since the touch helper
 * (ios-hid.ts) this is the way in only until it is up, or where it can't be made.
 */
const warm = new Map<string, ChildProcess>();
const queue = new Map<string, Promise<unknown>>();

function prime(axe: string, udid: string) {
  const c = spawn(axe, ["batch", "--udid", udid, "--stdin"], { env: childEnv(), stdio: ["pipe", "ignore", "pipe"] });
  c.on("error", () => {});
  c.stdin?.on("error", () => {});
  warm.set(udid, c);
  setTimeout(() => {
    if (warm.get(udid) !== c) return;
    warm.delete(udid);
    c.kill();
  }, 60_000).unref?.();
}

function take(axe: string, udid: string): ChildProcess {
  const c = warm.get(udid);
  warm.delete(udid);
  return c && c.exitCode === null && !c.killed && c.stdin?.writable ? c : spawn(axe, ["batch", "--udid", udid, "--stdin"], { env: childEnv(), stdio: ["pipe", "ignore", "pipe"] });
}

/** One step (a tap, a swipe, a key, a button) on its simulator, after the ones before it. */
function stepIn(axe: string, udid: string, step: string[]): Promise<void> {
  const go = async () => {
    const c = take(axe, udid);
    prime(axe, udid);
    let stderr = "";
    c.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d).slice(-4000)));
    const done = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => (c.kill(), reject(Object.assign(new Error("The simulator didn't answer."), { stderr }))), 20_000);
      c.on("error", (e) => (clearTimeout(t), reject(Object.assign(e, { stderr }))));
      c.on("exit", (code) => (clearTimeout(t), code === 0 ? resolve() : reject(Object.assign(new Error(stderr.trim().split("\n").pop() || "AXe failed"), { stderr }))));
    });
    c.stdin?.end(`${step.join(" ")}\n`);
    await done;
  };
  const next = (queue.get(udid) ?? Promise.resolve()).catch(() => {}).then(go);
  queue.set(udid, next);
  return next;
}

/**
 * A finger down on each simulator: through the touch helper, which holds it and moves it as it goes, or, when the helper
 * wasn't up as it went down, where and when, so lifting it plays it through AXe as a tap or a swipe.
 */
const fingers = new Map<string, { via: "hid"; h: Helper } | { via: "axe"; x: number; y: number; at: number }>();

/** Through the touch helper (ios-hid.ts), when it is up: true when it took the input, false to send it through AXe. */
async function viaHelper(axe: string, udid: string, input: IosInput, share: (v: unknown) => number): Promise<boolean> {
  if (input.kind === "move" || input.kind === "up") {
    const f = fingers.get(udid);
    if (f?.via !== "hid") return false;
    if (input.kind === "up") fingers.delete(udid);
    const p = await hidSize(udid, f.h);
    await hidSend(udid, f.h, `${input.kind} ${share(input.x) * p.w} ${share(input.y) * p.h}`);
    return true;
  }
  const h = hidNow(axe, udid);
  if (!h) return false;
  try {
    if (input.kind === "type") await hidSend(udid, h, `type ${JSON.stringify(String(input.text ?? "").slice(0, 2000))}`);
    else if (input.kind === "key") await hidSend(udid, h, `key ${Math.round(Number(input.code))}`);
    else if (input.kind === "button") await hidSend(udid, h, `button ${input.name}`);
    else {
      const p = await hidSize(udid, h);
      const at = (x: unknown, y: unknown) => `${share(x) * p.w} ${share(y) * p.h}`;
      if (input.kind === "down") {
        fingers.set(udid, { via: "hid", h });
        await hidSend(udid, h, `down ${at(input.x, input.y)}`);
      } else if (input.kind === "tap") await hidSend(udid, h, `tap ${at(input.x, input.y)}`);
      else if (input.kind === "swipe") await hidSend(udid, h, `swipe ${at(input.x, input.y)} ${at(input.x2, input.y2)} ${Math.min(1.5, Math.max(0.1, Number(input.seconds) || 0.3))}`);
    }
    return true;
  } catch (e) {
    // A finger already down stays the helper's; anything else is tried again through AXe (text with a character the
    // helper has no key for, a helper that has just stopped).
    if (input.kind === "down") throw e;
    return false;
  }
}

export async function iosInput(udid: string, input: IosInput): Promise<{ ok: true } | { error: string }> {
  if (!/^[0-9A-F-]{36}$/i.test(udid)) return { error: "That isn't a simulator." };
  const axe = axePath();
  if (!axe) return { error: "Install AXe to touch and type in the simulator from here: brew install cameroncooke/axe/axe" };
  const share = (v: unknown) => Math.min(1, Math.max(0, Number(v) || 0));
  const id = ["--udid", udid];
  try {
    if (input.kind === "key" && !(Math.round(Number(input.code)) >= 0 && Math.round(Number(input.code)) <= 255)) return { error: "That isn't a key." };
    if (input.kind === "button" && input.name !== "home" && input.name !== "lock") return { error: "That isn't something the simulator takes." };
    if (await viaHelper(axe, udid, input, share)) return { ok: true };
    // Without the helper a finger is only remembered, and played through AXe once it lifts.
    if (input.kind === "down") {
      fingers.set(udid, { via: "axe", x: share(input.x), y: share(input.y), at: Date.now() });
      return { ok: true };
    }
    if (input.kind === "move") return { ok: true };
    if (input.kind === "up") {
      const f = fingers.get(udid);
      fingers.delete(udid);
      if (f?.via !== "axe") return { ok: true };
      const to = { x: share(input.x), y: share(input.y) };
      return iosInput(udid, Math.hypot(to.x - f.x, to.y - f.y) < 0.02 ? { kind: "tap", x: f.x, y: f.y } : { kind: "swipe", x: f.x, y: f.y, x2: to.x, y2: to.y, seconds: (Date.now() - f.at) / 1000 });
    }
    let args: string[];
    if (input.kind === "tap" || input.kind === "swipe") {
      const p = await screenPoints(axe, udid);
      const at = (x: unknown, y: unknown) => [String(Math.round(share(x) * p.w)), String(Math.round(share(y) * p.h))];
      if (input.kind === "tap") {
        const [x, y] = at(input.x, input.y);
        args = ["tap", "-x", x!, "-y", y!, ...id];
      } else {
        const [x, y] = at(input.x, input.y);
        const [x2, y2] = at(input.x2, input.y2);
        // Replayed no slower than 0.6s: it is played after the finger has lifted, and a slow drag played at its own pace kept the
        // screen behind the finger by its whole length.
        const secs = Math.min(0.6, Math.max(0.15, Number(input.seconds) || 0.3));
        // AXe's own step is so small that a quick flick (under about 0.4s) never arrives as one: the app sees no swipe. A
        // step of what a finger covers in a 60th of a second makes a flick of any speed land, as a page turn or a scroll.
        const delta = Math.min(40, Math.max(2, Math.hypot(Number(x2) - Number(x), Number(y2) - Number(y)) / (secs * 60)));
        args = ["swipe", "--start-x", x!, "--start-y", y!, "--end-x", x2!, "--end-y", y2!, "--duration", secs.toFixed(2), "--delta", delta.toFixed(1), ...id];
      }
    } else if (input.kind === "type") {
      const text = String(input.text ?? "").slice(0, 2000);
      if (!text) return { ok: true };
      args = ["type", text, ...id];
    } else if (input.kind === "key") {
      const code = Math.round(Number(input.code));
      if (!(code >= 0 && code <= 255)) return { error: "That isn't a key." };
      args = ["key", String(code), ...id];
    } else if (input.kind === "button" && (input.name === "home" || input.name === "lock")) {
      args = ["button", input.name, ...id];
    } else return { error: "That isn't something the simulator takes." };
    // Typing goes as its own command, its text an argument rather than part of a line to be read back.
    if (input.kind === "type") await run(axe, args, { timeoutMs: 20_000 });
    else await stepIn(axe, udid, args.filter((a, i) => a !== "--udid" && args[i - 1] !== "--udid"));
    return { ok: true };
  } catch (e) {
    const text = `${(e as { stderr?: string }).stderr ?? ""} ${(e as Error).message ?? ""}`;
    return { error: /not booted|No such device|Unable to find/i.test(text) ? "That simulator isn't running." : text.trim().split("\n")[0]?.slice(0, 300) || "The simulator didn't take that." };
  }
}
