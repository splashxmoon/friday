import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api.js";
import type { Identity } from "./storage.js";
import { AppUpdate } from "./AppUpdate.js";
import { isLocal } from "./edition.js";
import { ShortcutList } from "./Shortcuts.js";
import { openOutside } from "./openOutside.js";
import {
  chooseNotifications,
  chooseReduceMotion,
  chooseTextSize,
  chooseTheme,
  exportPrefs,
  importPrefs,
  notificationsOn,
  reduceMotion,
  resetPrefs,
  textSize,
  themeChoice,
  type TextSize,
  type ThemeChoice,
  chimeOn,
  chooseChime,
  chooseSessionLayout,
  sessionLayout,
  type SessionLayout,
  ACCENTS,
  accent,
  chooseAccent,
  chooseContrast,
  contrast,
  type Accent,
  type Contrast,
} from "./prefs.js";
import { chime } from "./chime.js";
import { applyFonts, applyTheme, FRIDAY_PALETTES, forgetTheme, keepTheme, PRESETS, readFonts, readTheme, readThemeFile, savedThemes, themeFile, themeFromPalette, type CustomTheme, type Fonts, type Palette } from "./theme.js";
import { Icon } from "./icons.js";
import { DownloadIcon, ExternalLinkIcon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Choice, dangerOutline, Note, SettingsGroup, SettingsRow as Row, StateBadge } from "@/components/dass";

/**
 * The settings that are about this device rather than the account: how it
 * looks, what may interrupt you, which keys do what, and how to carry all of
 * that somewhere else.
 */

export function AppearanceTab() {
  const [theme, setTheme] = useState<ThemeChoice>(themeChoice);
  // Your own colours (a VS Code theme file) and type (theme.ts).
  const [custom, setCustom] = useState<CustomTheme | null>(readTheme);
  const [fonts, setFonts] = useState<Fonts>(readFonts);
  const [themeErr, setThemeErr] = useState("");
  const [mine, setMine] = useState<CustomTheme[]>(savedThemes);
  // A theme of yours just deleted, with Undo beside the line that says so: it went at one press, next to Export (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
  const [gone, setGone] = useState<{ t: CustomTheme; wasOn: boolean } | null>(null);
  // A font name nothing here or on Google Fonts has, said under it rather than taken without a word (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
  const [fontMiss, setFontMiss] = useState<Partial<Record<keyof Fonts, string>>>({});
  // The look changed from outside this page (the sidebar's light/dark button, another window): the choices here follow it, or
  // they kept saying System while the page was dark, and pressing System did nothing (2026-10-27 audit).
  useEffect(() => {
    const follow = () => (setTheme(themeChoice()), setCustom(readTheme()));
    const mo = new MutationObserver(follow);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    addEventListener("friday:theme", follow);
    addEventListener("storage", follow);
    return () => (mo.disconnect(), removeEventListener("friday:theme", follow), removeEventListener("storage", follow));
  }, []);
  /** The theme maker, open on a palette: a new one, or one of yours to change. */
  const [making, setMaking] = useState<{ palette: Palette; id?: string } | null>(null);
  const use = (t: CustomTheme | null) => (applyTheme(t), setCustom(t));
  const importTheme = async (file: File | undefined) => {
    if (!file) return;
    setThemeErr("");
    try {
      const t = readThemeFile(JSON.parse(await file.text()));
      if (!t) return setThemeErr("That file isn't a theme: neither one of Friday's nor a VS Code colour theme (it has no colors).");
      // Kept with yours, so it is still there after you try another.
      const list = keepTheme(t);
      setMine(list);
      use(list[0]!);
    } catch {
      setThemeErr("Couldn't read that file as JSON.");
    }
  };
  const share = (t: CustomTheme) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([themeFile(t)], { type: "application/json" }));
    a.download = `${t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "theme"}.friday-theme.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  const setFont = (which: keyof Fonts, value: string) => {
    const name = value.trim();
    const next = { ...fonts, [which]: name || undefined } as Fonts;
    if (!next.ui) delete next.ui;
    if (!next.code) delete next.code;
    setFonts(next);
    applyFonts(next);
    setFontMiss((m) => ({ ...m, [which]: "" }));
    if (name) void fontFound(name).then((ok) => setFontMiss((m) => (fontsNow.current[which] === name ? { ...m, [which]: ok ? "" : name } : m)));
  };
  const fontsNow = useRef(fonts);
  fontsNow.current = fonts;
  const [size, setSize] = useState<TextSize>(textSize);
  const [calm, setCalm] = useState(reduceMotion);
  const [layout, setLayout] = useState<SessionLayout>(sessionLayout);
  // The gallery opens by itself when one of its themes is on, so the one in use is never hidden.
  const [more, setMore] = useState(() => !!readTheme());
  useEffect(() => {
    if (custom || making) setMore(true);
  }, [custom, making]);
  const [tint, setTint] = useState<Accent>(accent);
  const [firm, setFirm] = useState<Contrast>(contrast);
  const pickLook = (v: ThemeChoice) => (setTheme(v), applyTheme(null), setCustom(null), chooseTheme(v));
  return (
    // Appearance after Synara's honest token set (DIRECTION.md §9.10; Arun, 2026-10-29: "so clean and beautiful really with a
    // clear direction in design language"): the look as three pictures, then accent, contrast, size and the two fonts; motion and
    // layout; and the twelve colour themes under More themes, Friday's own the designed default.
    <section className="flex flex-col gap-6">
      {/* With a colour theme on none of the three is pressed: it was "Light" under Dracula, and pressing it did nothing (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"). */}
      <div className="look-picks" role="radiogroup" aria-label="Theme">
        {(
          [
            ["system", "System"],
            ["light", "Light"],
            ["dark", "Dark"],
          ] as const
        ).map(([v, name]) => (
          <button key={v} type="button" role="radio" aria-checked={!custom && theme === v} className="look-pick" data-on={(!custom && theme === v) || undefined} onClick={() => pickLook(v)}>
            <LookThumb look={v} />
            <span className="look-pick-name">{name}</span>
          </button>
        ))}
      </div>
      {custom && <p className="set-note -mt-3 mb-0 text-[12px] text-[var(--text-muted)]">{custom.name} is on, from More themes. Picking System, Light or Dark goes back to Friday's own.</p>}
      <SettingsGroup title="Look">
        <Row label="Accent" hint={custom ? `${custom.name} brings its own accent; this one is Friday's.` : "The primary button and what is chosen in a menu. Friday's own is ink."}>
          <div className="accent-picks" role="radiogroup" aria-label="Accent">
            {ACCENTS.map((a) => (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={tint === a}
                aria-label={ACCENT_NAMES[a]}
                title={ACCENT_NAMES[a]}
                className="accent-pick"
                data-accent-swatch={a}
                data-on={tint === a || undefined}
                onClick={() => (setTint(a), chooseAccent(a))}
              />
            ))}
          </div>
        </Row>
        <Row label="Contrast" hint="More gives every line and grey a firmer step, for a bright room.">
          <Choice<Contrast>
            label="Contrast"
            value={firm}
            onChange={(v) => (setFirm(v), chooseContrast(v))}
            options={[
              ["standard", "Standard"],
              ["more", "More"],
            ]}
          />
        </Row>
        <Row label="Interface size" hint="Scales everything, the way zooming a browser does.">
          <Choice<TextSize>
            label="Interface size"
            value={size}
            onChange={(v) => (setSize(v), chooseTextSize(v))}
            options={[
              ["90", "Compact"],
              ["100", "Default"],
              ["110", "Large"],
              ["120", "Larger"],
            ]}
          />
        </Row>
        <Row label="Interface font" hint="Installed here, or a Google Fonts name. Empty is Geist.">
          <Input value={fonts.ui ?? ""} placeholder="Geist" aria-label="Interface font" aria-invalid={!!fontMiss.ui || undefined} className="w-56" onChange={(e) => setFonts({ ...fonts, ui: e.target.value })} onBlur={(e) => setFont("ui", e.target.value)} onKeyDown={(e) => e.key === "Enter" && setFont("ui", (e.target as HTMLInputElement).value)} />
        </Row>
        {fontMiss.ui && <Note ok={false}>No font called “{fontMiss.ui}” on this computer or on Google Fonts, so Friday's own shows. Check the spelling, or install it.</Note>}
        <Row label="Code font" hint="For code, diffs and the terminal. Empty is Geist Mono.">
          <Input value={fonts.code ?? ""} placeholder="Geist Mono" aria-label="Code font" aria-invalid={!!fontMiss.code || undefined} className="w-56 font-mono" onChange={(e) => setFonts({ ...fonts, code: e.target.value })} onBlur={(e) => setFont("code", e.target.value)} onKeyDown={(e) => e.key === "Enter" && setFont("code", (e.target as HTMLInputElement).value)} />
        </Row>
        {fontMiss.code && <Note ok={false}>No font called “{fontMiss.code}” on this computer or on Google Fonts, so Geist Mono shows. Check the spelling, or install it.</Note>}
      </SettingsGroup>
      <SettingsGroup title="Motion and layout">
        <Row
          label="Session layout"
          hint="Focus puts where the agent is working, its run and your changes in a bar along the foot of a session, and gives the chat more room. Classic is the earlier layout."
        >
          <Choice<SessionLayout>
            label="Session layout"
            value={layout}
            onChange={(v) => (setLayout(v), chooseSessionLayout(v))}
            options={[
              ["focus", "Focus"],
              ["classic", "Classic"],
            ]}
          />
        </Row>
        <Row label="Reduce motion" hint="Cuts out sliding and fading, and holds the working ring still. Already on if your computer asks for less motion.">
          <Switch aria-label="Reduce motion" checked={calm} onCheckedChange={(on) => (setCalm(on), chooseReduceMotion(on))} />
        </Row>
      </SettingsGroup>
      {/* Themes (Arun, 2026-10-26: "building custom themes and stuff in the appearance page"): the ones people ask for by name, and
          yours, made here from four colours or brought from VS Code or a friend's theme file. Folded under More themes: Friday's own
          is the designed default (DIRECTION.md §9.10). */}
      <SettingsGroup
        title={
          <button type="button" className="more-themes" aria-expanded={more} onClick={() => setMore((m) => !m)}>
            <Icon name={more ? "chevronDown" : "chevronRight"} size={16} />
            More themes
          </button>
        }
        hint={custom ? <span className="text-[12px] font-normal text-[var(--text-muted)]">{custom.name} on</span> : undefined}
      >
        {more ? (
          <>
            <Row stack label="Colour themes" hint="Their editor colours colour the code and the diffs too.">
              <div className="thm-grid" role="radiogroup" aria-label="Colour theme">
                <ThemeCard name="Friday" on={!custom} onPick={() => use(null)} swatch={theme === "light" || (theme === "system" && matchMedia("(prefers-color-scheme: light)").matches) ? FRIDAY_PALETTES.light : FRIDAY_PALETTES.dark} />
                {mine.map((t) => (
                  <ThemeCard
                    key={t.id}
                    name={t.name}
                    on={custom?.id === t.id}
                    onPick={() => use(t)}
                    swatch={t.palette ?? t}
                    actions={
                      <>
                        {t.palette && (
                          <button type="button" className="icon-btn tiny" title={`Change ${t.name}`} aria-label={`Change ${t.name}`} onClick={() => setMaking({ palette: t.palette!, id: t.id! })}>
                            <Icon name="pencil" size={12} />
                          </button>
                        )}
                        <button type="button" className="icon-btn tiny" title={`Save ${t.name} as a file to share`} aria-label={`Export ${t.name}`} onClick={() => share(t)}>
                          <Icon name="download" size={12} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn tiny"
                          title={`Delete ${t.name}`}
                          aria-label={`Delete ${t.name}`}
                          onClick={() => {
                            setGone({ t, wasOn: custom?.id === t.id });
                            setMine(forgetTheme(t.id!));
                            if (custom?.id === t.id) use(null);
                          }}
                        >
                          <Icon name="trash" size={12} />
                        </button>
                      </>
                    }
                  />
                ))}
                {PRESETS.map((t) => (
                  <ThemeCard key={t.id} name={t.name} on={custom?.id === t.id} onPick={() => use(t)} swatch={t.palette!} />
                ))}
              </div>
              <span className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setMaking({ palette: { ...(custom?.palette ?? (document.documentElement.classList.contains("dark") ? FRIDAY_PALETTES.dark : FRIDAY_PALETTES.light)), name: custom?.palette ? `${custom.name} (mine)` : "My theme" } })}>
                  <Icon name="plus" size={16} /> Make your own
                </Button>
                <label className="btn small ghost" style={{ cursor: "pointer" }}>
                  <UploadIcon className="size-4" /> Import a theme file
                  <input type="file" accept=".json,application/json" className="sr-only" onChange={(e) => (void importTheme(e.target.files?.[0]), (e.target.value = ""))} />
                </label>
                {custom && !custom.id?.startsWith("mine:") && (
                  <Button variant="ghost" size="sm" onClick={() => share(custom)}>
                    <DownloadIcon className="size-4" /> Export this one
                  </Button>
                )}
              </span>
              {gone && (
                <span className="set-note text-[13px] text-[var(--text-muted)]" role="status">
                  Deleted {gone.t.name}.{" "}
                  <Button
                    variant="link"
                    size="xs"
                    autoFocus
                    className="h-auto px-0 text-[13px] text-[var(--ink)] underline"
                    onClick={() => {
                      const list = keepTheme(gone.t);
                      setMine(list);
                      if (gone.wasOn) use(list[0]!);
                      setGone(null);
                    }}
                  >
                    Undo
                  </Button>
                </span>
              )}
              <span className="text-[12px] leading-4 text-[var(--text-muted)]">A file is one of Friday's (exported here) or a VS Code colour theme: an extension's JSON, or File › Preferences › Generate Color Theme From Current Settings.</span>
            </Row>
            {making && (
              <ThemeMaker
                start={making.palette}
                onCancel={() => {
                  setMaking(null);
                  // The live preview put away: whatever was chosen before comes back.
                  const kept = readTheme();
                  applyTheme(kept, false);
                  if (!kept) chooseTheme(themeChoice());
                }}
                onSave={(p) => {
                  setGone(null);
                  const list = keepTheme(themeFromPalette(p, making.id));
                  setMine(list);
                  use(list[0]!);
                  setMaking(null);
                }}
              />
            )}
            {themeErr && <Note ok={false}>{themeErr}</Note>}
          </>
        ) : (
          <div className="py-3 text-[12px] leading-4 text-[var(--text-muted)]">Dracula, Tokyo Night, Catppuccin, Nord and eight more, one of your own, or a VS Code theme file.</div>
        )}
      </SettingsGroup>
    </section>
  );
}

const ACCENT_NAMES: Record<Accent, string> = { ink: "Ink (Friday's own)", violet: "Violet", indigo: "Indigo", teal: "Teal", rose: "Rose" };

/** Friday's look as a small window: its sidebar, a few lines of text and the primary pill. System is half light, half dark. */
function LookThumb({ look }: { look: ThemeChoice }) {
  const win = (p: Palette) => (
    <span className="look-win" style={{ background: p.bg }}>
      <span className="look-win-side" style={{ background: p.sidebar }}>
        <i style={{ background: p.ink, opacity: 0.55 }} />
        <i style={{ background: p.ink, opacity: 0.25 }} />
        <i style={{ background: p.ink, opacity: 0.25 }} />
      </span>
      <span className="look-win-main">
        <i style={{ background: p.ink, width: "62%" }} />
        <i style={{ background: p.ink, opacity: 0.35, width: "84%" }} />
        <i style={{ background: p.ink, opacity: 0.35, width: "70%" }} />
        <b style={{ background: p.accent }} />
      </span>
    </span>
  );
  if (look !== "system") return <span className="look-thumb" aria-hidden>{win(FRIDAY_PALETTES[look])}</span>;
  return (
    <span className="look-thumb look-split" aria-hidden>
      {win(FRIDAY_PALETTES.light)}
      {win(FRIDAY_PALETTES.dark)}
    </span>
  );
}

/** One theme in the gallery: a small picture of the window in its colours, and its name. */
function ThemeCard({ name, on, onPick, swatch, actions }: { name: string; on: boolean; onPick: () => void; swatch: Palette | CustomTheme; actions?: ReactNode }) {
  const c =
    "bg" in swatch
      ? { bg: swatch.bg, side: swatch.sidebar ?? swatch.bg, ink: swatch.ink, accent: swatch.accent, muted: `color-mix(in srgb, ${swatch.ink} 40%, ${swatch.bg})` }
      : { bg: swatch.vars["--bg"], side: swatch.vars["--sidebar"], ink: swatch.vars["--ink"], accent: swatch.vars["--accent"], muted: swatch.vars["--text-muted"] };
  return (
    <div className="thm-card" data-on={on || undefined}>
      <button type="button" role="radio" aria-checked={on} className="thm-pick" onClick={onPick} title={on ? `${name} is on` : `Use ${name}`}>
        <span className="thm-swatch" style={{ background: c.bg }} aria-hidden>
          <span className="thm-side" style={{ background: c.side }} />
          <span className="thm-lines">
            <i style={{ background: c.ink, width: "70%" }} />
            <i style={{ background: c.muted, width: "48%" }} />
            <i className="thm-pill" style={{ background: c.accent }} />
          </span>
        </span>
        {/* The name in a box of its own, cut short with "…" before your theme's buttons: it ran under them (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"). */}
        <span className="thm-name" title={name}>
          {on && <Icon name="check" size={12} />}
          <span className="thm-name-text">{name}</span>
        </span>
      </button>
      {actions && <span className="thm-acts">{actions}</span>}
    </div>
  );
}

const MAKER_COLOURS: [keyof Palette, string][] = [
  ["bg", "Background"],
  ["sidebar", "Sidebar"],
  ["ink", "Text"],
  ["accent", "Accent"],
  ["green", "Done and added"],
  ["amber", "Waiting"],
  ["red", "Errors and removed"],
];

/**
 * The maker's Light or Dark: the colours picked here stay; the surfaces (background, sidebar, text) not picked take the other
 * look's, as they must for light or dark to mean anything; accent and status colours that came with the theme stay, unless they
 * were Friday's own defaults, which follow the look.
 */
export function flipPalette(x: Palette, dark: boolean, picked: ReadonlySet<keyof Palette>): Palette {
  if (x.dark === dark) return x;
  const was = FRIDAY_PALETTES[x.dark ? "dark" : "light"];
  const to = FRIDAY_PALETTES[dark ? "dark" : "light"];
  const out: Palette = { ...to, name: x.name, ...(x.tokens ? { tokens: x.tokens } : {}) };
  for (const k of ["bg", "sidebar", "ink", "accent", "green", "red", "amber"] as const) {
    const v = x[k];
    if (!v) continue;
    const surface = k === "bg" || k === "sidebar" || k === "ink";
    if (picked.has(k) || (!surface && v.toLowerCase() !== (was[k] ?? "").toLowerCase())) out[k] = v;
  }
  return out;
}

/**
 * Whether a font by this name is here: installed, or come from Google Fonts. A name nothing has draws in the fallback, so text in
 * it measures as the fallback does in both a serif and a monospace fallback.
 */
async function fontFound(name: string): Promise<boolean> {
  if (typeof document === "undefined") return true;
  const fam = `"${name.replace(/"/g, "")}"`;
  // A Google Fonts sheet the name may have asked for (theme.ts applyFonts): given a moment to come and its faces to load.
  await new Promise((r) => setTimeout(r, 900));
  try {
    await Promise.race([document.fonts.load(`16px ${fam}`), new Promise((r) => setTimeout(r, 2500))]);
  } catch {
    /* measured below all the same */
  }
  const c = document.createElement("canvas").getContext("2d");
  if (!c) return true;
  const sample = "mmmmmmmmmmlli1WQ@#0";
  const width = (font: string) => ((c.font = font), c.measureText(sample).width);
  return ["monospace", "serif"].some((fb) => width(`32px ${fam}, ${fb}`) !== width(`32px ${fb}`));
}

/** Four colours (and three more if you like) into a whole theme, shown on the app as you pick them. */
function ThemeMaker({ start, onCancel, onSave }: { start: Palette; onCancel: () => void; onSave: (p: Palette) => void }) {
  const [p, setP] = useState<Palette>(start);
  // Live, without keeping it: Cancel puts back what was there.
  useEffect(() => applyTheme(themeFromPalette(p), false), [p]);
  // The colours picked here, which Light or Dark keeps: it reset every one of them (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
  const picked = useRef(new Set<keyof Palette>());
  const set = (k: keyof Palette, v: string) => (k !== "name" && picked.current.add(k), setP((x) => ({ ...x, [k]: v })));
  const flip = (dark: boolean) => setP((x) => flipPalette(x, dark, picked.current));
  const fresh = useRef(false);
  return (
    <div className="thm-maker" role="group" aria-label="Make a theme">
      <div className="thm-maker-head">
        <span className="flex items-center gap-2">
          {/* Its name is a suggestion to type over: taken whole on focus, so typing replaces "My theme" rather than running on after
              it (QA round 2, verify-report: "My themeA really long…"). The press that focused it doesn't then drop the selection. */}
          <Input
            value={p.name}
            maxLength={60}
            aria-label="Theme name"
            className="w-56"
            autoFocus
            onFocus={(e) => ((fresh.current = true), e.currentTarget.select())}
            onMouseUp={(e) => fresh.current && ((fresh.current = false), e.preventDefault())}
            onChange={(e) => set("name", e.target.value)}
          />
          {/* The limit said near it, not a name cut short without a word (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"). */}
          {p.name.length >= 50 && <span className={`inline-edit-left${p.name.length >= 60 ? " full" : ""}`} aria-live="polite">{p.name.length >= 60 ? "60 max" : 60 - p.name.length}</span>}
        </span>
        <Choice<"dark" | "light">
          label="Light or dark"
          value={p.dark ? "dark" : "light"}
          onChange={(v) => flip(v === "dark")}
          options={[
            ["dark", "Dark"],
            ["light", "Light"],
          ]}
        />
      </div>
      <div className="thm-maker-colours">
        {MAKER_COLOURS.map(([k, label]) => {
          const v = (p[k] as string | undefined) ?? (k === "sidebar" ? p.bg : "#888888");
          return (
            <label key={k} className="thm-colour">
              <input type="color" value={/^#[0-9a-f]{6}$/i.test(v) ? v : "#888888"} onChange={(e) => set(k, e.target.value)} aria-label={label} />
              <span>
                {label}
                <code>{v}</code>
              </span>
            </label>
          );
        })}
      </div>
      <div className="thm-maker-foot">
        <span className="muted small">Shown on the app as you pick. Saved, it stays with your themes on this computer; Export makes a file to share.</span>
        <span className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={!p.name.trim()} onClick={() => onSave({ ...p, name: p.name.trim() })}>
            Save theme
          </Button>
        </span>
      </div>
    </div>
  );
}

export function NotificationsTab({ identity }: { identity: Identity }) {
  const [on, setOn] = useState(notificationsOn);
  const [sound, setSound] = useState(chimeOn);
  const supported = typeof Notification !== "undefined";
  const [perm, setPerm] = useState<NotificationPermission>(
    supported ? Notification.permission : "denied",
  );
  return (
    <section className="flex flex-col gap-5">
      <SettingsGroup title="On this device">
        <Row
          label="Alert me when I'm away"
          hint={
            on && supported && perm === "denied"
              ? "On, but notifications are blocked for Friday on this device, so no banner can show: allow them (Permission, below)."
              : on
                ? "A banner appears when a session needs you."
                : "Nothing leaves the app. The sidebar still marks sessions that need you."
          }
        >
          <Switch
            aria-label="Alert me when I'm away"
            checked={on}
            onCheckedChange={(v) => (setOn(v), chooseNotifications(v))}
          />
        </Row>
        <Row
          label="A soft chime when something needs you"
          hint={
            sound
              ? "One short sound, window open or not. Nothing for anything else."
              : "Silent."
          }
        >
          <Switch
            aria-label="A soft chime when something needs you"
            checked={sound}
            onCheckedChange={(v) => (setSound(v), chooseChime(v), v && chime())}
          />
        </Row>
        <Row
          label="Permission"
          hint={
            !supported
              ? "This window can't show notifications."
              : perm === "granted"
                ? "Friday can notify you on this device."
                : perm === "denied"
                  ? "Allow notifications for Friday in your browser or system settings, then come back."
                  : "Not asked yet. Friday asks once, or you can allow it now."
          }
        >
          {supported && perm === "default" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void Notification.requestPermission().then(setPerm)
              }
            >
              Allow
            </Button>
          )}
          {supported && perm !== "default" && (
            <StateBadge {...(perm === "granted" ? {} : { tone: "needs" as const })}>
              {perm === "granted" ? "Allowed" : "Blocked"}
            </StateBadge>
          )}
        </Row>
      </SettingsGroup>
    </section>
  );
}

export function ShortcutsTab() {
  return (
    <section className="flex flex-col gap-5">
      <p className="m-0 text-[13px] text-[var(--text-muted)]">
        Press <kbd className="dass-kbd ml-0">?</kbd> anywhere outside a text box to see this list.
      </p>
      <ShortcutList />
    </section>
  );
}

export function DataTab() {
  const file = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  // Reset says what it did beside its own button, with Undo there and focused, rather than a card away.
  const [reset, setReset] = useState<{ text: string; undo?: () => void } | null>(null);
  const undoBtn = useRef<HTMLButtonElement>(null);
  const resetBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (reset?.undo) undoBtn.current?.focus();
  }, [reset]);

  const download = () => {
    // Whatever was said about a reset is done with once something else happens here: "Settings reset. Undo" stayed up after
    // an import, offering to undo the wrong thing (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
    setReset(null);
    const blob = new Blob([JSON.stringify(exportPrefs(), null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "friday-settings.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    setNote({ ok: true, text: "Saved friday-settings.json." });
  };

  const upload = async (f: File | undefined) => {
    if (!f) return;
    setReset(null);
    try {
      const n = importPrefs(await f.text());
      setNote({
        ok: true,
        text: `Imported ${n} setting${n === 1 ? "" : "s"}. Reload to see everything take effect.`,
      });
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    }
    if (file.current) file.current.value = "";
  };

  return (
    <section className="flex flex-col gap-5">
      <SettingsGroup title="Your settings file">
        <Row
          label="Export settings"
          hint="A small file with your theme, size, notifications and layout, to import on another computer. No account details or sessions."
        >
          <Button variant="outline" size="sm" onClick={download}>
            <DownloadIcon /> Export
          </Button>
        </Row>
        <Row
          label="Import settings"
          hint="Choose a file you exported from Friday. Only known settings are read."
        >
          <Button variant="outline" size="sm" onClick={() => file.current?.click()}>
            <UploadIcon /> Import…
          </Button>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => void upload(e.target.files?.[0])}
          />
        </Row>
      </SettingsGroup>
      <Note>{note?.ok ? note.text : ""}</Note>
      <Note ok={false}>{note && !note.ok ? note.text : ""}</Note>
      {/* The open-source edition has no analytics to share, so nothing to turn off: it was a switch showing On for nothing. */}
      {!isLocal() && <ShareAnalytics />}
      {/* Reset can be taken back, so it asks nothing first: one press, and Undo on the line that says it happened. */}
      <SettingsGroup title="Start over">
        <Row
          label="Reset to defaults"
          hint={`Theme follows the system, Friday's own colours and fonts, default size, notifications and chime on, layout as new. ${isLocal() ? "Your sessions and coding tools" : "Your account and sessions"} are untouched.`}
        >
          <span className="set-note text-[13px] text-[var(--text-muted)]" role="status">
            {reset?.text}
            {reset?.undo && (
              <>
                {" "}
                <Button variant="link" size="xs" ref={undoBtn} className="h-auto px-0 text-[13px] text-[var(--ink)] underline" onClick={reset.undo}>
                  Undo
                </Button>
              </>
            )}
          </span>
          <Button
            variant="outline"
            size="sm"
            ref={resetBtn}
            className={dangerOutline}
            onClick={() => {
              const before = JSON.stringify(exportPrefs());
              resetPrefs();
              setNote(null);
              setReset({
                text: "Settings reset.",
                undo: () => {
                  try {
                    // Everything was at its default already: the reset changed nothing, so there is nothing to put back.
                    if (Object.keys((JSON.parse(before) as { prefs?: object }).prefs ?? {}).length) importPrefs(before);
                    setReset({ text: "Settings put back as they were." });
                  } catch (e) {
                    setReset({ text: `Couldn't put them back: ${(e as Error).message}` });
                  }
                  resetBtn.current?.focus();
                },
              });
            }}
          >
            Reset
          </Button>
        </Row>
      </SettingsGroup>
    </section>
  );
}

/** "Share usage analytics": on unless turned off, for the account (src/analytics.ts says what is and isn't sent). */
function ShareAnalytics() {
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/me/analytics", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (b: { on?: boolean } | null) => setOn(b?.on !== false),
        () => setOn(true),
      );
  }, []);
  const set = (v: boolean) => {
    setOn(v);
    setError("");
    fetch("/api/me/analytics", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ on: v }),
    })
      .then((r) => {
        if (!r.ok) throw new Error();
      })
      .catch(() => (setOn(!v), setError("Couldn't save that. Try again.")));
  };
  return (
    <>
      <SettingsGroup title="Privacy">
        <Row
          label="Share usage analytics"
          hint="Counts of what you do in Friday, like runs started and people joining, so we can see what helps. Never your code, files, paths, prompts or what agents write."
        >
          <Switch
            aria-label="Share usage analytics"
            checked={on ?? true}
            disabled={on === null}
            onCheckedChange={set}
          />
        </Row>
      </SettingsGroup>
      <Note ok={false}>{error}</Note>
    </>
  );
}

const RELEASES = "https://github.com/splashxmoon/friday-releases/releases";

export function AboutTab({ onReplayTour }: { onReplayTour?: () => void }) {
  // Outside the desktop app (which says its version and updates itself, AppUpdate) the version is the server's own: the page
  // said "Updates" and showed none (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
  const app = typeof window !== "undefined" && !!window.fridayDesktop?.update;
  const [version, setVersion] = useState("");
  useEffect(() => {
    if (app) return;
    fetch("/api/version", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { version?: string } | null) => setVersion(b?.version ?? ""))
      .catch(() => {});
  }, [app]);
  return (
    <section className="flex flex-col gap-5">
      <AppUpdate />
      {!app && version && (
        <SettingsGroup title="Version">
          <Row label={`Friday ${version}`} hint={isLocal() ? "Running on this computer. A newer one comes with the desktop app, which updates itself, or with git pull where you run it from source. Release notes, below, say what each one changed." : "The version this page is served from. The desktop app updates itself."} />
        </SettingsGroup>
      )}
      {/* Things to do are buttons on the right of a row, not dimmer text in the value column beside "A browser". */}
      <SettingsGroup title="Learn">
        {/* The open-source edition has no tour: only setting up this computer again. */}
        <Row
          label={isLocal() ? "Setup" : "Guided tour"}
          hint={isLocal() ? "This computer, its coding tools and GitHub, as when Friday first opened." : "A minute's walk through the parts of Friday."}
        >
          <Button variant="outline" size="sm" onClick={() => window.dispatchEvent(new Event("friday:setup"))}>
            Set up this computer
          </Button>
          {!isLocal() && (
            <Button variant="outline" size="sm" onClick={onReplayTour}>
              Replay the tour
            </Button>
          )}
        </Row>
        <Row label="Release notes" hint="What changed in each version.">
          <Button variant="outline" size="sm" onClick={() => openOutside(RELEASES)}>
            Release notes <ExternalLinkIcon />
          </Button>
        </Row>
      </SettingsGroup>
    </section>
  );
}
