// Preview checks (Arun, 2026-11-19, wave 3: "after a change, Friday opens the app's preview, clicks through what changed and
// shows you screenshots before you look."): which of a run's changed files are the page's own, and which pages they draw.
// Pure, so the runner (which can read the project) and the tests both use it; the page only needs hasUiChange.

/** Files that draw something: a component, a style, a page. A server file or a test changes no picture. */
const UI_FILE = /\.(?:tsx|jsx|vue|svelte|astro|css|scss|sass|less|html?|mdx)$/i;
const TEST_FILE = /(?:^|\/)(?:__tests__|__mocks__|e2e|tests?)\/|\.(?:test|spec|stories)\.[a-z]+$/i;

export const isUiFile = (path: string): boolean => UI_FILE.test(path) && !TEST_FILE.test(path.replace(/\\/g, "/"));

/** Whether a run's files are worth a look in the preview: any that draw something, and not only by being removed. */
export const hasUiChange = (files: ReadonlyArray<{ path: string; status?: string }>): boolean => files.some((f) => f.status !== "deleted" && isUiFile(f.path));

/** What the project is, as far as guessing routes needs: its dependencies, and whether a path exists in it. */
export interface Layout {
  deps: ReadonlySet<string>;
  has: (path: string) => boolean;
}

/** Most pages looked at in one check: each is two pictures and a load, and a long list is not "before you look". */
export const MAX_PAGES = 4;

const clean = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
const strip = (p: string) => p.replace(/\.[a-z0-9]+$/i, "");
/** A path of folders and names, as a URL's: groups "(x)" vanish, and anything dynamic ("[id]", "@slot", "_x") has no address to open. */
function urlOf(parts: string[]): string | null {
  const out: string[] = [];
  for (const p of parts) {
    if (/^\(.*\)$/.test(p)) continue;
    if (/[[\]@]/.test(p) || p.startsWith("_")) return null;
    out.push(p);
  }
  return "/" + out.join("/");
}

const HOME_NAMES = /^(?:index|home|app|main|landing)$/i;
const NEXT_APP_FILE = /^(?:page|layout|template|loading|error|not-found|default)$/;
/** Dependencies that turn files into routes: without one of them, a pages/ or routes/ folder is only a folder. */
const FILE_ROUTERS = new Set(["next", "nuxt", "nuxt3", "astro", "@sveltejs/kit", "vite-plugin-pages", "@remix-run/dev", "@remix-run/react", "@react-router/dev", "@tanstack/react-router", "@tanstack/router-plugin", "vike", "vite-plugin-ssr", "gatsby", "@solidjs/start", "@builder.io/qwik-city", "@analogjs/platform", "unplugin-vue-router"]);
const PAGE_FILE = /\.(?:tsx|jsx|vue|svelte|astro|mdx|js|ts)$/;
const NOT_PAGES = /^(?:components?|partials?|layouts?|lib|utils?|hooks?|styles?|assets)$/i;
const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[_\s]+/g, "-").toLowerCase();

/** The page one changed file belongs to, or null when it is a component or a style that no page of its own owns. */
export function routeOf(file: string, layout: Layout): string | null {
  const p = clean(file);
  const parts = p.split("/");
  const name = strip(parts[parts.length - 1] ?? "");
  const dirs = parts.slice(0, -1);
  const next = layout.deps.has("next");

  // Next's app router: app/ or src/app/, a page or what wraps it (a layout draws every page below it).
  if (next || layout.has("app/layout.tsx") || layout.has("src/app/layout.tsx")) {
    const root = dirs[0] === "app" ? 1 : dirs[0] === "src" && dirs[1] === "app" ? 2 : 0;
    if (root && NEXT_APP_FILE.test(name) && /\.(?:tsx|jsx|js|ts)$/.test(p)) {
      if (name === "not-found" || name === "error" || name === "default") return null;
      return urlOf(dirs.slice(root));
    }
  }
  // Pages that are files: pages/ (Next, Nuxt) and src/pages (Astro, Vue and React routers that follow it); SvelteKit's +page.
  const pagesAt = dirs[0] === "pages" ? 1 : dirs[0] === "src" && dirs[1] === "pages" ? 2 : dirs[0] === "src" && dirs[1] === "routes" ? 2 : dirs[0] === "routes" ? 1 : dirs[0] === "src" && dirs[1] === "views" ? 2 : 0;
  if (pagesAt) {
    // Only where a file router is installed does a file here have an address; a Vite app's src/pages is just components, drawn by
    // whatever routes the app lists, so its files are "any page" (the home page) and never a guess at a path.
    if (![...FILE_ROUTERS].some((d) => layout.deps.has(d))) return null;
    if (!PAGE_FILE.test(p)) return null;
    const rest = dirs.slice(pagesAt);
    if (rest[0] === "api" || name.startsWith("_") || /^\+(?:server|error)/.test(name)) return null;
    // A folder of pieces is no page; nor is a file whose name is more than a name (a module's ".module", a route's "$id" or "index.lazy").
    if (rest.some((d) => NOT_PAGES.test(d))) return null;
    // SvelteKit: a +page is the folder's address, and a +layout draws every page below it.
    if (name === "+page" || name === "+layout") return urlOf(rest);
    if (/[.$:+]/.test(name)) return null;
    // A page named like a home page is "/"; others are their name, lower-cased and dashed (About.tsx -> /about).
    if (HOME_NAMES.test(name) && !rest.length) return "/";
    const own = name.toLowerCase() === "index" ? [] : [kebab(name)];
    return urlOf([...rest, ...own]);
  }
  // Plain sites: an html file at the project's root or in public/ is its own address; any other (a template, a coverage report) is not.
  if (/\.html?$/i.test(p) && (dirs.length === 0 || dirs[0] === "public")) {
    const rest = dirs.slice(1);
    if (name === "index") return "/" + rest.join("/") + (rest.length ? "/" : "");
    return "/" + [...rest, `${name}.html`].join("/");
  }
  return null;
}

/**
 * The pages to look at after a run: the ones the changed files are, and "/" when any file draws on every page or none (a
 * component, a stylesheet, a layout at the root), or when nothing else was found. Conservative: never more than MAX_PAGES, and a
 * guess that isn't a page of this project's is left out rather than opened.
 */
export function pagesFor(files: readonly string[], layout: Layout): string[] {
  const pages: string[] = [];
  let general = false;
  for (const f of files) {
    if (!isUiFile(f)) continue;
    const r = routeOf(f, layout);
    if (r === null) general = true;
    else if (!pages.includes(r)) pages.push(r);
  }
  if (!pages.length || general) {
    // "/" goes after the specific pages, but is never the one dropped.
    if (!pages.includes("/")) pages.push("/");
  }
  if (pages.length <= MAX_PAGES) return pages;
  const keep = pages.filter((p) => p !== "/").slice(0, MAX_PAGES - (pages.includes("/") ? 1 : 0));
  return pages.includes("/") ? [...keep, "/"] : keep;
}

/** The two widths every page is looked at: a laptop's and a phone's. */
export const VIEWS = [
  { label: "Desktop", width: 1280, height: 800 },
  { label: "Phone", width: 390, height: 844 },
] as const;

/** What a console line is worth showing: first line, shortened, without the address of the page it came from. */
export function oneError(line: string): string {
  const first = line.replace(/\x1b\[[0-9;]*m/g, "").split("\n").find((l) => l.trim()) ?? "";
  return first.trim().replace(/\s+/g, " ").slice(0, 240);
}

/** Console errors from several widths of one page: each once, in the order seen, a few. */
export function mergeErrors(lists: ReadonlyArray<readonly string[]>, max = 6): string[] {
  const seen = new Set<string>();
  for (const l of lists) for (const e of l) if (e && seen.size < max) seen.add(oneError(e));
  return [...seen].filter(Boolean);
}
