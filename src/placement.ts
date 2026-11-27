/**
 * Where a run goes best, among your computers (Arun, 2026-11-21: "map out more advanced machine linking features", spec 09 step 1:
 * "a capabilities card per machine and a Best choice in Runs on, with one line saying why").
 *
 * Each computer answers `machine.facts` (runner/machine-facts.ts) with what it is and what it has now: its system, memory and disk,
 * on power or battery, how busy it is, how much of each coding tool's limit is left, which repos are cloned there, and Xcode,
 * Docker and local models. This file is pure (the client draws with it, the server could place with it): it ranks the computers
 * for a run and says why in plain words, the first reason first.
 *
 * What it never does: weigh one person's account against another's, or answer a tool's limit with the same tool's other account
 * (account-safety-own-plan). It only compares your own computers, each with its own sign-ins.
 */

export interface MachineFacts {
  /** The shape's version, so a newer Friday can tell an older answer. */
  v: 1;
  platform: string;
  arch: string;
  cpus: number;
  memGb: number;
  /** Free space in the home folder's disk, in GB; null when it can't be read. */
  freeDiskGb: number | null;
  /** On mains power, on battery, or not known (a desktop is "ac"). */
  power: "ac" | "battery" | "unknown";
  batteryPercent: number | null;
  /** The one-minute load average over the cores, 0 when idle and about 1 when every core is busy (Windows: null). */
  load: number | null;
  /** Agents running on this computer now. */
  agents: number;
  /** Each coding tool's limit used, 0 to 100, by its fullest window, and when that window resets (unix seconds). */
  limits: Partial<Record<string, { usedPercent: number; resetsAt: number | null; window: string }>>;
  /** Repos cloned here, by their GitHub name ("acme/storefront") or folder name when there's no remote. */
  repos: { name: string; path: string }[];
  xcode: boolean;
  docker: boolean;
  /** A local model server answering on this computer (Ollama, LM Studio). */
  localModels: string[];
  /** When it was read, in ms. */
  at: number;
}

/** A computer as placement sees it: this one ("" id) or a linked one, with what it said. */
export interface PlaceCandidate {
  id: string;
  name: string;
  connected: boolean;
  /** The coding tools signed in there. */
  tools: { tool: string; name: string; loggedIn?: boolean | null }[];
  facts?: MachineFacts | null;
}

/** What the run needs, as far as the page knows it before it starts. */
export interface PlaceAsk {
  /** The coding tool picked ("claude", "codex"...), when one is. */
  tool?: string;
  /** The repo it works on, as "owner/name" or a folder name. */
  repo?: string;
  /** It builds an iOS app: only a Mac with Xcode can. */
  ios?: boolean;
}

export interface Placement {
  id: string;
  name: string;
  /** Higher is better; only the order matters. */
  score: number;
  /** Can it take this run at all. */
  ok: boolean;
  /** Why, in short plain phrases, best first: "on power", "Claude Code 12% used", "storefront is here". */
  why: string[];
  /** Why not, when it can't. */
  not?: string;
}

const TOOL_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", kilo: "Kilo", amp: "Amp", gemini: "Gemini CLI", copilot: "Copilot", opencode: "OpenCode", qwen: "Qwen Code", goose: "Goose", auggie: "Auggie", aider: "Aider", crush: "Crush" };
export const toolName = (t: string) => TOOL_NAMES[t] ?? t;

/** "acme/storefront" from a remote URL, or the folder's own name. */
export function repoKey(remote: string | undefined, folder: string): string {
  const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote ?? "");
  return (m?.[1] ?? folder).toLowerCase();
}

const sameRepo = (a: string, b: string) => {
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
};

/** Each computer ranked for the run, best first. A computer that can't take it comes after every one that can. */
export function rankComputers(list: PlaceCandidate[], ask: PlaceAsk = {}): Placement[] {
  const out = list.map((c): Placement => {
    const f = c.facts ?? null;
    const why: string[] = [];
    let score = 0;
    const fail = (not: string): Placement => ({ id: c.id, name: c.name, score: -1, ok: false, why: [], not });
    if (!c.connected) return fail("Not connected");
    const signed = c.tools.filter((t) => t.loggedIn === true);
    if (ask.tool && !signed.some((t) => t.tool === ask.tool)) return fail(`${toolName(ask.tool)} isn't signed in there`);
    if (!ask.tool && !signed.length) return fail("No coding tool signed in");
    if (ask.ios && !(f?.platform === "darwin" && f.xcode)) return fail("iOS needs a Mac with Xcode");
    if (!f) {
      // An older Friday there: it can run the work, nothing more is known.
      return { id: c.id, name: c.name, score: 10, ok: true, why: ["Ready"] };
    }
    // The tool's limit: the biggest thing that stops a run partway.
    const lim = ask.tool ? f.limits[ask.tool] : undefined;
    if (lim) {
      if (lim.usedPercent >= 98) return fail(`${toolName(ask.tool!)} is out of its ${lim.window} limit`);
      score += (100 - lim.usedPercent) * 0.6;
      why.push(`${toolName(ask.tool!)} ${Math.round(lim.usedPercent)}% used`);
    } else score += 30;
    // The repo already there: no clone, its dependencies installed.
    if (ask.repo && f.repos.some((r) => sameRepo(r.name, ask.repo!))) {
      score += 25;
      why.unshift(`${ask.repo.split("/").pop()} is here`);
    }
    // Power: a laptop on battery is the last choice, and a low one is no choice.
    if (f.power === "battery") {
      if ((f.batteryPercent ?? 100) < 15) return fail(`On battery at ${f.batteryPercent}%`);
      score -= 25;
      why.push(`on battery${f.batteryPercent != null ? ` (${f.batteryPercent}%)` : ""}`);
    } else if (f.power === "ac") {
      score += 10;
      why.push("on power");
    }
    // Busy: agents already running and a loaded processor.
    score -= f.agents * 6;
    if (f.agents) why.push(`${f.agents} agent${f.agents === 1 ? "" : "s"} running`);
    if (f.load != null && f.load > 0.8) {
      score -= 15;
      why.push("busy");
    } else if (!f.agents) why.push("idle");
    if (f.freeDiskGb != null && f.freeDiskGb < 5) {
      score -= 20;
      why.push(`${Math.round(f.freeDiskGb)} GB free`);
    }
    score += Math.min(f.memGb, 64) / 8 + Math.min(f.cpus, 16) / 4;
    if (ask.ios) why.unshift("Xcode");
    return { id: c.id, name: c.name, score, ok: true, why };
  });
  return out.sort((a, b) => Number(b.ok) - Number(a.ok) || b.score - a.score);
}

/** The best computer for the run and the line that says why ("Mac mini: on power, Claude Code 12% used"), or null if none can. */
export function bestComputer(list: PlaceCandidate[], ask: PlaceAsk = {}): Placement | null {
  const [top] = rankComputers(list, ask);
  return top?.ok ? top : null;
}

/** How full a computer is, 0 to 1, for drawing: agents and load together. */
export function busyness(f: MachineFacts | null | undefined): number {
  if (!f) return 0;
  return Math.min(1, Math.max(f.load ?? 0, f.agents / 4));
}
