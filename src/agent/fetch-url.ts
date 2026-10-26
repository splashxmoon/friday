import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Reading a page the team linked to.
 *
 * Search gives summaries; this gives the actual page, which is what you need
 * when someone drops a changelog, an RFC, an error message from a doc site, or
 * an API reference into the room and the agent is expected to have read it.
 *
 * The care here is all about where the request lands. This runs on Friday's
 * server, inside a network that has Redis and other services on it, and the URL
 * comes from a model that reads pages written by strangers. So every hop is
 * resolved and checked before it is followed: a public name that resolves to
 * 127.0.0.1, or a 302 into 169.254.169.254, is the whole attack and both are
 * ordinary enough to happen by accident too.
 */

const MAX_BYTES = 400_000;
const MAX_TEXT = 60_000;
const MAX_HOPS = 4;
const TIMEOUT_MS = 20_000;

/** Anything that isn't the public internet. */
function isPrivate(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::" ) return true;
    // Unique-local and link-local. A v4-mapped address is checked as v4.
    if (/^f[cd]/.test(v) || v.startsWith("fe80")) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivate(mapped[1]!);
    // The same, as URL writes it: new URL("http://[::ffff:127.0.0.1]/").hostname is "[::ffff:7f00:1]".
    // Also IPv4-compatible (::7f00:1) and NAT64 (64:ff9b::7f00:1), which carry an IPv4 address the same way.
    const hex = /^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
    if (hex) {
      const [hi, lo] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
      return isPrivate(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return false;
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||           // link-local, and cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // carrier NAT
    a >= 224                              // multicast and reserved
  );
}

async function resolvesPublicly(host: string): Promise<string | null> {
  const literal = isIP(host);
  if (literal) return isPrivate(host) ? "that address is on a private network" : null;
  const addrs = await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) return "that host doesn't resolve";
  // Every answer, not just the first: a name that resolves to one public and
  // one private address is a rebinding attempt, not a coincidence.
  return addrs.some((a) => isPrivate(a.address)) ? "that host resolves to a private network address" : null;
}

/** Tags whose contents are markup or code, not the page's words. */
const DROP = /<(script|style|noscript|svg|template|head)\b[^>]*>[\s\S]*?<\/\1>/gi;

export function toText(html: string): string {
  return html
    .replace(DROP, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/gi, (m) =>
      ({ nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" })[m.slice(1, -1).toLowerCase()] ?? m,
    )
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function fetchUrl(raw: string, signal: AbortSignal): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return `"${raw}" isn't a URL. Give a full one, starting with https://.`;
  }
  const trail: string[] = [];
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") return `Only http and https can be fetched, not ${url.protocol.replace(":", "")}.`;
    const bad = await resolvesPublicly(url.hostname.replace(/^\[|\]$/g, ""));
    if (bad) return `Can't fetch ${url.hostname}: ${bad}.`;

    const timer = AbortSignal.timeout(TIMEOUT_MS);
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.any([signal, timer]),
      headers: { "user-agent": "FridayBot/1.0 (+https://friday.app)", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
    }).catch((e: Error) => e);
    if (res instanceof Error) return `Couldn't reach ${url.hostname}: ${res.message}`;

    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      // Each hop is re-checked from the top, which is the point of doing this
      // by hand rather than letting fetch follow them.
      trail.push(url.href);
      url = new URL(location, url);
      continue;
    }
    if (!res.ok) return `${url.href} returned ${res.status} ${res.statusText}.`;

    const type = res.headers.get("content-type") ?? "";
    if (!/text\/|json|xml|javascript/i.test(type)) return `${url.href} is ${type.split(";")[0] || "not text"}, so there's nothing to read.`;

    const buf = await res.arrayBuffer().catch(() => null);
    if (!buf) return `${url.href} stopped sending partway through.`;
    const body = Buffer.from(buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf).toString("utf8");
    const text = /html/i.test(type) ? toText(body) : body.trim();
    const clipped = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n[page cut at ${MAX_TEXT} characters]` : text;
    const via = trail.length ? `\n(redirected from ${trail[0]})` : "";
    return `${url.href}${via}\n\n${clipped || "(the page has no readable text)"}`;
  }
  return `${raw} redirects more than ${MAX_HOPS} times; something is wrong with it.`;
}

/** Why a URL may not be fetched from the server (not http(s), or not on the public internet), or null when it may. */
export async function publicUrlProblem(raw: string | URL): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "that isn't a URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return `only http and https, not ${url.protocol.replace(":", "")}`;
  return resolvesPublicly(url.hostname.replace(/^\[|\]$/g, ""));
}

/**
 * fetch, for addresses a person or a remote server chose: each hop is checked as fetchUrl checks it, so a URL, a redirect,
 * or an OAuth server named in another server's metadata cannot point Friday's server at its own private network (Security
 * AUDIT APP-2). What it doesn't stop: a name that resolves differently between the check and the connection.
 */
/**
 * The request to send after a redirect, as fetch itself would: a 303, or a 301/302 after a POST, becomes a GET with no body,
 * and credentials don't follow to another origin.
 */
export function redirected(status: number, opts: RequestInit, from: URL, to: URL): RequestInit {
  let out = opts;
  if (status === 303 || ((status === 301 || status === 302) && (opts.method ?? "GET").toUpperCase() === "POST")) out = { ...out, method: "GET", body: undefined };
  if (to.origin !== from.origin) {
    const headers = new Headers(out.headers);
    for (const h of ["authorization", "cookie", "proxy-authorization"]) headers.delete(h);
    out = { ...out, headers };
  }
  return out;
}

export const publicFetch: typeof fetch = async (input, init) => {
  // One URL and one init, whatever was passed: a Request's method, headers and body would otherwise be lost after the first hop.
  let url = new URL(input instanceof Request ? input.url : String(input));
  let opts: RequestInit = input instanceof Request ? { method: input.method, headers: input.headers, body: input.body ? await input.arrayBuffer() : undefined, signal: input.signal, ...init } : { ...init };
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const bad = await publicUrlProblem(url);
    if (bad) throw new Error(`Can't reach ${url.hostname}: ${bad}.`);
    const res = await fetch(url, { ...opts, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location || init?.redirect === "manual") return res;
    await res.body?.cancel().catch(() => {});
    const next = new URL(location, url);
    opts = redirected(res.status, opts, url, next);
    url = next;
  }
  throw new Error(`${url.hostname} redirects more than ${MAX_HOPS} times.`);
};
