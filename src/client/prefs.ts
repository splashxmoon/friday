import { setTheme, type Theme } from "./storage.js";

/**
 * The choices a person makes about how Friday looks and behaves on this
 * device, kept in one place so they can be applied at boot, edited in
 * Settings, and carried to another machine as a file.
 *
 * They live in localStorage because they are about this screen, not about the
 * account: a laptop and a desktop monitor rightly differ on text size. The
 * export exists for the times they should not.
 */

export type ThemeChoice = "system" | "light" | "dark";
export type TextSize = "90" | "100" | "110" | "120";
/** How a Solo session is laid out: Focus (the status bar along the foot, a wider column) or Classic (as it was before). */
export type SessionLayout = "focus" | "classic";

const KEYS = {
  theme: "mpa.theme",
  textSize: "mpa.textSize",
  reduceMotion: "mpa.reduceMotion",
  notify: "mpa.notify",
  chime: "mpa.chime",
  folders: "mpa.folders",
  layout: "mpa.layout",
  sessionLayout: "mpa.sessionLayout",
} as const;

/** What an import may write: these keys and nothing else, whatever the file says. */
const EXPORTABLE: string[] = Object.values(KEYS);

function read(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

function write(k: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    // Blocked storage: the choice just won't outlive the tab.
  }
}

export const themeChoice = (): ThemeChoice => {
  const t = read(KEYS.theme);
  // Glass is gone (Dass, 2026-10-19): whoever had it gets the dark it was drawn on.
  return t === "light" || t === "dark" ? t : t === "glass" ? "dark" : "system";
};

export function chooseTheme(c: ThemeChoice): void {
  if (c === "system") {
    // No saved value is what makes the boot script follow the OS.
    write(KEYS.theme, null);
    const light = matchMedia("(prefers-color-scheme: light)").matches;
    setTheme(light ? "light" : "dark");
    write(KEYS.theme, null);
  } else setTheme(c as Theme);
  document.documentElement.classList.remove("glass");
}

export const textSize = (): TextSize => {
  const v = read(KEYS.textSize);
  return v === "90" || v === "110" || v === "120" ? v : "100";
};

export function chooseTextSize(s: TextSize): void {
  write(KEYS.textSize, s === "100" ? null : s);
  applyPrefs();
}

/** The in-app switch when it was set, otherwise what the OS asks for. */
export const reduceMotion = () => {
  const v = read(KEYS.reduceMotion);
  if (v === "1" || v === "0") return v === "1";
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
};

export function chooseReduceMotion(on: boolean): void {
  // Off is written as such, so somebody whose OS reduces motion can still turn it on here.
  write(KEYS.reduceMotion, on ? "1" : "0");
  applyPrefs();
}

export const sessionLayout = (): SessionLayout => (read(KEYS.sessionLayout) === "classic" ? "classic" : "focus");

export function chooseSessionLayout(l: SessionLayout): void {
  write(KEYS.sessionLayout, l === "focus" ? null : l);
  // An open session redraws on this, so the switch shows at once.
  dispatchEvent(new Event("friday:layout"));
}

/** On unless switched off: a notification you never asked for is worse than one you can mute. */
export const notificationsOn = () => read(KEYS.notify) !== "0";
export const chooseNotifications = (on: boolean) => write(KEYS.notify, on ? null : "0");
/** One soft sound when something needs you, window open or not; off is off. */
export const chimeOn = () => read(KEYS.chime) !== "0";
export const chooseChime = (on: boolean) => write(KEYS.chime, on ? null : "0");

/** Put the saved choices on the page. Called at boot and after every change. */
export function applyPrefs(): void {
  const root = document.documentElement;
  // `zoom` scales the whole interface the way the browser's own zoom does,
  // without every size in the stylesheet having to know about it.
  root.style.setProperty("zoom", textSize() === "100" ? "" : `${Number(textSize()) / 100}`);
  root.classList.toggle("reduce-motion", reduceMotion());
}

export interface PrefsFile {
  app: "friday";
  version: 1;
  exportedAt: string;
  prefs: Record<string, string>;
}

export function exportPrefs(): PrefsFile {
  const prefs: Record<string, string> = {};
  for (const k of EXPORTABLE) {
    const v = read(k);
    if (v !== null) prefs[k] = v;
  }
  return { app: "friday", version: 1, exportedAt: new Date().toISOString(), prefs };
}

/** Returns how many settings were taken, or throws with a sentence for the person. */
export function importPrefs(text: string): number {
  let file: Partial<PrefsFile>;
  try {
    file = JSON.parse(text) as Partial<PrefsFile>;
  } catch {
    throw new Error("That file isn't a Friday settings file.");
  }
  if (file.app !== "friday" || typeof file.prefs !== "object" || !file.prefs) throw new Error("That file isn't a Friday settings file.");
  let n = 0;
  for (const [k, v] of Object.entries(file.prefs)) {
    if (!EXPORTABLE.includes(k) || typeof v !== "string" || v.length > 4000) continue;
    write(k, v);
    n++;
  }
  if (!n) throw new Error("That file has no settings Friday recognises.");
  applyPrefs();
  const t = read(KEYS.theme);
  if (t === "light" || t === "dark") setTheme(t);
  else if (t === "glass") chooseTheme("dark");
  return n;
}

/** Back to how it looked on first launch. Leaves recent folders and the account alone. */
export function resetPrefs(): void {
  for (const k of [KEYS.theme, KEYS.textSize, KEYS.reduceMotion, KEYS.notify, KEYS.layout, KEYS.sessionLayout]) write(k, null);
  applyPrefs();
  dispatchEvent(new Event("friday:layout"));
  chooseTheme("system");
}
