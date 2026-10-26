import { useEffect, useRef, useState } from "react";
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
} from "./prefs.js";
import { chime } from "./chime.js";
import { applyFonts, applyTheme, readFonts, readTheme, vscodeTheme, type CustomTheme, type Fonts } from "./theme.js";
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
  const importTheme = async (file: File | undefined) => {
    if (!file) return;
    setThemeErr("");
    try {
      const t = vscodeTheme(JSON.parse(await file.text()));
      if (!t) return setThemeErr("That file isn't a VS Code colour theme: it has no colors.");
      applyTheme(t);
      setCustom(t);
    } catch {
      setThemeErr("Couldn't read that file as JSON.");
    }
  };
  const setFont = (which: keyof Fonts, value: string) => {
    const next = { ...fonts, [which]: value.trim() || undefined } as Fonts;
    if (!next.ui) delete next.ui;
    if (!next.code) delete next.code;
    setFonts(next);
    applyFonts(next);
  };
  const [size, setSize] = useState<TextSize>(textSize);
  const [calm, setCalm] = useState(reduceMotion);
  const [layout, setLayout] = useState<SessionLayout>(sessionLayout);
  return (
    <section className="flex flex-col gap-5">
      <SettingsGroup title="Look">
        <Row
          label="Theme"
          hint="System follows your computer, and changes with it."
        >
          <Choice<ThemeChoice>
            label="Theme"
            value={theme}
            onChange={(v) => (setTheme(v), applyTheme(null), setCustom(null), chooseTheme(v))}
            options={[
              ["system", "System"],
              ["light", "Light"],
              ["dark", "Dark"],
            ]}
          />
        </Row>
        <Row
          label="Colours"
          hint={custom ? `${custom.name}: a VS Code theme, ${custom.dark ? "dark" : "light"}. Picking Light, Dark or System above puts it away.` : "Bring the colours you use in VS Code: the theme's JSON file (an extension's, or File › Preferences › Generate Color Theme From Current Settings). Its token colours colour the editor and the diffs too."}
        >
          <span className="flex items-center gap-2">
            <label className="btn small ghost" style={{ cursor: "pointer" }}>
              <UploadIcon className="size-3.5" /> {custom ? "Replace" : "Import a VS Code theme"}
              <input type="file" accept=".json,application/json" className="sr-only" onChange={(e) => void importTheme(e.target.files?.[0])} />
            </label>
            {custom && (
              <Button variant="outline" size="sm" onClick={() => (applyTheme(null), setCustom(null))}>
                Remove
              </Button>
            )}
          </span>
        </Row>
        {themeErr && <Note ok={false}>{themeErr}</Note>}
        <Row label="Interface font" hint="A font installed on this computer, or a Google Fonts name; empty is Friday's own (Geist, Inter for replies).">
          <Input value={fonts.ui ?? ""} placeholder="Geist" aria-label="Interface font" className="h-8 w-56 text-[13px]" onChange={(e) => setFonts({ ...fonts, ui: e.target.value })} onBlur={(e) => setFont("ui", e.target.value)} onKeyDown={(e) => e.key === "Enter" && setFont("ui", (e.target as HTMLInputElement).value)} />
        </Row>
        <Row label="Code font" hint="For code, diffs and the terminal; empty is Geist Mono.">
          <Input value={fonts.code ?? ""} placeholder="Geist Mono" aria-label="Code font" className="h-8 w-56 text-[13px]" onChange={(e) => setFonts({ ...fonts, code: e.target.value })} onBlur={(e) => setFont("code", e.target.value)} onKeyDown={(e) => e.key === "Enter" && setFont("code", (e.target as HTMLInputElement).value)} />
        </Row>
        <Row
          label="Interface size"
          hint="Scales everything, the way zooming a browser does."
        >
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
        <Row
          label="Reduce motion"
          hint="Cuts out sliding and fading. Turned on for you already if your computer asks for less motion."
        >
          <Switch
            aria-label="Reduce motion"
            checked={calm}
            onCheckedChange={(on) => (setCalm(on), chooseReduceMotion(on))}
          />
        </Row>
      </SettingsGroup>
    </section>
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
            on
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
      <p className="m-0 text-[12.5px] text-[var(--text-muted)]">
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
          hint="Theme follows the system, default size, notifications on, layout as new. Your account and sessions are untouched."
        >
          <span className="set-note text-[12.5px] text-[var(--text-muted)]" role="status">
            {reset?.text}
            {reset?.undo && (
              <>
                {" "}
                <Button variant="link" size="xs" ref={undoBtn} className="h-auto px-0 text-[12.5px] text-[var(--ink)] underline" onClick={reset.undo}>
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
  return (
    <section className="flex flex-col gap-5">
      <AppUpdate />
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
