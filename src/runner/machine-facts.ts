/**
 * What this computer is and has right now, for placement (placement.ts) and the map of your computers (spec 09 step 1): read
 * here, on the computer itself, and answered to `machine.facts` (local-api.ts callHost), so a linked computer says it over its
 * link the way it says its tools. Kept for 20 seconds: the page asks every few seconds and the readings are not free.
 *
 * Everything is read the system's own way, nothing installed: os for the system, memory and load; statfs for the disk; pmset
 * (macOS), /sys/class/power_supply (Linux) or Win32_Battery (Windows) for power; the limits Friday already reads (limits.ts,
 * without asking Claude Code anew); the recent repos the folder picker offers; xcode-select, docker on the PATH, and a local
 * model server's own port.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MachineFacts } from "../placement.js";
import { repoKey } from "../placement.js";

const run = (cmd: string, args: string[], ms = 2500): Promise<string> =>
  new Promise((resolve) => execFile(cmd, args, { timeout: ms, windowsHide: true }, (err, out) => resolve(err ? "" : String(out))));

const onPath = (bin: string): boolean => {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  const names = process.platform === "win32" ? [`${bin}.exe`, `${bin}.cmd`] : [bin];
  return dirs.some((d) => d && names.some((n) => existsSync(path.join(d, n))));
};

/** On power or battery, and how full. */
export async function readPower(platform = process.platform): Promise<{ power: MachineFacts["power"]; batteryPercent: number | null }> {
  if (platform === "darwin") {
    const out = await run("pmset", ["-g", "batt"]);
    if (!out) return { power: "unknown", batteryPercent: null };
    const pct = /(\d+)%/.exec(out);
    return { power: /'Battery Power'/.test(out) ? "battery" : "ac", batteryPercent: pct ? Number(pct[1]) : null };
  }
  if (platform === "linux") {
    const base = "/sys/class/power_supply";
    let names: string[] = [];
    try {
      names = readdirSync(base);
    } catch {
      return { power: "unknown", batteryPercent: null };
    }
    const read = (n: string, f: string) => {
      try {
        return readFileSync(path.join(base, n, f), "utf8").trim();
      } catch {
        return "";
      }
    };
    const bat = names.find((n) => read(n, "type") === "Battery");
    const mains = names.find((n) => read(n, "type") === "Mains");
    const pct = bat ? Number(read(bat, "capacity")) || null : null;
    if (!bat) return { power: "ac", batteryPercent: null };
    const online = mains ? read(mains, "online") === "1" : read(bat, "status") !== "Discharging";
    return { power: online ? "ac" : "battery", batteryPercent: pct };
  }
  if (platform === "win32") {
    const out = await run("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Battery | Select-Object -First 1 BatteryStatus,EstimatedChargeRemaining | ConvertTo-Json"], 4000);
    if (!out.trim()) return { power: "ac", batteryPercent: null };
    try {
      const j = JSON.parse(out) as { BatteryStatus?: number; EstimatedChargeRemaining?: number };
      // 2 is "on AC"; 1 is discharging.
      return { power: j.BatteryStatus === 1 ? "battery" : "ac", batteryPercent: j.EstimatedChargeRemaining ?? null };
    } catch {
      return { power: "unknown", batteryPercent: null };
    }
  }
  return { power: "unknown", batteryPercent: null };
}

/** Each tool's fullest window: what stops a run partway. */
export function limitSummary(l: {
  claudeWindows?: { utilization: number | null; resetsAt: number | null; kind: string | null; label?: string }[];
  codexWindows?: { usedPercent: number | null; resetsAt: number | null; windowMinutes: number | null }[];
  tools?: Partial<Record<string, { windows: { usedPercent: number | null; resetsAt?: number | null; windowMinutes: number | null }[] }>>;
}): MachineFacts["limits"] {
  const out: MachineFacts["limits"] = {};
  const name = (min: number | null | undefined) => (min === 300 ? "5-hour" : min === 10080 ? "weekly" : min ? "plan" : "plan");
  const put = (tool: string, used: number | null | undefined, resetsAt: number | null | undefined, window: string) => {
    if (used == null || !Number.isFinite(used)) return;
    const cur = out[tool];
    if (!cur || used > cur.usedPercent) out[tool] = { usedPercent: Math.round(Math.max(0, Math.min(100, used)) * 10) / 10, resetsAt: resetsAt ?? null, window };
  };
  for (const w of l.claudeWindows ?? []) put("claude", w.utilization == null ? null : w.utilization * 100, w.resetsAt, /five|session/i.test(w.kind ?? "") ? "5-hour" : "weekly");
  for (const w of l.codexWindows ?? []) put("codex", w.usedPercent, w.resetsAt, name(w.windowMinutes));
  for (const [tool, a] of Object.entries(l.tools ?? {})) for (const w of a?.windows ?? []) put(tool, w.usedPercent, w.resetsAt ?? null, name(w.windowMinutes));
  return out;
}

/** A local model server on its usual port, asked for a moment. */
async function localModels(): Promise<string[]> {
  const ask = async (name: string, url: string) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(400) });
      return r.ok ? name : null;
    } catch {
      return null;
    }
  };
  const got = await Promise.all([ask("Ollama", "http://127.0.0.1:11434/api/tags"), ask("LM Studio", "http://127.0.0.1:1234/v1/models")]);
  return got.filter((x): x is string => !!x);
}

let kept: { at: number; value: Promise<MachineFacts> } | null = null;
const KEEP_MS = 20_000;

/** This computer's facts, read at most every 20 seconds. `agents`: how many agents run here now. */
export function machineFacts(agents: number): Promise<MachineFacts> {
  if (kept && Date.now() - kept.at < KEEP_MS) return kept.value.then((f) => ({ ...f, agents }));
  const value = readFacts(agents);
  kept = { at: Date.now(), value };
  value.catch(() => (kept = null));
  return value;
}

async function readFacts(agents: number): Promise<MachineFacts> {
  const home = os.homedir();
  const [power, disk, limits, repos, xcode, models] = await Promise.all([
    readPower(),
    statfs(home).then((s) => (s.bavail * s.bsize) / 1e9, () => null),
    import("./limits.js").then((m) => m.readLimits({ askClaude: false })).then(limitSummary, () => ({})),
    import("./workspace.js").then((m) => m.recentReposCached()).then(
      (list) => list.filter((f) => f.isRepo).map((f) => ({ name: repoKey(f.remote, f.name), path: f.path })),
      () => [],
    ),
    process.platform === "darwin" ? run("xcode-select", ["-p"]).then((o) => /Xcode\.app/.test(o)) : Promise.resolve(false),
    localModels(),
  ]);
  const cpus = os.cpus().length || 1;
  return {
    v: 1,
    platform: process.platform,
    arch: process.arch,
    cpus,
    memGb: Math.round(os.totalmem() / 1e9),
    freeDiskGb: disk == null ? null : Math.round(disk),
    power: power.power,
    batteryPercent: power.batteryPercent,
    load: process.platform === "win32" ? null : Math.round((os.loadavg()[0] / cpus) * 100) / 100,
    agents,
    limits,
    repos,
    xcode,
    docker: onPath("docker"),
    localModels: models,
    at: Date.now(),
  };
}
