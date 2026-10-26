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
  name: string;
  dark: boolean;
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
  } else root.classList.remove("themed");
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
