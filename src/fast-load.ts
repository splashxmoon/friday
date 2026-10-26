import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

/**
 * What makes the first screen arrive sooner (engineering/perf/load.md): API answers compressed like the app's own files, and a
 * page that names the code its first screen needs before the browser has read a line of it.
 */

/** Below this an answer goes as it is: compressing a few hundred bytes saves nothing a packet would notice. */
export const PACK_MIN = 1024;

/**
 * An API answer's bytes for a client that says what it can read (Accept-Encoding): Brotli, else gzip, else as it is. A long
 * session's log was half a megabyte to every new watcher, uncompressed (Testing PERFORMANCE.md finding 1a); it is a few percent
 * of that packed. Quality 4 and level 6 because this runs on every answer, in line: a megabyte of JSON packs in a few milliseconds.
 */
export function packJson(text: string, acceptEncoding: string | string[] | undefined): { body: Buffer | string; encoding: "br" | "gzip" | null; varies: boolean } {
  const accept = Array.isArray(acceptEncoding) ? acceptEncoding.join(",") : (acceptEncoding ?? "");
  // `varies`: whether another client could have been sent other bytes, which a cache in between has to be told (Vary).
  if (Buffer.byteLength(text) < PACK_MIN) return { body: text, encoding: null, varies: false };
  const raw = Buffer.from(text);
  if (accepts(accept, "br")) return { body: brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length } }), encoding: "br", varies: true };
  if (accepts(accept, "gzip")) return { body: gzipSync(raw, { level: 6 }), encoding: "gzip", varies: true };
  return { body: text, encoding: null, varies: true };
}

/** A Vary header that keeps what was already set (Origin, on the answers the website reads) and adds Accept-Encoding. */
export function withVary(existing: unknown, add: string): string {
  const have = (Array.isArray(existing) ? existing.join(",") : existing == null ? "" : String(existing)).split(",").map((v) => v.trim()).filter(Boolean);
  return have.some((v) => v.toLowerCase() === add.toLowerCase() || v === "*") ? have.join(", ") : [...have, add].join(", ");
}

/** Whether an Accept-Encoding header takes `coding`: named, and not with q=0. */
function accepts(header: string, coding: string): boolean {
  for (const part of header.split(",")) {
    const [name, ...params] = part.trim().split(";");
    if (name?.trim().toLowerCase() !== coding) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return !q || Number(q.slice(2)) > 0;
  }
  return false;
}

/**
 * Which first screen a page address opens, for the page to name that screen's code up front:
 * - `replay`, a recording or watch link (`?replay=…&t=…`), drawn by its own small script (replay.js), with no account and no app around it;
 * - `session`, a link straight into a session (`?session=…&invite=…`), whose screen's code was asked for only after the app's had run;
 * - `app`, anything else.
 * The same tests as App.tsx's readRoute, so the page and the app never disagree about which screen it is.
 */
export type ShellRoute = "replay" | "session" | "app";
export function shellRoute(q: URLSearchParams): ShellRoute {
  if (q.get("view")) return "app";
  if (q.get("session") && q.get("invite")) return "session";
  if (q.get("replay") && q.get("t")) return "replay";
  return "app";
}

/** The page for a first screen: `/app.js` swapped for its own entry, and its code named in the head so it is fetched at once. */
export function shellFor(html: string, entry: string, preloads: string[], extraHead = ""): string {
  const page = entry === "/app.js" ? html : html.replace(/<script type="module" src="\/app\.js"><\/script>/, `<script type="module" src="${entry}"></script>`);
  const links = preloads.map((p) => `  <link rel="modulepreload" href="${p}" />`).join("\n");
  return links || extraHead ? page.replace("</head>", `${links}\n${extraHead}</head>`) : page;
}
