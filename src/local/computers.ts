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

interface Conn {
  ws: WebSocket;
  name: string;
  platform: string;
  tools: MachineTool[];
  since: number;
  waits: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; progress?: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }>;
}

export interface LinkedComputer {
  id: string;
  label: string;
  connected: boolean;
  platform?: string;
  tools?: MachineTool[];
  since?: number;
}

export class LocalLinks {
  private conns = new Map<string, Conn>();
  /** A computer linked (or linked again): its teammates come back to it (app.ts). */
  onLinked: ((id: string) => void) | null = null;

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
        // The same computer linking again (a restart, a new network): the old link goes, and whatever waited on it hears so.
        this.drop(id, "That computer linked again.");
        conn = { ws, name: label, platform: m.machine?.platform ?? "", tools: Array.isArray(m.tools) ? m.tools : [], since: Date.now(), waits: new Map() };
        this.conns.set(id, conn);
        ws.send(JSON.stringify({ kind: "linked", owner: this.me }));
        console.log(`[computers] ${label} linked`);
        this.onLinked?.(id);
        return;
      }
      if (!conn) return;
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

  private drop(id: string, why: string): void {
    const c = this.conns.get(id);
    if (!c) return;
    this.conns.delete(id);
    for (const w of c.waits.values()) (clearTimeout(w.timer), w.reject(new Error(why)));
    c.waits.clear();
    if (c.ws.readyState === WebSocket.OPEN) c.ws.close(4002, why);
  }

  /** A computer removed in Settings: its link closed now, not only its next one refused. */
  forget(id: string): void {
    this.drop(id, "This computer was removed from Friday.");
  }

  /** The computers linked now, for Settings and the "runs on" choices. */
  list(): LinkedComputer[] {
    return [...this.conns.entries()].map(([id, c]) => ({ id, label: c.name, connected: true, platform: c.platform, tools: c.tools, since: c.since }));
  }

  // ── what app.ts asks of the links (as of NoLinks and the hosted LinkRegistry) ──

  /** This computer's own link, for a person: none, since its own runner is in-process (app.ts localHost). */
  tokenFor(_userId: string): string | null {
    return null;
  }
  connected(id: string): boolean {
    return this.conns.has(id);
  }
  status(id: string): { connected: boolean; tools?: MachineTool[] } {
    const c = this.conns.get(id);
    return c ? { connected: true, tools: c.tools } : { connected: false };
  }
  async owner(id: string): Promise<{ id: string; name: string } | null> {
    return this.conns.has(id) ? this.me : null;
  }
  async machineToken(_userId: string, id: string): Promise<{ token: string; label: string } | null> {
    const c = this.conns.get(id);
    return c ? { token: id, label: c.name } : null;
  }
  call<T = unknown>(id: string, method: string, params: Record<string, unknown>, ms = 60_000, onProgress?: (v: unknown) => void): Promise<T> {
    const c = this.conns.get(id);
    if (!c || c.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("That computer isn't connected to Friday right now."));
    const callId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => (c.waits.delete(callId), reject(new Error(`${c.name} didn't answer in time.`))), ms);
      c.waits.set(callId, { resolve: resolve as (v: unknown) => void, reject, ...(onProgress ? { progress: onProgress } : {}), timer });
      c.ws.send(JSON.stringify({ kind: "call", id: callId, method, params }));
    });
  }
}
