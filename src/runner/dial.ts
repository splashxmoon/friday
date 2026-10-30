import { X509Certificate } from "node:crypto";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import type { ClientOptions } from "ws";

/**
 * How this computer reaches another computer's Friday (Arun, 2026-10-30: "lets also add support for multi machine for coding and
 * crew"): with the token it was paired with, and only to the certificate it pinned when it paired. That Friday's certificate is
 * one it made itself, which no authority signed; it is right only if it is that exact one. Everything that dials Friday from
 * here (the computer's link, each agent's runner, an attachment fetched for a turn) asks this first; a server nobody pinned is
 * dialled as it always was.
 */

export interface Pin {
  /** The device token this computer was given when it paired. */
  token: string;
  /** The certificate it must present, as PEM, and its SHA-256 as hex. Absent for plain http (Tailscale, which encrypts itself). */
  pem?: string;
  fingerprint?: string;
}

const pins = new Map<string, Pin>();
const originOf = (url: string) => new URL(url.replace(/^ws/, "http")).origin;

export function pinServer(url: string, pin: Pin): void {
  pins.set(originOf(url), pin);
}
export function unpinServer(url: string): void {
  pins.delete(originOf(url));
}
export const pinFor = (url: string): Pin | undefined => {
  try {
    return pins.get(originOf(url));
  } catch {
    return undefined;
  }
};

export const fingerprintOf = (der: Buffer) => new X509Certificate(der).fingerprint256.replace(/:/g, "").toLowerCase();

/** The TLS half: its own certificate as the only authority, and that one only by its fingerprint (its name is an address). */
function tlsFor(pin: Pin): Pick<tls.ConnectionOptions, "ca" | "checkServerIdentity"> {
  if (!pin.pem) return {};
  return {
    ca: pin.pem,
    checkServerIdentity: (_host, cert) => (cert.raw && fingerprintOf(cert.raw) === pin.fingerprint ? undefined : new Error("That isn't the computer this one was paired with.")),
  };
}

/** What a WebSocket to `url` is opened with: nothing for a server nobody pinned. */
export function dialOptions(url: string): ClientOptions {
  const pin = pinFor(url);
  if (!pin) return {};
  // ws hands these to tls.connect as they are; its own type for checkServerIdentity is narrower than what tls takes.
  return { headers: { Authorization: `Bearer ${pin.token}` }, ...tlsFor(pin) } as unknown as ClientOptions;
}

/** A GET of `url` as bytes, pinned when its server is: fetch() can't be held to one certificate. */
export async function getBytes(url: string, ms = 60_000): Promise<{ status: number; body: Buffer }> {
  const pin = pinFor(url);
  if (!pin) {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
  }
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(u, { headers: { Authorization: `Bearer ${pin.token}` }, timeout: ms, ...(u.protocol === "https:" ? tlsFor(pin) : {}) }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (d: Buffer) => parts.push(d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

/** A request with a JSON body to a pinned server, for pairing and the like: its status and the JSON it answered. */
export async function postJson(url: string, body: unknown, pin: Partial<Pin> = {}, ms = 10_000): Promise<{ status: number; json: Record<string, unknown> }> {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = lib.request(
      u,
      {
        method: "POST",
        timeout: ms,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...(pin.token ? { Authorization: `Bearer ${pin.token}` } : {}) },
        ...(u.protocol === "https:" && pin.pem ? tlsFor(pin as Pin) : {}),
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            // Not JSON: the status says what happened.
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end(data);
  });
}

/**
 * The certificate a computer presents at host:port, read without trusting it, to be checked against the fingerprint in the
 * code the person copied before anything is sent to it. Null when it presents one that isn't that.
 */
export function certAt(host: string, port: number, fingerprint: string, ms = 8000): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: undefined, rejectUnauthorized: false, timeout: ms }, () => {
      const cert = sock.getPeerX509Certificate();
      sock.end();
      if (!cert) return resolve(null);
      resolve(cert.fingerprint256.replace(/:/g, "").toLowerCase() === fingerprint ? cert.toString() : null);
    });
    sock.on("timeout", () => (sock.destroy(), reject(new Error("timed out"))));
    sock.on("error", reject);
  });
}
