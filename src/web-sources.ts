/**
 * The pages a web search turned up, with their titles where the search gave them, for the reply's Sources (citations).
 * Friday's own search ends with "Sources:" and "- Title https://…" lines; Claude Code's lists {"title","url"} pairs; others
 * write Markdown links or bare addresses. Each page once, in the order it first appears.
 *
 * Search output is anyone's text, so this never throws (a title with a Windows path or a regex in it was a bad JSON
 * escape) and keeps only http and https addresses: a javascript: or data: link never reaches an href.
 */
export type WebSource = { url: string; title?: string };

const URL_RE = /https?:\/\/[^\s)\]>"'`]+/g;
const tidy = (u: string) => u.replace(/[.,;:!?]+$/, "");

/** Only the web: an address that parses and is http or https. */
export function webUrl(u: string): string | null {
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:" ? p.href : null;
  } catch {
    return null;
  }
}

/** A JSON string's contents, unescaped when it is valid JSON and as written when it isn't. */
const unescape = (raw: string) => {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
};

export function webSourcesIn(output: string): WebSource[] {
  const found = new Map<string, string | undefined>();
  const add = (url: string, title?: string) => {
    const u = webUrl(tidy(url));
    if (!u) return;
    const t = title?.replace(/\s+/g, " ").trim();
    if (!found.has(u) || (!found.get(u) && t)) found.set(u, t || found.get(u));
  };
  try {
    // {"title":"…","url":"…"} in either order.
    for (const m of output.matchAll(/\{[^{}]*?"title"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*?"url"\s*:\s*"([^"]+)"[^{}]*?\}/g)) add(m[2]!, unescape(m[1]!));
    for (const m of output.matchAll(/\{[^{}]*?"url"\s*:\s*"([^"]+)"[^{}]*?"title"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*?\}/g)) add(m[1]!, unescape(m[2]!));
    // [Title](https://…)
    for (const m of output.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g)) add(m[2]!, m[1]);
    // - Title https://…
    for (const m of output.matchAll(/^\s*[-*]\s+(.+?)\s+(https?:\/\/\S+)\s*$/gm)) add(m[2]!, m[1]);
    // Anything else that is an address.
    for (const m of output.matchAll(URL_RE)) add(m[0]);
  } catch {
    // Whatever was found before the surprise still counts; a reply never fails to draw over its sources.
  }
  return [...found].map(([url, title]) => (title ? { url, title } : { url }));
}
