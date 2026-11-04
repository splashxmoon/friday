import { randomUUID } from "node:crypto";
import type http from "node:http";
import WebSocket from "ws";
import type { MachineTool } from "../types.js";

/**
 * Your other computers, linked to the Friday on this one (Arun, 2026-10-30: "lets also add support for multi machine for coding
 * and crew"). A computer pairs once with the code in Settings › Your computers, as a phone does (phone.ts), and from then on its
 * Friday holds a link here over Wi-Fi or Tailscale: the same link a linked machine holds to the hosted Friday (runner/host.ts),
 * so starting Claude Code, Codex or any other tool there, listing its folders and its tools, all go the way they go there
 * (app.ts /api/runner/*, `links.call`). Nothing goes through Friday's servers.
 *
 * In place of the open-source edition's NoLinks: every question it answered "no" to is answered for the computers linked now.
 * A computer is known here by its device id; this computer itself is never one of them (its own runner is in-process).
 */

/** Closing a computer's older link because the same computer linked again: not "removed" (4002), which ends its service for good. */
export const LINKED_AGAIN = 4012;

interface Conn {
  ws: WebSocket;
  name: string;
  platform: string;
  /** What that computer calls itself (its host name), and the address it linked from: two of yours can share a name. */
  host: string;
  address: string;
  tools: MachineTool[];
  since: number;
  waits: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; progress?: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }>;
}

export interface LinkedComputer {
  id: string;
  label: string;
  connected: boolean;
  platform?: string;
  host?: string;
  address?: string;
  tools?: MachineTool[];
  since?: number;
}

/** What a computer says of itself as it links, kept with its pairing (phone.ts note) so a row says it when it is offline too. */
export interface ComputerHello {
  host: string;
  platform: string;
  address: string;
}

/** A computer's system as a person says it. */
export const platformName = (p: string | undefined): string => ({ darwin: "macOS", linux: "Linux", win32: "Windows" })[p ?? ""] ?? (p || "");

/**
 * What tells two of your computers with the same name apart, on their row and in "Runs on": its system, and its host name when
 * that isn't its name, else the address it links from (2026-11-04 linking test: every entry said "Arun's Mac Studio").
 */
export function computerDetail(c: { label?: string; name?: string; platform?: string; host?: string; address?: string }): string {
  const name = (c.label ?? c.name ?? "").toLowerCase();
  const host = c.host && c.host.toLowerCase() !== name ? c.host : "";
  return [platformName(c.platform), host || c.address || ""].filter(Boolean).join(" · ");
}

export class LocalLinks {
  private conns = new Map<string, Conn>();
  /** A computer linked (or linked again): its teammates come back to it (app.ts). */
  onLinked: ((id: string) => void) | null = null;
  /** What it said of itself as it linked (app.ts keeps it with the pairing). */
  onHello: ((id: string, hello: ComputerHello) => void) | null = null;
  /** Pages with a terminal open on one of these computers, by the page's own key: which computer, and how to tell it. */
  private termPages = new Map<string, { id: string; send: (m: unknown) => void; gone?: (why: string) => void }>();
  /** The Friday each computer runs, as it said when it linked (phone.ts /phone/hello): a call it can't answer says so. */
  private versions = new Map<string, string>();
  /** The name each computer had when it last linked. */
  private names = new Map<string, string>();
  /** The ids a computer had before it was paired again, each to the id it has now (app.ts keeps them). */
  private aliases = new Map<string, string>();

  constructor(private me: { id: string; name: string }) {}

  /**
   * A paired computer's link, as the device listener hands it over (phone.ts marks it `x-friday-via: computer` with the device
   * it is, once its token checked out): its hello, then calls both ways until it goes.
   */
  accept(ws: WebSocket, req: http.IncomingMessage): void {
    const id = String(req.headers["x-friday-device"] ?? "");
    if (req.headers["x-friday-via"] !== "computer" || !/^[0-9a-f]{16}$/.test(id)) {
      ws.close(4003, "Only a computer paired in Settings › Your computers links here.");
      return;
    }
    let label = "Computer";
    try {
      label = decodeURIComponent(String(req.headers["x-friday-device-name"] ?? "")).slice(0, 60) || label;
    } catch {
      // A name that didn't decode: the plain word does.
    }
    const address = String(req.headers["x-friday-device-address"] ?? "").replace(/^::ffff:/, "").slice(0, 64);
    let conn: Conn | null = null;
    const hello = setTimeout(() => !conn && ws.close(1008, "Expected a hello"), 15_000);
    ws.on("message", (raw) => {
      let m: { kind?: string; machine?: { name?: string; platform?: string }; tools?: MachineTool[]; id?: string; ok?: boolean; value?: unknown; error?: string };
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (m.kind === "hello" && !conn) {
        clearTimeout(hello);
        // The same computer linking again (a restart, a new network): the old link goes, and whatever waited on it hears so. With
        // a code of its own: "removed" (4002) here made a computer's service stop for good when its old link was still open.
        this.drop(id, "That computer linked again.", LINKED_AGAIN);
        const host = String(m.machine?.name ?? "").slice(0, 60);
        const platform = String(m.machine?.platform ?? "").slice(0, 20);
        conn = { ws, name: label, platform, host, address, tools: Array.isArray(m.tools) ? m.tools : [], since: Date.now(), waits: new Map() };
        this.conns.set(id, conn);
        this.names.set(id, label);
        ws.send(JSON.stringify({ kind: "linked", owner: this.me }));
        console.log(`[computers] ${label} linked${address ? ` from ${address}` : ""}`);
        this.onHello?.(id, { host, platform, address });
        this.onLinked?.(id);
        return;
      }
      if (!conn) return;
      // A terminal's output or its exit, for the page that opened it there (termOpen), and only if that page is this computer's.
      if (m.kind === "term") {
        const owner = (m as { owner?: unknown }).owner;
        const page = typeof owner === "string" ? this.termPages.get(owner) : undefined;
        if (page && page.id === id) page.send(m);
        return;
      }
      if (m.kind === "tools" && Array.isArray(m.tools)) conn.tools = m.tools;
      else if ((m.kind === "result" || m.kind === "progress") && typeof m.id === "string") {
        const w = conn.waits.get(m.id);
        if (!w) return;
        if (m.kind === "progress") return void w.progress?.(m.value);
        clearTimeout(w.timer);
        conn.waits.delete(m.id);
        if (m.ok) w.resolve(m.value);
        else w.reject(new Error(m.error || `${label} couldn't do that.`));
      }
    });
    ws.on("close", () => {
      clearTimeout(hello);
      if (conn && this.conns.get(id) === conn) {
        this.drop(id, `${label} went offline.`);
        console.log(`[computers] ${label} went offline`);
      }
    });
    ws.on("error", () => {});
  }

  private drop(id: string, why: string, code = 4002): void {
    const c = this.conns.get(id);
    if (!c) return;
    this.conns.delete(id);
    for (const w of c.waits.values()) (clearTimeout(w.timer), w.reject(new Error(why)));
    c.waits.clear();
    // Its shells went with it: the pages showing them start again once it is back, rather than typing into nothing.
    for (const [owner, p] of this.termPages) if (p.id === id) (this.termPages.delete(owner), p.gone?.(why));
    if (c.ws.readyState === WebSocket.OPEN) c.ws.close(code, why);
  }

  /** A computer renamed in Settings: its link says the new name at once. */
  rename(id: string, name: string): void {
    const c = this.conns.get(id);
    if (c) c.name = name;
    if (this.names.has(id)) this.names.set(id, name);
  }

  /** The Friday version a computer said it runs (phone.ts /phone/hello). */
  said(id: string, version: string): void {
    this.versions.set(id, version.slice(0, 40));
  }

  /** The same computer paired again under a new id: what ran on the old one is that computer's still (reattach, lanes). */
  alias(old: string, now: string): void {
    if (old !== now) this.aliases.set(old, now);
    // One step at most: an id that was itself replaced points at the newest.
    for (const [k, v] of this.aliases) if (v === old) this.aliases.set(k, now);
  }

  /** The id a computer has now, from one it had (EngineInfo.computer, a teammate's machine). */
  current(id: string): string {
    return this.aliases.get(id) ?? id;
  }

  /** The ids a computer had before, for the lanes they still carry. */
  formerly(id: string): string[] {
    return [...this.aliases].filter(([, v]) => v === id).map(([k]) => k);
  }

  /** Every id a computer had before and the one it has now, to keep through a restart (app.ts). */
  aliasMap(): Record<string, string> {
    return Object.fromEntries(this.aliases);
  }

  /** The Friday version a computer said it runs, when it said one since Friday opened. */
  version(id: string): string | undefined {
    return this.versions.get(this.current(id));
  }

  /** What a computer is called here, when it is linked now (null when it isn't). */
  label(id: string): string | null {
    return this.conns.get(this.current(id))?.name ?? null;
  }

  /** What a computer was called when it was last linked since Friday opened, linked now or not. */
  known(id: string): string | null {
    return this.names.get(this.current(id)) ?? null;
  }

  /** A computer removed in Settings: its link closed now, not only its next one refused. */
  forget(id: string): void {
    this.drop(id, "This computer was removed from Friday.");
  }

  // ── Terminals on another computer (runner/terminals.ts there), as the hosted LinkRegistry carries them ──

  /** A page's terminals on computer `id`: what comes back for `owner` goes to `send`, and `gone` hears that computer go. */
  termOpen(id: string, owner: string, send: (m: unknown) => void, gone?: (why: string) => void): void {
    this.termPages.set(owner, { id: this.current(id), send, ...(gone ? { gone } : {}) });
  }

  /** Something the page asked of its terminals (start, write, resize, kill), sent on as that page's. */
  termSend(id: string, owner: string, m: Record<string, unknown>): void {
    id = this.current(id);
    if (this.termPages.get(owner)?.id !== id) return;
    const c = this.conns.get(id);
    if (c?.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ ...m, kind: "term", owner }));
  }

  /** The page is gone: its shells go too. */
  termClose(id: string, owner: string): void {
    id = this.current(id);
    if (this.termPages.get(owner)?.id !== id) return;
    this.termPages.delete(owner);
    const c = this.conns.get(id);
    if (c?.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ kind: "term", op: "drop", owner }));
  }

  /** The computers linked now, for Settings and the "runs on" choices. */
  list(): LinkedComputer[] {
    return [...this.conns.entries()].map(([id, c]) => ({ id, label: c.name, connected: true, platform: c.platform, host: c.host, address: c.address, tools: c.tools, since: c.since }));
  }

  // ── what app.ts asks of the links (as of NoLinks and the hosted LinkRegistry) ──

  /** This computer's own link, for a person: none, since its own runner is in-process (app.ts localHost). */
  tokenFor(_userId: string): string | null {
    return null;
  }
  // Each by the id a computer has now, from any it had: a session or teammate made on it before it was paired again (added again
  // by SSH, re-paired) still names the old one, and its agent, terminal and tools were asked of nothing (2026-11-04 linking test).
  connected(id: string): boolean {
    return this.conns.has(this.current(id));
  }
  status(id: string): { connected: boolean; tools?: MachineTool[] } {
    const c = this.conns.get(this.current(id));
    return c ? { connected: true, tools: c.tools } : { connected: false };
  }
  async owner(id: string): Promise<{ id: string; name: string } | null> {
    return this.conns.has(this.current(id)) ? this.me : null;
  }
  async machineToken(_userId: string, id: string): Promise<{ token: string; label: string } | null> {
    const now = this.current(id);
    const c = this.conns.get(now);
    return c ? { token: now, label: c.name } : null;
  }
  call<T = unknown>(id: string, method: string, params: Record<string, unknown>, ms = 60_000, onProgress?: (v: unknown) => void): Promise<T> {
    id = this.current(id);
    const c = this.conns.get(id);
    if (!c || c.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("That computer isn't connected to Friday right now."));
    const callId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => (c.waits.delete(callId), reject(new Error(`${c.name} didn't answer in time.`))), ms);
      // A call its Friday doesn't have (an older version there): said plainly, with both versions, rather than "Unknown request".
      const refused = (e: Error) =>
        reject(/^Unknown request/.test(e.message) ? new Error(`${c.name} runs ${this.versions.has(id) ? `Friday ${this.versions.get(id)}` : "an older Friday"}, which can't do that yet. Update Friday there, then try again.`) : e);
      c.waits.set(callId, { resolve: resolve as (v: unknown) => void, reject: refused, ...(onProgress ? { progress: onProgress } : {}), timer });
      c.ws.send(JSON.stringify({ kind: "call", id: callId, method, params }));
    });
  }
}
