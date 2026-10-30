import { randomUUID } from "node:crypto";
import os from "node:os";
import { ENGINE_TOOLS } from "./types.js";

/**
 * Anonymous usage counts for the open-source app, so we know whether people who download Friday get it working and keep using
 * it (Arun, 2026-10-30: "I want to add tracking in the app so we are not clueless and update the readme too").
 *
 * What is sent, all of it, to PostHog over HTTPS:
 *  - a random id made on this computer for this install, tied to nothing else;
 *  - Friday's version, the system (macOS, Windows, Linux) and its architecture, and whether it is the desktop app;
 *  - once a day it is opened, that it was, with the names of the coding tools found and how many are signed in;
 *  - each session started, and whether it is a Code, Work or Crew one;
 *  - once each, the first time a coding tool is ready and the first time an agent finishes a turn.
 *
 * Never: prompts, code, file names or paths, repository names, email addresses, accounts or sign-ins, or anything a tool
 * says. Only the properties listed in `clean`, each with the values it may hold, can leave: nothing else gets through by mistake.
 *
 * Nothing is sent until the app has said so once (the notice on first open, `told`), nor ever with FRIDAY_NO_TELEMETRY=1,
 * DO_NOT_TRACK=1, or Settings › Privacy turned off. No IP-based location, no person profiles; a send that fails is dropped.
 */

/** PostHog's US host, and the project's key: a key that can only send events, made to sit in public code, as a website's does. */
export const USAGE_HOST = "https://us.i.posthog.com";
export const USAGE_KEY = "phc_rvGhDAxsC42q2JobbWM7AExpb2JUHsiU8jv4KpPgr276";

export type Kind = "code" | "work" | "crew";
export type Milestone = "tool_ready" | "first_turn";

export interface UsageState {
  /** Sharing is on in Settings. */
  on: boolean;
  /** The app has shown the notice saying what is sent. */
  told: boolean;
  /** Turned off from outside the app: the variable that did it. */
  offBy: "FRIDAY_NO_TELEMETRY" | "DO_NOT_TRACK" | null;
}

/** Where the counts keep their own few facts: in Friday's own data on this computer (a Redis-like store). */
export interface UsageStore {
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<unknown>;
}

export function offByEnv(env: NodeJS.ProcessEnv = process.env): UsageState["offBy"] {
  const yes = (v: string | undefined) => !!v && v !== "0" && v.toLowerCase() !== "false";
  if (yes(env.FRIDAY_NO_TELEMETRY)) return "FRIDAY_NO_TELEMETRY";
  if (yes(env.DO_NOT_TRACK)) return "DO_NOT_TRACK";
  return null;
}

/**
 * Every property that may leave, by name, and the values it may hold: anything not listed, or not fitting, is dropped. A list
 * rather than a shape, so a later change can't send a folder's or a computer's name by giving it a new property (Security
 * review of v0.2.1, T-2).
 */
const TOOLS = new Set<string>(ENGINE_TOOLS);
const ALLOWED: Record<string, (v: unknown) => boolean> = {
  version: (v) => typeof v === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,6}(-[\w.]{1,40})?$/.test(v),
  os: (v) => v === "macos" || v === "windows" || v === "linux" || v === "other",
  arch: (v) => typeof v === "string" && ["arm64", "x64", "ia32", "arm", "loong64", "ppc64", "riscv64", "s390x"].includes(v),
  app: (v) => v === "desktop" || v === "source",
  kind: (v) => v === "code" || v === "work" || v === "crew",
  tools: (v) => typeof v === "string" && (v === "none" || v.split(",").every((t) => TOOLS.has(t))),
  tools_found: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100,
  tools_ready: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100,
};
export function clean(props: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props)) if (Object.hasOwn(ALLOWED, k) && ALLOWED[k]!(v)) out[k] = v as string | number;
  return out;
}

export const osName = (p: string) => ({ darwin: "macos", win32: "windows", linux: "linux" })[p] ?? "other";

export interface UsageDeps {
  store: UsageStore;
  /** The store's key for these facts. */
  key: string;
  version: () => Promise<string>;
  /** The coding tools found on this computer, and whether each is signed in. */
  tools: () => Promise<{ tool: string; ready: boolean }[]>;
  desktop: boolean;
  env?: NodeJS.ProcessEnv;
  send?: (body: string) => Promise<unknown>;
  now?: () => Date;
}

export function usageCounts(d: UsageDeps) {
  const env = d.env ?? process.env;
  const now = d.now ?? (() => new Date());
  const send =
    d.send ??
    // FRIDAY_USAGE_HOST: somewhere else to send them, for working on Friday itself (a local listener that prints them).
    ((body: string) => fetch(`${env.FRIDAY_USAGE_HOST || USAGE_HOST}/batch/`, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(5_000) }));
  const get = (f: string) => d.store.hget(d.key, f).catch(() => null);
  const set = (f: string, v: string) => d.store.hset(d.key, f, v).catch(() => {});

  const state = async (): Promise<UsageState> => ({ on: (await get("on")) !== "0", told: (await get("told")) === "1", offBy: offByEnv(env) });
  const sharing = async () => {
    const s = await state();
    return s.on && s.told && !s.offBy;
  };
  const id = async () => {
    const had = await get("id");
    if (had) return had;
    const made = randomUUID();
    await set("id", made);
    return made;
  };

  /** One event, or nothing: sharing off, or the send failing, says nothing to anyone. */
  const capture = async (event: string, props: Record<string, unknown> = {}) => {
    if (!(await sharing())) return;
    const properties = {
      ...clean({ ...props, version: await d.version(), os: osName(process.platform), arch: os.arch(), app: d.desktop ? "desktop" : "source" }),
      $process_person_profile: false,
      $geoip_disable: true,
      $lib: "friday-oss",
    };
    const body = JSON.stringify({ api_key: USAGE_KEY, batch: [{ event, distinct_id: await id(), properties, timestamp: now().toISOString() }] });
    await send(body).catch(() => {});
  };

  /** Once for good, the first time it happens on this install. */
  const once = async (m: Milestone) => {
    if (!(await sharing()) || (await get(`m:${m}`)) === "1") return;
    await set(`m:${m}`, "1");
    await capture(m);
  };

  return {
    state,
    /** Settings › Privacy, and the notice: `told` once it has been shown, `on` as the person leaves it. */
    async set(p: { on?: boolean; told?: boolean }) {
      if (p.on !== undefined) await set("on", p.on ? "1" : "0");
      if (p.told) await set("told", "1");
      return state();
    },
    /** Opened today: said once a day, with the tools found. Also when a tool is first ready. Run at start and every hour. */
    async tick() {
      if (!(await sharing())) return;
      const tools = await d.tools().catch(() => []);
      const ready = tools.filter((t) => t.ready).length;
      if (ready) await once("tool_ready");
      const day = now().toISOString().slice(0, 10);
      if ((await get("day")) === day) return;
      await set("day", day);
      await capture("app_active", { tools: tools.map((t) => t.tool).sort().join(",") || "none", tools_found: tools.length, tools_ready: ready });
    },
    sessionStarted: (kind: Kind) => capture("session_started", { kind }),
    once,
  };
}
