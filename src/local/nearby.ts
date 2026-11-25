import dgram from "node:dgram";
import os from "node:os";
import { parseComputerLink } from "./join.js";

/**
 * Linking your computers in two clicks (Arun, 2026-11-21: "make it way easier to link up machines too"). Before this, adding one
 * meant copying a link or a command from one computer to the other. Now each Friday on the same network can be found from the
 * other: Add a computer lists the ones nearby, Link sends that one an offer, and it asks its person "Allow?", showing a six-digit
 * check number both screens show. Yes, and it pairs with the offer's link exactly as a pasted one does (join.ts): the same
 * one-time code, the same pinned certificate. Nothing here can link anything by itself.
 *
 * On the wire: small JSON over UDP on one port (4391), on the local network only.
 * - "who": broadcast by a Friday looking; every Friday that hears it answers "here" to the sender with its name, system, Friday
 *   version, and the certificate of the computer it's already used from, if any (so the list can say "Linked").
 * - "offer": sent to one Friday, by id: who it's from and the link. It is kept for that link's ten minutes until its person
 *   answers. A Friday that isn't named ignores it.
 * The check number comes from the certificate in the link: the computer sending it shows the same number from its own, so an
 * offer from anyone else shows a number that doesn't match.
 */

export const NEARBY_PORT = 4391;

export interface NearbyFound {
  id: string;
  name: string;
  platform: string;
  version: string;
  address: string;
  /** The certificate of the Friday it's used from, if it's paired with one. */
  pairedWith: string | null;
}

export interface NearbyOffer {
  /** Who it's from: that Friday's id and its computer's name. */
  from: string;
  name: string;
  check: string;
  until: number;
  link: string;
  address: string;
}

/** Six digits from a certificate's fingerprint, as "482 913": what both screens show when one computer offers to link. */
export function checkNumber(fingerprint: string): string {
  const n = parseInt(fingerprint.replace(/[^0-9a-f]/gi, "").slice(0, 10) || "0", 16) % 1_000_000;
  const s = String(n).padStart(6, "0");
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}

/** Each network's broadcast address, and the general one: Wi-Fi drops the general one on some routers. */
function broadcasts(): string[] {
  const out = new Set(["255.255.255.255"]);
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal || !a.netmask) continue;
      const ip = a.address.split(".").map(Number), mask = a.netmask.split(".").map(Number);
      out.add(ip.map((b, i) => (b & mask[i]!) | (~mask[i]! & 255)).join("."));
    }
  return [...out];
}

export class Nearby {
  private sock: dgram.Socket | null = null;
  private offers = new Map<string, NearbyOffer>();
  /** An offer came: this computer's page is told, rather than asking every few seconds (app.ts, spec 13). */
  onChange: (() => void) | null = null;

  constructor(
    private o: {
      id: string;
      name: () => string;
      version: string;
      /** The certificate of the Friday this one is used from, if any. */
      pairedWith: () => Promise<string | null>;
      /** Where it listens; FRIDAY_NEARBY_PORT for two Fridays on one computer (tests). */
      port?: number;
      /** The ports it asks on when it looks: FRIDAY_NEARBY_PORTS, else the one port. */
      ask?: number[];
      log?: (line: string) => void;
    },
  ) {}

  get port() {
    return this.o.port ?? NEARBY_PORT;
  }

  /** Listens for "who" and "offer". A port already taken (another Friday here) leaves this one findable by nobody, said once. */
  start(): Promise<void> {
    return new Promise((resolve) => {
      const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
      s.on("error", (e) => {
        this.o.log?.(`nearby: ${e.message}`);
        s.close();
        this.sock = null;
        resolve();
      });
      s.on("message", (buf, from) => void this.heard(buf, from));
      s.bind(this.port, () => {
        s.setBroadcast(true);
        this.sock = s;
        resolve();
      });
    });
  }

  stop() {
    this.sock?.close();
    this.sock = null;
  }

  private async heard(buf: Buffer, from: dgram.RemoteInfo) {
    if (buf.length > 4096) return;
    let m: { t?: string; id?: string; to?: string; name?: string; link?: string; v?: number };
    try {
      m = JSON.parse(String(buf));
    } catch {
      return;
    }
    if (m.id === this.o.id) return;
    if (m.t === "who") {
      const here = { t: "here", v: 1, id: this.o.id, name: this.o.name(), platform: process.platform, version: this.o.version, pairedWith: await this.o.pairedWith().catch(() => null) };
      this.sock?.send(JSON.stringify(here), from.port, from.address);
      return;
    }
    if (m.t === "offer" && m.to === this.o.id && typeof m.link === "string" && typeof m.id === "string") {
      const parsed = parseComputerLink(m.link);
      if (!parsed?.hub.fingerprint) return;
      const name = String(m.name ?? parsed.hub.name).replace(/\s+/g, " ").slice(0, 60);
      this.offers.set(m.id, { from: m.id, name, check: checkNumber(parsed.hub.fingerprint), until: Date.now() + 10 * 60_000, link: m.link.slice(0, 2000), address: from.address });
      this.o.log?.(`nearby: ${name} offered to link from ${from.address}`);
      this.onChange?.();
    }
  }

  /** The Fridays on this network that answer within `ms`. */
  find(ms = 1200): Promise<NearbyFound[]> {
    return new Promise((resolve) => {
      const s = dgram.createSocket("udp4");
      const found = new Map<string, NearbyFound>();
      s.on("error", () => (s.close(), resolve([...found.values()])));
      s.on("message", (buf, from) => {
        try {
          const m = JSON.parse(String(buf)) as Partial<NearbyFound> & { t?: string };
          if (m.t !== "here" || !m.id || m.id === this.o.id) return;
          found.set(m.id, { id: m.id, name: String(m.name ?? "A computer").slice(0, 60), platform: String(m.platform ?? ""), version: String(m.version ?? ""), address: from.address, pairedWith: m.pairedWith ?? null });
        } catch {}
      });
      s.bind(0, () => {
        s.setBroadcast(true);
        const msg = JSON.stringify({ t: "who", v: 1, id: this.o.id });
        for (const port of this.o.ask ?? [this.port]) for (const to of broadcasts()) s.send(msg, port, to);
        setTimeout(() => (s.close(), resolve([...found.values()])), ms);
      });
    });
  }

  /** Sends one Friday found nearby an offer to link, with this computer's pairing link. */
  async offer(to: NearbyFound, link: string): Promise<void> {
    const s = dgram.createSocket("udp4");
    const msg = JSON.stringify({ t: "offer", v: 1, id: this.o.id, to: to.id, name: this.o.name(), link });
    await new Promise<void>((resolve) => s.bind(0, () => resolve()));
    for (const port of new Set([this.port, ...(this.o.ask ?? [])])) await new Promise<void>((resolve) => s.send(msg, port, to.address, () => resolve()));
    s.close();
  }

  /** Offers waiting for this computer's person, newest first. */
  pending(): Omit<NearbyOffer, "link" | "address">[] {
    const now = Date.now();
    for (const [k, v] of this.offers) if (v.until < now) this.offers.delete(k);
    return [...this.offers.values()].reverse().map(({ from, name, check, until }) => ({ from, name, check, until }));
  }

  /** The offer's link, taken (allowed) or dropped (not). */
  take(from: string): NearbyOffer | null {
    const o = this.offers.get(from) ?? null;
    this.offers.delete(from);
    return o && o.until >= Date.now() ? o : null;
  }
}
