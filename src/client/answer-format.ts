/**
 * How an agent's answer reads in the chat: the shapes agents already write (a file path in backticks, a numbered plan, a
 * "Note:" line, a table of numbers) recognised from the Markdown so they can be drawn as what they are.
 *
 * Plain functions over text, and one pass over each block's tree after it is parsed and sanitised. Nothing here runs per
 * token beyond that: the renderer only re-parses the block that changed.
 */

/** A file the answer names: `src/x.ts`, `ml/tune_model.py:42`, `README.md`. Null for anything that only looks a bit like one. */
export function pathOf(raw: string): { path: string; line?: number } | null {
  let s = raw.trim();
  if (s.length < 3 || s.length > 200 || /[\s`'"()<>{}[\]*?$|;,=&!^%@\\]/.test(s) || s.includes("://")) return null;
  let line: number | undefined;
  const at = s.match(/(?::(\d+)(?::\d+)?(?:-\d+)?|#L(\d+)(?:-L?\d+)?)$/);
  if (at) {
    line = Number(at[1] ?? at[2]);
    s = s.slice(0, at.index);
  }
  if (s.startsWith("./")) s = s.slice(2);
  if (s.includes(":")) return null;
  // Absolute paths and home paths are somewhere on someone's computer, not a place in this repository.
  if (!s || s.startsWith("/") || s.startsWith("~") || s.startsWith("-") || /^[A-Za-z]:/.test(s) || s.endsWith("/") || s.includes("//")) return null;
  const parts = s.split("/");
  if (parts.some((p) => !p || p === "..")) return null;
  const name = parts.at(-1)!;
  // A web address written without its scheme (github.com/x/y.md).
  if (parts.length > 1 && /^[\w-]+\.(com|org|net|io|dev|ai|app|co|so|sh)$/i.test(parts[0]!)) return null;
  const ext = name.match(/^(.*[^.])?\.([A-Za-z0-9]{1,10})$/);
  // "console.log" or "ev.ts" is code, not a file: a bare name needs an extension files have and code members rarely do, and
  // a name longer than a variable's usual two or three letters.
  const bare = (stem: string, e: string) => BARE_EXTENSIONS.has(e.toLowerCase()) && /^(.{4,}|.*[-_A-Z0-9].*)$/.test(stem);
  const known = KNOWN_NAMES.test(name) || (ext && /[A-Za-z]/.test(ext[2]!) && (parts.length > 1 || bare(ext[1] ?? "", ext[2]!)));
  if (!known) return null;
  return line ? { path: s, line } : { path: s };
}

const KNOWN_NAMES = /^(Dockerfile|Makefile|Procfile|Gemfile|Rakefile|LICENSE|\.env(\.[\w-]+)?|\.gitignore|\.npmrc|\.nvmrc|\.editorconfig|\.prettierrc|\.eslintrc)$/;
/** The extensions a bare file name (no folder) is believed to be a file with. Each is one a property or method is rarely called. */
const BARE_EXTENSIONS = new Set(
  ("ts tsx mts cts js jsx mjs cjs py pyi rb go rs java kt kts swift c h cc cpp hpp cs php css scss less html htm vue svelte " +
    "md mdx json jsonc yml yaml toml ini cfg conf sql sh bash zsh ps1 lock ipynb csv tsv xml svg png jpg jpeg gif webp pdf txt gradle tf proto graphql gql prisma").split(" "),
);

export type CalloutKind = "note" | "tip" | "important" | "warning" | "danger" | "success";

const LABELS: [RegExp, CalloutKind][] = [
  [/^(note|notes|info|fyi)\s*:/i, "note"],
  [/^tl;?dr\s*[:—–-]/i, "note"],
  [/^tip\s*:/i, "tip"],
  [/^important\s*:/i, "important"],
  [/^(warning|caution|heads up|risk|risks)\s*:/i, "warning"],
  [/^danger\s*:/i, "danger"],
  [/^success means\b/i, "success"],
];
const ALERTS: Record<string, CalloutKind> = { note: "note", tip: "tip", important: "important", warning: "warning", caution: "danger" };
const ALERT = /^\[!(note|tip|important|warning|caution)\][ \t]*\n?/i;

/** What a paragraph that starts with a label is: "Warning: the cache is shared" is a warning. */
export function calloutOf(text: string): CalloutKind | null {
  const t = text.trimStart();
  for (const [re, kind] of LABELS) if (re.test(t)) return kind;
  return null;
}

/** A GitHub alert's kind (`> [!NOTE]`), and the label it is written out with. */
export function alertOf(text: string): { kind: CalloutKind; label: string; marker: string } | null {
  const m = text.trimStart().match(ALERT);
  if (!m) return null;
  const word = m[1]!.toLowerCase();
  return { kind: ALERTS[word]!, label: word[0]!.toUpperCase() + word.slice(1), marker: m[0] };
}

/**
 * A plan step's title: "Read the config — then the loader" is titled "Read the config"; "Tests: run them twice" is titled
 * "Tests:". Only a short phrase counts, so an ordinary sentence with a colon in it stays a sentence.
 */
export function stepTitle(text: string): { title: string; rest: string } | null {
  const dash = text.search(/\s[—–]\s/);
  const colon = text.search(/:\s/);
  const cut = [dash, colon].filter((i) => i > 0).sort((a, b) => a - b)[0];
  if (cut === undefined || cut > 60) return null;
  const isColon = cut === colon;
  const title = text.slice(0, isColon ? cut + 1 : cut);
  const rest = text.slice(isColon ? cut + 1 : cut);
  if (!rest.trim() || title.trim().split(/\s+/).length > 8 || /https?:|\d:\d/.test(title)) return null;
  return { title, rest };
}

const NUM = String.raw`[~≈<>≤≥]?\s?[+\-−±]?\s?[$€£¥]?\d[\d,]*(?:\.\d+)?\s?(?:%|pp|pts?|x|×|ms|s|min|h|d|k|K|M|B|[KMGT]i?B|kB|bytes?|tokens?|req\/s|rps|fps)?`;
const NUMERIC = new RegExp(String.raw`^${NUM}(?:\s?\(${NUM}\)|\s?(?:→|->)\s?${NUM})?$`);
const BLANK = /^(|-|—|–|n\/a|na|none)$/i;

/** A table cell that is a figure: "1,204", "-3.5%", "184 ms", "0.81 → 0.86", "0.93 (+0.02)". */
export const isNumeric = (text: string) => NUMERIC.test(text.trim());

const STATUS: Record<string, "good" | "bad" | "warn"> = {};
for (const w of "pass passed passing ok success succeeded done healthy".split(" ")) STATUS[w] = "good";
for (const w of "fail failed failing error errored broken".split(" ")) STATUS[w] = "bad";
for (const w of "skip skipped pending flaky partial warn warning slow".split(" ")) STATUS[w] = "warn";
/** A table cell that is only a status word ("passed", "failed"): the whole cell, so a sentence that mentions one is left alone. */
export const statusOf = (text: string) => STATUS[text.trim().replace(/^[✅❌⚠️✓✗×]\s*/u, "").toLowerCase()] ?? null;

// The tree, as far as this pass needs it.
type Node = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: Node[] };

const textOf = (n: Node): string => (n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(textOf).join(""));
const is = (n: Node | undefined, tag: string): boolean => n?.type === "element" && n.tagName === tag;
const elements = (n: Node) => (n.children ?? []).filter((c) => c.type === "element");
const addClass = (n: Node, c: string) => {
  n.properties ??= {};
  const cur = n.properties.className;
  n.properties.className = [...(Array.isArray(cur) ? cur : typeof cur === "string" ? cur.split(" ") : []), c];
};
const bold = (value: string): Node => ({ type: "element", tagName: "strong", properties: {}, children: [{ type: "text", value }] });
/** The first piece of text a block starts with, looking through a loose list item's paragraph. */
const firstText = (n: Node): { parent: Node; i: number } | null => {
  const kids = n.children ?? [];
  const i = kids.findIndex((c) => !(c.type === "text" && !c.value?.trim()));
  if (i < 0) return null;
  const c = kids[i]!;
  if (c.type === "text") return { parent: n, i };
  return is(c, "p") ? firstText(c) : null;
};

/** Makes a block a callout: a tinted box with its icon, and the label it starts with in bold. */
function markCallout(block: Node, kind: CalloutKind) {
  addClass(block, "callout");
  block.properties!.dataCallout = kind;
  const at = firstText(block);
  if (!at) return;
  const node = at.parent.children![at.i]!;
  const m = node.value!.match(/^\s*(success means|tl;?dr\s*[:—–-]|[a-z ]{2,20}?\s*:)\s*/i);
  if (m && calloutOf(m[1]!)) at.parent.children!.splice(at.i, 1, bold(m[1]!), { type: "text", value: " " + node.value!.slice(m[0].length) });
}

function table(t: Node) {
  const rows = (sec: string) => elements(t).filter((s) => is(s, sec)).flatMap((s) => elements(s).filter((r) => is(r, "tr")));
  const body = rows("tbody");
  const cells = (r: Node) => elements(r).filter((c) => is(c, "td") || is(c, "th"));
  const width = Math.max(0, ...body.map((r) => cells(r).length));
  for (let col = 0; col < width; col++) {
    const texts = body.map((r) => textOf(cells(r)[col] ?? { type: "text" }).trim()).filter((s) => !BLANK.test(s));
    if (!texts.length || !texts.every(isNumeric)) continue;
    for (const r of [...rows("thead"), ...body]) {
      const c = cells(r)[col];
      if (c) addClass(c, "num");
    }
  }
  for (const r of body)
    for (const c of cells(r)) {
      const s = statusOf(textOf(c));
      if (s) (c.properties ??= {}).dataStatus = s;
    }
}

/**
 * The pass over each block of an answer, after it is sanitised: tables learn which columns are figures, a plan's steps
 * get their titles, and notes and warnings become callouts. Classes and data attributes only; the elements stay the
 * table, list and paragraph they were.
 */
export function rehypeAnswer() {
  return (tree: Node) => {
    const walk = (n: Node, top: boolean) => {
      for (const c of n.children ?? []) {
        if (c.type !== "element") continue;
        if (is(c, "table")) table(c);
        else if (is(c, "ol") && top) {
          addClass(c, "steps");
          for (const li of elements(c).filter((x) => is(x, "li"))) {
            const at = firstText(li);
            if (!at) continue;
            const node = at.parent.children![at.i]!;
            const t = stepTitle(node.value!);
            if (t) at.parent.children!.splice(at.i, 1, bold(t.title), { type: "text", value: t.rest });
          }
        } else if (is(c, "blockquote")) {
          const at = firstText(c);
          const alert = at && alertOf(at.parent.children![at.i]!.value!);
          if (alert && at) {
            const node = at.parent.children![at.i]!;
            const rest = node.value!.trimStart().slice(alert.marker.length);
            at.parent.children!.splice(at.i, 1, bold(alert.label + ":"), { type: "text", value: " " + rest });
            addClass(c, "callout");
            c.properties!.dataCallout = alert.kind;
          } else {
            const kind = calloutOf(textOf(c));
            if (kind) markCallout(c, kind);
          }
        } else if (is(c, "p") && top) {
          const kind = calloutOf(textOf(c));
          if (kind) markCallout(c, kind);
        }
        if (!is(c, "pre")) walk(c, false);
      }
    };
    walk(tree, true);
  };
}

/**
 * Links to files, before the sanitiser and the link hardener see them. An agent writes `[working plan](working-plan.md)` or
 * `[audit](file:///…/audit.pdf)`; the hardener refused both (a relative path has no base it trusts, file: is never allowed) and
 * drew "working plan [blocked]" in a Crew room (Arun, 2026-10-29). A link to a file in the folders is the app's own file chip
 * instead: its address is kept in a fragment both of them let through, and rehypeFileChips (after them) makes it the chip. A
 * link that must stay refused (javascript:, data:, vbscript:) is its words alone, with no "[blocked]".
 */
export const FILE_LINK = "#friday-file:";
const REFUSED = /^\s*(javascript|data|vbscript):/i;
const SCHEME = /^[a-z][\w+.-]*:/i;

/** The file a link points at, or null for a web address, a fragment, mail and the like. */
export function fileLinkOf(href: string): string | null {
  let h = href.trim();
  if (!h || h.startsWith("#") || h.startsWith("//") || h.startsWith("?")) return null;
  if (/^file:/i.test(h)) h = h.replace(/^file:\/\/(localhost)?/i, "").replace(/^file:/i, "");
  else if (SCHEME.test(h) && !/^[A-Za-z]:[\\/]/.test(h)) return null;
  h = h.replace(/[?#].*$/, "");
  try {
    h = decodeURIComponent(h);
  } catch {
    // Kept as written.
  }
  if (h.startsWith("./")) h = h.slice(2);
  // A folder, or nothing left, is no file to open.
  if (!h || h.endsWith("/") || h === "." || h === "..") return null;
  return h;
}

/** Before the sanitiser: links to files carried in a fragment, refused ones made plain words. */
export function rehypeFileLinks() {
  return (tree: Node) => {
    const walk = (n: Node) => {
      const kids = n.children ?? [];
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i]!;
        if (c.type !== "element") continue;
        if (c.tagName === "a") {
          const href = typeof c.properties?.href === "string" ? c.properties.href : "";
          if (REFUSED.test(href)) {
            kids.splice(i, 1, ...(c.children ?? []));
            i--;
            continue;
          }
          const file = fileLinkOf(href);
          if (file) c.properties = { ...c.properties, href: FILE_LINK + encodeURIComponent(file) };
        }
        walk(c);
      }
    };
    walk(tree);
  };
}

/** After the hardener: a link to a file is inline code naming it, with the link's words, which the answer draws as a file chip. */
export function rehypeFileChips() {
  return (tree: Node) => {
    const walk = (n: Node) => {
      for (const c of n.children ?? []) {
        if (c.type !== "element") continue;
        const href = c.tagName === "a" && typeof c.properties?.href === "string" ? c.properties.href : "";
        if (href.startsWith(FILE_LINK)) {
          let path = href.slice(FILE_LINK.length);
          try {
            path = decodeURIComponent(path);
          } catch {
            // As it is.
          }
          c.tagName = "code";
          c.properties = { dataFileLink: textOf(c).trim() || path };
          c.children = [{ type: "text", value: path }];
          continue;
        }
        walk(c);
      }
    };
    walk(tree);
  };
}
