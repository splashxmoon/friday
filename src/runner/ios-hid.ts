import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { childEnv } from "./adapters.js";

/**
 * Touches that land at once, and drags that follow the finger (Arun, 2026-10-20: "so slow right now"). Each AXe command is a
 * process of its own, and on Xcode 27 it spends about half a second setting up simulator input before it touches anything
 * (measured on an iPhone 18 Pro simulator: a tap took 660ms); its batch runs only once its input has closed, and a held
 * finger can't be moved from one command to the next. So a drag could only be played back after it had ended.
 *
 * This is a small helper of Friday's own that does what AXe does underneath, through the same FBSimulatorControl
 * frameworks AXe ships with, but keeps one connection to the simulator's touch input open: a press costs a millisecond or
 * two, and a finger put down stays down and moves until it is lifted. Its Swift source is below; it is compiled on this Mac
 * the first time it is needed (with Xcode's swiftc, which building an iOS app needs anyway) against the AXe Friday already
 * uses, and kept in ~/Friday/ios-hid, a new one made when this source or that AXe changes. Until it is ready, or if it can't
 * be made, ios.ts sends input through AXe as before.
 *
 * Run with "stream", the same helper is the live view's picture (ios-live.ts): the simulator's display surface as it is
 * drawn, a JPEG each time it changes, up to 60 a second, where AXe's stream took a screenshot a frame.
 */

/** Where AXe's frameworks are: beside its executable (the copy inside the Mac app), or in Homebrew's libexec beside bin. */
export function frameworksOf(axe: string): string | null {
  let exe = axe;
  try {
    exe = realpathSync(axe);
  } catch {}
  for (const dir of [path.join(path.dirname(exe), "Frameworks"), path.join(path.dirname(exe), "..", "libexec", "Frameworks")]) {
    if (existsSync(path.join(dir, "FBSimulatorControl.framework"))) return dir;
  }
  return null;
}

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: opts.cwd, env: childEnv(), timeout: opts.timeoutMs ?? 30_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stdout, stderr }));
      resolve(stdout);
    });
  });
}

const builds = new Map<string, Promise<string | null>>();

/**
 * The helper, compiled for this AXe: the path to it, or null when it can't be made here (no Xcode's swiftc, an AXe without
 * its frameworks, a compiler that won't read them). Made once; asking again while it is being made waits for that.
 */
export function hidHelper(axe: string): Promise<string | null> {
  const fw = frameworksOf(axe);
  if (!fw || process.platform !== "darwin") return Promise.resolve(null);
  let b = builds.get(fw);
  if (!b) {
    b = compile(fw).catch((e) => {
      console.warn(`[ios] touch helper not built, using AXe: ${`${(e as { stderr?: string }).stderr ?? ""}`.split("\n").find((l) => /error/.test(l)) ?? (e as Error).message}`);
      return null;
    });
    builds.set(fw, b);
  }
  return b;
}

async function compile(fw: string): Promise<string> {
  const lib = path.join(fw, "FBSimulatorControl.framework", "FBSimulatorControl");
  const s = await stat(lib);
  const key = createHash("sha1").update(`${SOURCE}\n${fw}\n${s.size}\n${s.mtimeMs}`).digest("hex").slice(0, 12);
  const dir = path.join(homedir(), "Friday", "ios-hid", key);
  const exe = path.join(dir, "friday-hid");
  if (existsSync(exe)) return exe;
  const work = path.join(dir, `work-${process.pid}`);
  await rm(work, { recursive: true, force: true });
  // AXe's frameworks were built by another Swift than this Mac's, so its interface is read and compiled here. Two things in
  // it trip a compiler reading it back: types written with the module's name, which is also the name of a class in it
  // (FBSimulatorControl.FBSimulatorControl), and IOSurface the same way. A copy of the interface with those names left
  // bare is put in a framework of its own beside the real one, and CoreSimulator, which it names but whose headers only
  // Meta's build has, is four empty classes: nothing here calls into them.
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  const shadow = path.join(work, "shadow", "FBSimulatorControl.framework");
  const real = path.join(fw, "FBSimulatorControl.framework");
  const iface = await readFile(path.join(real, "Modules", "FBSimulatorControl.swiftmodule", `${arch}-apple-macos.swiftinterface`), "utf8");
  await mkdir(path.join(shadow, "Modules", "FBSimulatorControl.swiftmodule"), { recursive: true });
  await mkdir(path.join(work, "stub"), { recursive: true });
  await Promise.all([
    symlink(path.join(real, "Headers"), path.join(shadow, "Headers")),
    symlink(path.join(real, "FBSimulatorControl"), path.join(shadow, "FBSimulatorControl")),
    copyFile(path.join(real, "Modules", "module.modulemap"), path.join(shadow, "Modules", "module.modulemap")),
    writeFile(path.join(shadow, "Modules", "FBSimulatorControl.swiftmodule", `${arch}-apple-macos.swiftinterface`), iface.replace(/FBSimulatorControl\.(?=[A-Za-z_])/g, "").replace(/IOSurface\.IOSurface/g, "IOSurface")),
    writeFile(path.join(work, "stub", "module.modulemap"), `module CoreSimulator {\n  header "CoreSimulator.h"\n  export *\n}\n`),
    writeFile(path.join(work, "stub", "CoreSimulator.h"), `#import <Foundation/Foundation.h>\n${["SimDevice", "SimDeviceSet", "SimDeviceType", "SimRuntime"].map((c) => `@interface ${c} : NSObject\n@end\n`).join("")}`),
    writeFile(path.join(work, "main.swift"), SOURCE),
  ]);
  await run("xcrun", ["swiftc", "-O", "main.swift", "-o", "friday-hid", "-I", "stub", "-F", path.join(work, "shadow"), "-F", fw, "-Xlinker", "-rpath", "-Xlinker", fw], { cwd: work, timeoutMs: 300_000 });
  await rename(path.join(work, "friday-hid"), exe);
  await rm(work, { recursive: true, force: true });
  return exe;
}

/**
 * One helper per simulator, started when the live view opens or the first press needs it and let go after ten minutes
 * unused. Every line written gets one line back, in order, so each command waits for its own answer.
 */
export interface Helper {
  child: ChildProcess;
  ready: Promise<boolean>;
  up: boolean;
  waiting: ((line: string) => void)[];
  size?: { w: number; h: number };
  idle?: NodeJS.Timeout;
}

const helpers = new Map<string, Helper>();
const IDLE_MS = 10 * 60_000;

function start(exe: string, udid: string): Helper {
  const child = spawn(exe, [udid], { env: childEnv(), stdio: ["pipe", "pipe", "ignore"] });
  const h: Helper = { child, ready: Promise.resolve(false), up: false, waiting: [] };
  child.on("error", () => {});
  child.stdin?.on("error", () => {});
  let first: (ok: boolean) => void = () => {};
  h.ready = new Promise<boolean>((resolve) => (first = resolve));
  const t = setTimeout(() => (first(false), stop(udid, h)), 20_000);
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (!h.up) {
      clearTimeout(t);
      h.up = line === "ready";
      first(h.up);
      if (!h.up) stop(udid, h);
      return;
    }
    h.waiting.shift()?.(line);
  });
  child.on("exit", () => {
    clearTimeout(t);
    first(false);
    if (helpers.get(udid) === h) helpers.delete(udid);
    for (const w of h.waiting.splice(0)) w("err The touch helper stopped.");
  });
  helpers.set(udid, h);
  return h;
}

function stop(udid: string, h: Helper) {
  if (helpers.get(udid) === h) helpers.delete(udid);
  // Its input closed, it lifts a finger still down and ends; one that doesn't is ended a second later.
  h.child.stdin?.end();
  setTimeout(() => h.child.exitCode === null && h.child.kill(), 1000).unref?.();
}

/** Get the helper for a simulator going (compiling it first if need be) without waiting for it. */
export function hidWarm(axe: string, udid: string) {
  void hidFor(axe, udid);
}

async function hidFor(axe: string, udid: string): Promise<Helper | null> {
  const have = helpers.get(udid);
  if (have) return (await have.ready) ? have : null;
  const exe = await hidHelper(axe);
  if (!exe) return null;
  const h = helpers.get(udid) ?? start(exe, udid);
  return (await h.ready) ? h : null;
}

/** The helper for a simulator if it is up now; if it isn't, it is started, and null says to use AXe this time. */
export function hidNow(axe: string, udid: string): Helper | null {
  const h = helpers.get(udid);
  if (h?.up && h.child.exitCode === null) return h;
  if (!h) hidWarm(axe, udid);
  return null;
}

/** One command to the helper; its answer after "ok" (a size), or an error with what it said. */
export function hidSend(udid: string, h: Helper, line: string): Promise<string> {
  clearTimeout(h.idle);
  h.idle = setTimeout(() => stop(udid, h), IDLE_MS);
  h.idle.unref?.();
  return new Promise((resolve, reject) => {
    h.waiting.push((answer) => (answer === "ok" || answer.startsWith("ok ") ? resolve(answer.slice(3)) : reject(new Error(answer.replace(/^err /, "")))));
    h.child.stdin!.write(`${line.replace(/[\r\n]/g, " ")}\n`);
  });
}

/** The simulator's screen in points, portrait, as the helper reads it from the device's type. */
export async function hidSize(udid: string, h: Helper): Promise<{ w: number; h: number }> {
  if (h.size) return h.size;
  const [w, ht] = (await hidSend(udid, h, "size")).split(" ").map(Number);
  if (!w || !ht) throw new Error("Couldn't read the simulator's screen size.");
  h.size = { w, h: ht };
  return h.size;
}

/** The helper. A backtick is written \u{60} in it, so it can sit in this string as it is. */
const SOURCE = String.raw`import Foundation
import CoreImage
import FBControlCore
import FBSimulatorControl
import ImageIO

// Friday's simulator touch helper (src/runner/ios-hid.ts). One connection to a booted simulator's HID, kept open, and one
// command a line on stdin, each answered with a line on stdout ("ok …" or "err …") in the order they came:
//   size                     the screen in points, portrait
//   down X Y | move X Y | up X Y   one finger, in points; a down where the finger already is moves it
//   tap X Y | swipe X Y X2 Y2 SECS | key CODE | button home|lock | type "JSON string"
// When stdin closes, a finger still down is lifted, and it ends.
//
// Or, as "friday-hid UDID stream WIDTH QUALITY FPS", the screen as MJPEG parts on stdout (see stream below).

func say(_ s: String) { FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!) }
struct Fail: LocalizedError { let errorDescription: String? ; init(_ s: String) { errorDescription = s } }

let udid = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
let logger = FBControlCoreLoggerFactory.systemLoggerWriting(toStderr: false, withDebugLogging: false)
FBControlCoreGlobalConfiguration.defaultLogger = logger

// The US keyboard's HID usages for the characters typing can send, and whether each needs shift.
let keys: [Character: (UInt32, Bool)] = {
  var m: [Character: (UInt32, Bool)] = [:]
  for (i, c) in "abcdefghijklmnopqrstuvwxyz".enumerated() { m[c] = (UInt32(4 + i), false); m[Character(c.uppercased())] = (UInt32(4 + i), true) }
  for (i, c) in "1234567890".enumerated() { m[c] = (UInt32(30 + i), false) }
  for (i, c) in "!@#$%^&*()".enumerated() { m[c] = (UInt32(30 + i), true) }
  let plain: [(Character, UInt32)] = [("\n", 40), ("\t", 43), (" ", 44), ("-", 45), ("=", 46), ("[", 47), ("]", 48), ("\\", 49), (";", 51), ("'", 52), ("\u{60}", 53), (",", 54), (".", 55), ("/", 56)]
  let shifted: [(Character, UInt32)] = [("_", 45), ("+", 46), ("{", 47), ("}", 48), ("|", 49), (":", 51), ("\"", 52), ("~", 53), ("<", 54), (">", 55), ("?", 56)]
  for (c, k) in plain { m[c] = (k, false) }
  for (c, k) in shifted { m[c] = (k, true) }
  return m
}()

@MainActor func simulator() throws -> FBSimulator {
  try FBSimulatorControlFrameworkLoader.essentialFrameworks.loadPrivateFrameworks(logger)
  try FBSimulatorControlFrameworkLoader.xcodeFrameworks.loadPrivateFrameworks(logger)
  let control = try FBSimulatorControl.withConfiguration(FBSimulatorControlConfiguration(deviceSetPath: nil, logger: logger, reporter: nil))
  guard let sim = control.set.allSimulators.first(where: { $0.udid == udid }) else { throw Fail("No such simulator") }
  guard sim.state == .booted else { throw Fail("That simulator isn't running.") }
  return sim
}

@MainActor func connect() async throws -> (FBSimulator, FBSimulatorHID) {
  let sim = try simulator()
  return (sim, try await sim.connectToHID())
}

/// What the simulator draws its screen into, and whether it has drawn since the last frame was sent. Called on one queue.
final class Screen: NSObject, FBFramebufferConsumer {
  var surface: IOSurface?
  var drawn = true
  /// The pixels last sent, so a frame is made only when they differ, whatever the simulator says it has drawn.
  var last = Data()
  func didChange(_ surface: IOSurface?) { self.surface = surface; drawn = true }
  func didReceiveDamageRect() { drawn = true }
  /// Whether the surface holds something other than what was last sent, keeping it if so.
  func changed(_ surface: IOSurface) -> Bool {
    surface.lock(options: .readOnly, seed: nil)
    defer { surface.unlock(options: .readOnly, seed: nil) }
    let count = surface.allocationSize
    let now = UnsafeRawBufferPointer(start: surface.baseAddress, count: count)
    if last.count == count && last.withUnsafeBytes({ memcmp($0.baseAddress!, now.baseAddress!, count) == 0 }) { return false }
    last = Data(now)
    return true
  }
}

/**
 * The screen as it is drawn, straight from the simulator's own display surface rather than a screenshot a frame: a frame
 * is made only when something was drawn, as often as FPS a second, WIDTH pixels wide (never wider than the screen), as a
 * JPEG of QUALITY, each written as one part of a multipart/x-mixed-replace stream. The last frame of a change is sent once
 * more a moment after it, since a browser may show a part only when the next one starts.
 */
@MainActor func stream(width: Int, quality: Double, fps: Double) throws {
  let sim = try simulator()
  let framebuffer = try FBFramebuffer.mainScreenSurface(for: sim, logger: logger)
  let queue = DispatchQueue(label: "friday.frames", qos: .userInteractive)
  let screen = Screen()
  queue.sync { screen.surface = framebuffer.attach(screen, on: queue) }
  let context = CIContext(options: [.cacheIntermediates: false])
  let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
  let out = FileHandle.standardOutput
  func send(_ surface: IOSurface) {
    var image = CIImage(ioSurface: surface as IOSurfaceRef)
    let k = Double(width) / image.extent.width
    if k < 0.999 { image = image.applyingFilter("CILanczosScaleTransform", parameters: [kCIInputScaleKey: k, kCIInputAspectRatioKey: 1]) }
    let options = [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): quality]
    guard let jpeg = context.jpegRepresentation(of: image, colorSpace: srgb, options: options) else { return }
    out.write("--mjpegstream\r\nContent-Type: image/jpeg\r\nContent-Length: \(jpeg.count)\r\n\r\n".data(using: .utf8)! + jpeg + "\r\n".data(using: .utf8)!)
  }
  var quiet = 0
  func tick(_ surface: IOSurface) {
    quiet += 1
    if quiet == Int(fps / 6) { send(surface) }
  }
  let timer = DispatchSource.makeTimerSource(queue: queue)
  timer.schedule(deadline: .now(), repeating: 1 / fps, leeway: .milliseconds(1))
  timer.setEventHandler {
    guard let surface = screen.surface else { return }
    if screen.drawn {
      screen.drawn = false
      guard screen.changed(surface) else { return tick(surface) }
      quiet = 0
      send(surface)
    } else { tick(surface) }
  }
  timer.resume()
  // Kept for as long as it runs, which is until whoever reads it goes: a write to a closed pipe stops the process.
  kept = [framebuffer, timer, screen]
}
var kept: [AnyObject] = []

if CommandLine.arguments.count > 2 && CommandLine.arguments[2] == "stream" {
  let a = CommandLine.arguments
  let num = { (i: Int, d: Double) -> Double in i < a.count ? Double(a[i]) ?? d : d }
  Task { @MainActor in
    do { try stream(width: Int(min(4000, max(100, num(3, 800)))), quality: min(1, max(0.3, num(4, 0.8))), fps: min(60, max(5, num(5, 60)))) }
    catch { FileHandle.standardError.write("fail \(error.localizedDescription)\n".data(using: .utf8)!); exit(1) }
  }
  RunLoop.main.run()
}

/// The screen in points, from the device type CoreSimulator has for it (pixels over scale).
func screenSize(_ sim: FBSimulator) -> (Double, Double)? {
  guard let type = (sim.device as AnyObject).value(forKey: "deviceType") as? NSObject,
        let px = (type.value(forKey: "mainScreenSize") as? NSValue)?.sizeValue,
        let scale = (type.value(forKey: "mainScreenScale") as? NSNumber)?.doubleValue, scale > 0, px.width > 0 else { return nil }
  return (Double(px.width) / scale, Double(px.height) / scale)
}

Task { @MainActor in
  let sim: FBSimulator, hid: FBSimulatorHID
  do { (sim, hid) = try await connect() } catch { say("fail \(error.localizedDescription)"); exit(1) }
  say("ready")
  var held: (Double, Double)? = nil
  func touch(_ d: FBSimulatorHIDDirection, _ x: Double, _ y: Double) async throws {
    try await FBSimulatorHIDEvent.touch(direction: d, x: x, y: y).sendAsync(on: hid)
    held = d == .down ? (x, y) : nil
  }
  func press(_ code: UInt32, shift: Bool = false) async throws {
    if shift { try await FBSimulatorHIDEvent.keyboard(direction: .down, keyCode: 225).sendAsync(on: hid) }
    try await FBSimulatorHIDEvent.keyboard(direction: .down, keyCode: code).sendAsync(on: hid)
    try await FBSimulatorHIDEvent.keyboard(direction: .up, keyCode: code).sendAsync(on: hid)
    if shift { try await FBSimulatorHIDEvent.keyboard(direction: .up, keyCode: 225).sendAsync(on: hid) }
  }
  let pause = { (s: Double) in try await Task.sleep(nanoseconds: UInt64(max(0, s) * 1e9)) }
  do {
    for try await line in FileHandle.standardInput.bytes.lines {
      let p = line.split(separator: " ", maxSplits: 1).map(String.init)
      let args = p.count > 1 ? p[1].split(separator: " ").map { Double($0) ?? .nan } : []
      let n = { (i: Int) -> Double in i < args.count && args[i].isFinite ? args[i] : 0 }
      do {
        switch p.first ?? "" {
        case "size":
          guard let (w, h) = screenSize(sim) else { throw Fail("Couldn't read the simulator's screen size.") }
          say("ok \(w) \(h)"); continue
        case "down", "move": try await touch(.down, n(0), n(1))
        case "up": try await touch(.up, n(0), n(1))
        case "tap":
          try await touch(.down, n(0), n(1)); try await pause(0.05); try await touch(.up, n(0), n(1))
        case "swipe":
          // A step every 60th of a second, from start to end over the time asked for.
          let (x, y, x2, y2) = (n(0), n(1), n(2), n(3)), secs = min(5, max(0.05, n(4))), steps = max(2, Int(secs * 60))
          try await touch(.down, x, y)
          for i in 1...steps {
            try await pause(secs / Double(steps))
            let t = Double(i) / Double(steps)
            try await touch(.down, x + (x2 - x) * t, y + (y2 - y) * t)
          }
          try await touch(.up, x2, y2)
        case "key": try await press(UInt32(n(0)))
        case "button":
          let which = p.count > 1 ? p[1] : ""
          guard which == "home" || which == "lock" else { throw Fail("That isn't a button.") }
          try await FBSimulatorHIDEvent.shortButtonPress(which == "home" ? .homeButton : .lock).sendAsync(on: hid)
        case "type":
          guard p.count > 1, let text = try JSONSerialization.jsonObject(with: Data(p[1].utf8), options: .fragmentsAllowed) as? String else { throw Fail("Nothing to type.") }
          let codes = try text.map { c -> (UInt32, Bool) in
            guard let k = keys[c] else { throw Fail("unsupported character") }
            return k
          }
          for (code, shift) in codes { try await press(code, shift: shift) }
        default: throw Fail("unknown command")
        }
        say("ok")
      } catch { say("err \(error.localizedDescription.replacingOccurrences(of: "\n", with: " "))") }
    }
  } catch {}
  if let (x, y) = held { try? await FBSimulatorHIDEvent.touch(direction: .up, x: x, y: y).sendAsync(on: hid) }
  exit(0)
}
RunLoop.main.run()
`;
