/**
 * Your own colours and type (Arun, 2026-10-25, tier 2: "Themes: VS Code theme import, interface scale, custom fonts").
 *
 * A VS Code theme file (the JSON an extension ships, or one exported with "Generate Color Theme From Current Settings") is
 * read into Friday's own colour tokens: its editor background becomes the page's, its sidebar the sidebar's, its foreground the
 * ink, its accent the accent, and its token colours colour the editor and the diffs. Fonts are two names, for the interface and
 * for code; a Google Fonts name is fetched, anything else is taken as installed. Both are kept on this computer (localStorage),
 * like the light/dark choice, and applied before the app draws (main.tsx). Interface size was already here (prefs.ts).
 */

export type TokenKind = "keyword" | "string" | "comment" | "number" | "fn" | "variable" | "type" | "tag" | "attr" | "punct" | "meta" | "invalid";

export interface CustomTheme {
  /** Set on one of yours (saved in Settings › Appearance) or one of the built-in themes, so the gallery can mark it chosen. */
  id?: string;
  name: string;
  dark: boolean;
  /** The few colours it was made from, when it was made in Friday: what the theme maker opens with to change it. */
  palette?: Palette;
  /** Friday's tokens ("--bg", "--ink", …) to the theme's colours. */
  vars: Record<string, string>;
  /** The editor's syntax colours, where the theme gave them. */
  tokens: Partial<Record<TokenKind, string>>;
}

export interface Fonts {
  ui?: string;
  code?: string;
}

const THEME_KEY = "mpa.theme.custom";
const FONTS_KEY = "mpa.fonts";

const HEX = /^#([0-9a-f]{3,8})$/i;

/** A colour's hex, or null when it isn't one (VS Code themes may carry rgba(); those are left out). */
function hex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!HEX.test(s)) return null;
  // #rgb → #rrggbb; a trailing alpha byte is dropped: the tokens are solid.
  const body = s.slice(1);
  if (body.length === 3 || body.length === 4) return `#${[...body.slice(0, 3)].map((c) => c + c).join("")}`;
  return `#${body.slice(0, 6)}`;
}

/** Whether a background is dark, by its relative luminance. */
export function isDark(color: string): boolean {
  const h = hex(color);
  if (!h) return false;
  const n = parseInt(h.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.35;
}

const mix = (a: string, pct: number, b: string) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;

/** The scopes VS Code themes colour, to the editor's kinds; the first match for a kind wins. */
const SCOPES: [TokenKind, RegExp][] = [
  ["comment", /^comment\b|^punctuation\.definition\.comment/],
  ["string", /^string\b/],
  ["keyword", /^keyword\b|^storage\.type\b|^storage\.modifier\b/],
  ["number", /^constant\.numeric|^constant\.language|^constant\.character/],
  ["fn", /^entity\.name\.function|^support\.function|^meta\.function-call/],
  ["type", /^entity\.name\.type|^entity\.name\.class|^support\.type|^support\.class|^storage\.type\.class/],
  ["tag", /^entity\.name\.tag|^punctuation\.definition\.tag/],
  ["attr", /^entity\.other\.attribute-name/],
  ["variable", /^variable\b|^entity\.name\.variable/],
  ["punct", /^punctuation\b|^meta\.brace/],
  ["meta", /^meta\.(decorator|annotation|preprocessor)|^entity\.name\.function\.decorator|^punctuation\.decorator/],
  ["invalid", /^invalid\b/],
];

/** The editor's colours from a theme's tokenColors: each kind takes the first rule whose scope names it. */
export function tokenColours(tokenColors: unknown): Partial<Record<TokenKind, string>> {
  const out: Partial<Record<TokenKind, string>> = {};
  if (!Array.isArray(tokenColors)) return out;
  for (const rule of tokenColors as { scope?: string | string[]; settings?: { foreground?: string } }[]) {
    const fg = hex(rule?.settings?.foreground);
    if (!fg) continue;
    const scopes = Array.isArray(rule.scope) ? rule.scope : typeof rule.scope === "string" ? rule.scope.split(",") : [];
    for (const raw of scopes) {
      const scope = raw.trim();
      for (const [kind, re] of SCOPES) if (!out[kind] && re.test(scope)) out[kind] = fg;
    }
  }
  return out;
}

/**
 * A VS Code theme as Friday's tokens. Null when the file isn't one (no `colors`). What the theme doesn't say is derived from what
 * it does: panels a step from the background, borders and hovers as mixes, muted ink between ink and background.
 */
export function vscodeTheme(json: unknown): CustomTheme | null {
  const t = json as { name?: unknown; type?: unknown; colors?: Record<string, unknown>; tokenColors?: unknown } | null;
  if (!t || typeof t !== "object" || !t.colors || typeof t.colors !== "object") return null;
  const c = (k: string) => hex(t.colors![k]);
  const bg = c("editor.background") ?? c("sideBar.background");
  const fg = c("editor.foreground") ?? c("foreground");
  if (!bg || !fg) return null;
  const dark = t.type === "dark" || t.type === "hc" || (t.type !== "light" && t.type !== "hcLight" && isDark(bg));
  const sidebar = c("sideBar.background") ?? c("activityBar.background") ?? mix(bg, dark ? 70 : 96, dark ? "#000000" : "#000000");
  const panel = c("editorWidget.background") ?? c("panel.background") ?? mix(bg, 90, dark ? "#ffffff" : "#000000");
  const card = c("input.background") ?? c("dropdown.background") ?? mix(bg, 85, dark ? "#ffffff" : "#000000");
  const border = c("editorGroup.border") ?? c("panel.border") ?? c("sideBar.border") ?? c("widget.border") ?? mix(fg, 14, bg);
  const accent = c("button.background") ?? c("focusBorder") ?? c("textLink.foreground") ?? c("activityBarBadge.background") ?? fg;
  const onAccent = c("button.foreground") ?? (isDark(accent) ? "#ffffff" : "#111111");
  const hover = c("list.hoverBackground") ?? mix(fg, 7, bg);
  const muted = c("descriptionForeground") ?? mix(fg, 65, bg);
  const faint = c("disabledForeground") ?? mix(fg, 45, bg);
  const green = c("gitDecoration.addedResourceForeground") ?? c("terminal.ansiGreen") ?? c("testing.iconPassed") ?? (dark ? "#3fb67b" : "#1a7f37");
  const red = c("errorForeground") ?? c("gitDecoration.deletedResourceForeground") ?? c("terminal.ansiRed") ?? (dark ? "#ff7b72" : "#cf222e");
  const amber = c("editorWarning.foreground") ?? c("gitDecoration.modifiedResourceForeground") ?? c("terminal.ansiYellow") ?? (dark ? "#f2b453" : "#9a6700");
  const vars: Record<string, string> = {
    "--bg": bg,
    "--sidebar": sidebar,
    "--panel": panel,
    "--card": card,
    "--card-2": mix(card, 85, dark ? "#ffffff" : "#000000"),
    "--hover": hover,
    "--hover-strong": mix(fg, 12, bg),
    "--border": border,
    "--border-strong": mix(fg, 24, bg),
    "--border-hover": mix(fg, 30, bg),
    "--code-bg": c("editor.background") ?? bg,
    "--ink": fg,
    "--ink-2": mix(fg, 82, bg),
    "--text-muted": muted,
    "--muted-foreground": muted,
    "--faint": faint,
    "--accent": accent,
    "--on-accent": onAccent,
    "--accent-hover": mix(accent, 88, dark ? "#ffffff" : "#000000"),
    "--accent-soft": mix(accent, 16, bg),
    "--violet": accent,
    "--violet-soft": mix(accent, 16, bg),
    "--violet-hover": mix(accent, 88, dark ? "#ffffff" : "#000000"),
    "--violet-border": mix(accent, 45, bg),
    "--border-focus": c("focusBorder") ?? accent,
    "--green": green,
    "--red": red,
    "--red-soft": mix(red, 16, bg),
    "--amber": amber,
    "--amber-soft": mix(amber, 16, bg),
  };
  const name = typeof t.name === "string" && t.name.trim() ? t.name.trim().slice(0, 60) : "Imported theme";
  return { name, dark, vars, tokens: tokenColours(t.tokenColors) };
}

// ── made in Friday ────────────────────────────────────────────────────

/**
 * A theme as the few colours a person picks: the background, the sidebar, the text and the accent, and optionally the status
 * colours and the editor's. Everything else is worked out from those, the way an imported VS Code theme's gaps are.
 */
export interface Palette {
  name: string;
  dark: boolean;
  bg: string;
  sidebar?: string;
  ink: string;
  accent: string;
  green?: string;
  red?: string;
  amber?: string;
  tokens?: Partial<Record<TokenKind, string>>;
}

/** A palette as a whole theme, through the same reading an imported VS Code theme gets. */
export function themeFromPalette(p: Palette, id?: string): CustomTheme {
  const colors: Record<string, string> = { "editor.background": p.bg, "editor.foreground": p.ink, "button.background": p.accent, focusBorder: p.accent };
  if (p.sidebar) colors["sideBar.background"] = p.sidebar;
  if (p.green) colors["terminal.ansiGreen"] = p.green;
  if (p.red) colors.errorForeground = p.red;
  if (p.amber) colors["editorWarning.foreground"] = p.amber;
  const t = vscodeTheme({ name: p.name, type: p.dark ? "dark" : "light", colors })!;
  return { ...t, ...(id ? { id } : {}), palette: p, tokens: p.tokens ?? {} };
}

/** Friday's own two looks as palettes: where the theme maker starts when you haven't picked a theme to change. */
export const FRIDAY_PALETTES: Record<"dark" | "light", Palette> = {
  dark: { name: "My theme", dark: true, bg: "#161618", sidebar: "#0c0c0e", ink: "#ededf0", accent: "#f1f1f3", green: "#3fb67b", red: "#ff7b72", amber: "#f2b453" },
  light: { name: "My theme", dark: false, bg: "#ffffff", sidebar: "#f4f4f5", ink: "#18181b", accent: "#17171a", green: "#126c34", red: "#b0331f", amber: "#b45309" },
};

/** The themes people ask for by name, in their published colours, editor colours included. */
export const PRESETS: CustomTheme[] = (
  [
    ["dracula", { name: "Dracula", dark: true, bg: "#282a36", sidebar: "#21222c", ink: "#f8f8f2", accent: "#bd93f9", green: "#50fa7b", red: "#ff5555", amber: "#f1fa8c", tokens: { keyword: "#ff79c6", string: "#f1fa8c", comment: "#6272a4", number: "#bd93f9", fn: "#50fa7b", type: "#8be9fd", tag: "#ff79c6", attr: "#50fa7b" } }],
    ["tokyo-night", { name: "Tokyo Night", dark: true, bg: "#1a1b26", sidebar: "#16161e", ink: "#c0caf5", accent: "#7aa2f7", green: "#9ece6a", red: "#f7768e", amber: "#e0af68", tokens: { keyword: "#bb9af7", string: "#9ece6a", comment: "#565f89", number: "#ff9e64", fn: "#7aa2f7", type: "#2ac3de", tag: "#f7768e", attr: "#bb9af7" } }],
    ["catppuccin-mocha", { name: "Catppuccin Mocha", dark: true, bg: "#1e1e2e", sidebar: "#181825", ink: "#cdd6f4", accent: "#cba6f7", green: "#a6e3a1", red: "#f38ba8", amber: "#f9e2af", tokens: { keyword: "#cba6f7", string: "#a6e3a1", comment: "#6c7086", number: "#fab387", fn: "#89b4fa", type: "#f9e2af", tag: "#89b4fa", attr: "#f9e2af" } }],
    ["nord", { name: "Nord", dark: true, bg: "#2e3440", sidebar: "#272c36", ink: "#d8dee9", accent: "#88c0d0", green: "#a3be8c", red: "#bf616a", amber: "#ebcb8b", tokens: { keyword: "#81a1c1", string: "#a3be8c", comment: "#616e88", number: "#b48ead", fn: "#88c0d0", type: "#8fbcbb", tag: "#81a1c1", attr: "#8fbcbb" } }],
    ["one-dark", { name: "One Dark", dark: true, bg: "#282c34", sidebar: "#21252b", ink: "#abb2bf", accent: "#61afef", green: "#98c379", red: "#e06c75", amber: "#e5c07b", tokens: { keyword: "#c678dd", string: "#98c379", comment: "#5c6370", number: "#d19a66", fn: "#61afef", type: "#e5c07b", tag: "#e06c75", attr: "#d19a66" } }],
    ["github-dark", { name: "GitHub Dark", dark: true, bg: "#0d1117", sidebar: "#010409", ink: "#e6edf3", accent: "#2f81f7", green: "#3fb950", red: "#f85149", amber: "#d29922", tokens: { keyword: "#ff7b72", string: "#a5d6ff", comment: "#8b949e", number: "#79c0ff", fn: "#d2a8ff", type: "#ffa657", tag: "#7ee787", attr: "#79c0ff" } }],
    ["gruvbox", { name: "Gruvbox", dark: true, bg: "#282828", sidebar: "#1d2021", ink: "#ebdbb2", accent: "#fabd2f", green: "#b8bb26", red: "#fb4934", amber: "#fe8019", tokens: { keyword: "#fb4934", string: "#b8bb26", comment: "#928374", number: "#d3869b", fn: "#8ec07c", type: "#fabd2f", tag: "#fb4934", attr: "#83a598" } }],
    ["rose-pine", { name: "Rosé Pine", dark: true, bg: "#191724", sidebar: "#1f1d2e", ink: "#e0def4", accent: "#c4a7e7", green: "#9ccfd8", red: "#eb6f92", amber: "#f6c177", tokens: { keyword: "#31748f", string: "#f6c177", comment: "#6e6a86", number: "#ebbcba", fn: "#ebbcba", type: "#9ccfd8", tag: "#9ccfd8", attr: "#c4a7e7" } }],
    ["solarized-dark", { name: "Solarized Dark", dark: true, bg: "#002b36", sidebar: "#00212b", ink: "#93a1a1", accent: "#268bd2", green: "#859900", red: "#dc322f", amber: "#b58900", tokens: { keyword: "#859900", string: "#2aa198", comment: "#586e75", number: "#d33682", fn: "#268bd2", type: "#b58900", tag: "#268bd2", attr: "#93a1a1" } }],
    ["solarized-light", { name: "Solarized Light", dark: false, bg: "#fdf6e3", sidebar: "#eee8d5", ink: "#586e75", accent: "#268bd2", green: "#859900", red: "#dc322f", amber: "#b58900", tokens: { keyword: "#859900", string: "#2aa198", comment: "#93a1a1", number: "#d33682", fn: "#268bd2", type: "#b58900", tag: "#268bd2", attr: "#657b83" } }],
    ["catppuccin-latte", { name: "Catppuccin Latte", dark: false, bg: "#eff1f5", sidebar: "#e6e9ef", ink: "#4c4f69", accent: "#8839ef", green: "#40a02b", red: "#d20f39", amber: "#df8e1d", tokens: { keyword: "#8839ef", string: "#40a02b", comment: "#9ca0b0", number: "#fe640b", fn: "#1e66f5", type: "#df8e1d", tag: "#1e66f5", attr: "#df8e1d" } }],
    ["github-light", { name: "GitHub Light", dark: false, bg: "#ffffff", sidebar: "#f6f8fa", ink: "#1f2328", accent: "#0969da", green: "#1a7f37", red: "#cf222e", amber: "#9a6700", tokens: { keyword: "#cf222e", string: "#0a3069", comment: "#6e7781", number: "#0550ae", fn: "#8250df", type: "#953800", tag: "#116329", attr: "#0550ae" } }],
  ] as [string, Palette][]
).map(([id, p]) => themeFromPalette(p, `preset:${id}`));

const SAVED_KEY = "mpa.themes.saved";

/** The themes you made or imported and kept, newest first. */
export function savedThemes(): CustomTheme[] {
  try {
    const v = JSON.parse(localStorage.getItem(SAVED_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as CustomTheme[]).filter((t) => t && typeof t.id === "string" && typeof t.name === "string" && t.vars && typeof t.vars === "object") : [];
  } catch {
    return [];
  }
}

/** Keep one (replacing the one with its id), and give back the list. */
export function keepTheme(t: CustomTheme): CustomTheme[] {
  const theme = t.id && !t.id.startsWith("preset:") ? t : { ...t, id: `mine:${Date.now().toString(36)}` };
  const next = [theme, ...savedThemes().filter((x) => x.id !== theme.id)].slice(0, 40);
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(next));
  } catch {}
  return next;
}

export function forgetTheme(id: string): CustomTheme[] {
  const next = savedThemes().filter((x) => x.id !== id);
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(next));
  } catch {}
  return next;
}

/** A theme as a file to share: Friday reads it back whole, and its palette is all a maker needs. */
export function themeFile(t: CustomTheme): string {
  const { id: _id, ...rest } = t;
  return JSON.stringify({ friday: "theme", version: 1, ...rest }, null, 2);
}

/** A file somebody chose: one of Friday's theme files, or a VS Code colour theme. Null when it is neither. */
export function readThemeFile(json: unknown): CustomTheme | null {
  const f = json as Partial<CustomTheme> & { friday?: unknown } | null;
  if (f && f.friday === "theme") {
    const p = f.palette;
    if (p && typeof p === "object" && hex(p.bg) && hex(p.ink) && hex(p.accent)) {
      const opt = (v: unknown) => hex(v) ?? undefined;
      const tokens = Object.fromEntries(Object.entries(p.tokens ?? {}).flatMap(([k, v]) => (hex(v) ? [[k, hex(v)!]] : []))) as Partial<Record<TokenKind, string>>;
      const clean: Palette = { name: String(f.name ?? p.name ?? "Shared theme").slice(0, 60), dark: !!p.dark, bg: hex(p.bg)!, ink: hex(p.ink)!, accent: hex(p.accent)!, tokens };
      for (const k of ["sidebar", "green", "red", "amber"] as const) if (opt(p[k])) clean[k] = opt(p[k]);
      return themeFromPalette(clean);
    }
    if (typeof f.name === "string" && f.vars && typeof f.vars === "object") {
      // Only Friday's own tokens, and only colours: a shared file can't set anything else on the page.
      const vars = Object.fromEntries(Object.entries(f.vars).filter(([k, v]) => /^--[a-z0-9-]+$/.test(k) && typeof v === "string" && /^[#\w\s(),.%-]+$/.test(v) && !/url|expression|;/i.test(v)));
      const tokens = Object.fromEntries(Object.entries(f.tokens ?? {}).flatMap(([k, v]) => (hex(v) ? [[k, hex(v)!]] : []))) as Partial<Record<TokenKind, string>>;
      return { name: f.name.slice(0, 60), dark: !!f.dark, vars, tokens };
    }
    return null;
  }
  return vscodeTheme(json);
}

// ── on this computer ──────────────────────────────────────────────────

export function readTheme(): CustomTheme | null {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    const t = raw ? (JSON.parse(raw) as CustomTheme) : null;
    return t && typeof t.name === "string" && t.vars && typeof t.vars === "object" ? t : null;
  } catch {
    return null;
  }
}

/** Put a theme on the page (and keep it), or take one off (`null`). The light/dark class follows the theme's own darkness. */
export function applyTheme(theme: CustomTheme | null, keep = true): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const k of [...root.style].filter((p) => p.startsWith("--"))) if (k in (readTheme()?.vars ?? {}) || k in (theme?.vars ?? {})) root.style.removeProperty(k);
  if (theme) {
    for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
    root.classList.toggle("dark", theme.dark);
    root.classList.add("themed");
  } else {
    root.classList.remove("themed");
    // Back to Friday's own look, light or dark as chosen (or as the computer is): a theme taken off left its own darkness on
    // the page, white text on white where it had been dark (2026-10-27 audit).
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("mpa.theme");
    } catch {}
    root.classList.toggle("dark", saved === "dark" || saved === "light" ? saved === "dark" : !matchMedia("(prefers-color-scheme: light)").matches);
  }
  if (keep) {
    try {
      if (theme) localStorage.setItem(THEME_KEY, JSON.stringify(theme));
      else localStorage.removeItem(THEME_KEY);
    } catch {}
  }
  window.dispatchEvent(new Event("friday:theme"));
}

export function readFonts(): Fonts {
  try {
    const f = JSON.parse(localStorage.getItem(FONTS_KEY) ?? "{}") as Fonts;
    return { ...(typeof f.ui === "string" && f.ui.trim() ? { ui: f.ui.trim() } : {}), ...(typeof f.code === "string" && f.code.trim() ? { code: f.code.trim() } : {}) };
  } catch {
    return {};
  }
}

/** A name that is one family (no comma, no quotes): fetched from Google Fonts in case it isn't installed; it costs nothing when it is. */
const fetchable = (name: string) => /^[A-Za-z0-9 ]{2,40}$/.test(name);

/** Set the interface and code fonts (and keep them), or clear with `{}`. */
export function applyFonts(f: Fonts, keep = true): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const quote = (n: string) => (/^[\w-]+$/.test(n) ? n : `"${n.replace(/"/g, "")}"`);
  if (f.ui) {
    root.style.setProperty("--font", `${quote(f.ui)}, "Geist", "Inter", ui-sans-serif, system-ui, sans-serif`);
    root.style.setProperty("--font-reply", `${quote(f.ui)}, "Inter", ui-sans-serif, system-ui, sans-serif`);
  } else {
    root.style.removeProperty("--font");
    root.style.removeProperty("--font-reply");
  }
  if (f.code) root.style.setProperty("--mono", `${quote(f.code)}, "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace`);
  else root.style.removeProperty("--mono");
  for (const name of [f.ui, f.code]) {
    if (!name || !fetchable(name)) continue;
    const id = `friday-font-${name.replace(/\s+/g, "-").toLowerCase()}`;
    if (document.getElementById(id)) continue;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, "+")}:wght@400;500;600;700&display=swap`;
    document.head.appendChild(link);
  }
  if (keep) {
    try {
      if (f.ui || f.code) localStorage.setItem(FONTS_KEY, JSON.stringify(f));
      else localStorage.removeItem(FONTS_KEY);
    } catch {}
  }
}
