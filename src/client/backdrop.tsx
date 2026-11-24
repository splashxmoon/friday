/**
 * Backdrops behind the app (Arun, 2026-11-20: "app backdrop customization... users can ask their agent or whatever to create a
 * custom UI backdrop for the app"), in the open-source edition since v0.4.1 (backdrops.ts serves them).
 *
 * One backdrop fills the window behind everything, under a dim of the theme's own ground, with every surface on it frosted
 * (prefs.ts applyGlass, while html.backdrop is on), and light or dark as the backdrop is, not as the theme says (Arun, 2026-11-20:
 * "for the backdrop there should be no light or dark mode... that defeats the point"). Friday's own few are drawn here; yours are folders in ~/.friday/backdrops,
 * shown as they are saved: a picture, a muted looping video, or a page in a sandboxed frame (no network, no Friday). Not in Code,
 * the IDE (Arun: "Whether a backdrop also shows inside the IDE's window. nope"). Still when motion is turned down; nothing moves
 * while the window is hidden.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { useMode } from "./ide/mode.js";
import { applyGlass, themeChoice } from "./prefs.js";
import { tellDesktopTheme } from "./storage.js";
import { applyTheme, readTheme } from "./theme.js";
import "./backdrop.css";

export type BackdropKind = "image" | "video" | "page";
export interface FolderBackdrop {
  id: string;
  name: string;
  kind: BackdropKind;
  file: string;
  tone?: "light" | "dark";
  dim?: number;
  v: number;
}
export interface BackdropsView {
  dir: string;
  version: number;
  backdrops: FolderBackdrop[];
  unfinished: { id: string; why: string }[];
}
/** Friday's own: drawn in CSS (backdrop.css .bd-b-<id>), so they cost nothing and need no folder. */
export interface BuiltinBackdrop {
  id: string;
  name: string;
  tone: "light" | "dark";
  moves?: boolean;
}
export const BUILTINS: readonly BuiltinBackdrop[] = [
  { id: "dusk", name: "Dusk", tone: "dark" },
  { id: "tide", name: "Tide", tone: "dark" },
  { id: "aurora", name: "Aurora", tone: "dark", moves: true },
  { id: "fog", name: "Fog", tone: "light" },
  { id: "paper", name: "Paper", tone: "light" },
];
export type Shown = { from: "builtin"; b: BuiltinBackdrop } | { from: "folder"; b: FolderBackdrop };

// ── What is picked, on this screen (kept with the page's other settings: local page-keep mirrors friday.* keys) ──────────────
export type Dim = 0 | 20 | 40 | 60;
export type Blur = 0 | 8 | 24;
export interface Pick {
  /** "none", "b:<builtin id>" or "f:<folder id>". */
  id: string;
  dim: Dim;
  blur: Blur;
  /** Off: a video or a page holds one still frame. */
  motion: boolean;
}
const KEY = "friday.backdrop";
const NONE: Pick = { id: "none", dim: 0, blur: 0, motion: true };
/** Picks kept before 2026-11-20's livelier look carried a dim of their backdrop's asking: back to none once (Arun: "less dimmier"). */
const REV = 2;
const DIMS: Dim[] = [0, 20, 40, 60];
const BLURS: Blur[] = [0, 8, 24];
const pickListeners = new Set<() => void>();
let pickNow: Pick | null = null;
function readPick(): Pick {
  if (pickNow) return pickNow;
  let p: Partial<Pick> & { rev?: number } = {};
  try {
    p = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Pick> & { rev?: number };
    if (p.rev !== REV) p.dim = 0;
  } catch {
    // Nothing kept, or blocked storage: none.
  }
  return (pickNow = {
    id: typeof p.id === "string" && /^(none|b:[a-z]+|f:[a-z0-9][a-z0-9_-]{0,47})$/i.test(p.id) ? p.id : "none",
    dim: DIMS.includes(p.dim as Dim) ? (p.dim as Dim) : NONE.dim,
    blur: BLURS.includes(p.blur as Blur) ? (p.blur as Blur) : NONE.blur,
    motion: p.motion !== false,
  });
}
export function choose(next: Partial<Pick>): void {
  pickNow = { ...readPick(), ...next };
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...pickNow, rev: REV }));
  } catch {
    // A preference: it lasts as long as the page.
  }
  pickListeners.forEach((l) => l());
}
export const usePick = (): Pick => useSyncExternalStore((l) => (pickListeners.add(l), () => void pickListeners.delete(l)), readPick, () => NONE);

// ── The folder's backdrops, read and kept current ───────────────────────────────────────────────────────────────────────────
let view: BackdropsView | null = null;
const viewListeners = new Set<() => void>();
/** Valid ones seen so far: one that turns up after the first read was just made (an agent's, or one added), and is picked. */
let seen: Set<string> | null = null;
let started = false;
async function load(): Promise<void> {
  try {
    const r = await fetch("/api/local/backdrops", { cache: "no-store" });
    if (!r.ok) return;
    view = (await r.json()) as BackdropsView;
  } catch {
    return;
  }
  const ids = new Set(view.backdrops.map((b) => b.id));
  if (seen) {
    const made = view.backdrops.find((b) => !seen!.has(b.id));
    if (made) choose({ id: `f:${made.id}` });
  }
  seen = ids;
  viewListeners.forEach((l) => l());
}
export const reloadBackdrops = load;
/** Read now, and again each time the folder changes. */
export function startBackdrops(): void {
  if (started) return;
  started = true;
  void load();
  if (typeof EventSource === "undefined") return;
  const es = new EventSource("/api/local/backdrops/events");
  let first = true;
  es.onmessage = () => {
    if (first) return void (first = false);
    void load();
  };
}
export const useBackdrops = (): BackdropsView | null => useSyncExternalStore((l) => (viewListeners.add(l), () => void viewListeners.delete(l)), () => view, () => null);
/** A backdrop's file, as served (walled off): `?v=` its newest change, so a saved one loads afresh. */
export const fileUrl = (b: FolderBackdrop, file = b.file, still = false) =>
  `/api/local/backdrops/f/${encodeURIComponent(b.id)}/${file.split("/").map(encodeURIComponent).join("/")}?v=${b.v}${still ? "&still=1" : ""}`;

export function shownOf(id: string, v: BackdropsView | null): Shown | null {
  if (id.startsWith("b:")) {
    const b = BUILTINS.find((x) => x.id === id.slice(2));
    return b ? { from: "builtin", b } : null;
  }
  if (id.startsWith("f:")) {
    const b = v?.backdrops.find((x) => x.id === id.slice(2));
    return b ? { from: "folder", b } : null;
  }
  return null;
}
export const shownKey = (s: Shown) => (s.from === "builtin" ? `b:${s.b.id}` : `f:${s.b.id}:${s.b.v}`);

/** Whether this screen asks for less motion: the computer's own setting, or Settings › Appearance's (html.reduce-motion). */
function useCalm(): boolean {
  const q = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  const read = () => !!q?.matches || document.documentElement.classList.contains("reduce-motion");
  const [calm, setCalm] = useState(read);
  useEffect(() => {
    const on = () => setCalm(read());
    q?.addEventListener?.("change", on);
    const mo = new MutationObserver(on);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => (q?.removeEventListener?.("change", on), mo.disconnect());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return calm;
}

/**
 * One backdrop, drawn to fill its box: the layer behind the app, or a thumbnail in Settings (`thumb`: a page shown at a quarter
 * of its size, still). `onReady` once there is something to see, so the one before it can go.
 */
export function BackdropView({ shown, still, thumb, onReady, style }: { shown: Shown; still?: boolean; thumb?: boolean; onReady?: () => void; style?: CSSProperties }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (shown.from === "builtin") onReady?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A video plays only while the window is seen and motion is on; held, it shows its first frame.
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const sync = () => {
      if (still || document.hidden) el.pause();
      else void el.play().catch(() => {});
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [still, shown]);
  if (shown.from === "builtin") {
    const b = shown.b;
    return (
      <div className={`bd-fill bd-b-${b.id}`} data-still={still || undefined} style={style} aria-hidden>
        {b.moves && (
          <>
            <i />
            <i />
            <i />
          </>
        )}
      </div>
    );
  }
  const b = shown.b;
  if (b.kind === "image") return <img className="bd-fill bd-media" src={fileUrl(b)} alt="" draggable={false} decoding="async" style={style} onLoad={onReady} onError={onReady} />;
  if (b.kind === "video")
    return (
      <video
        ref={video}
        className="bd-fill bd-media"
        src={fileUrl(b) + (thumb ? "#t=0.5" : "")}
        muted
        loop
        playsInline
        disablePictureInPicture
        preload={thumb ? "metadata" : "auto"}
        autoPlay={!still && !thumb}
        aria-hidden
        tabIndex={-1}
        style={style}
        onLoadedData={onReady}
        onError={onReady}
      />
    );
  return (
    <iframe
      className={thumb ? "bd-frame bd-frame-thumb" : "bd-fill bd-frame"}
      src={fileUrl(b, b.file, !!(still || thumb))}
      sandbox="allow-scripts"
      allow=""
      referrerPolicy="no-referrer"
      tabIndex={-1}
      aria-hidden
      title=""
      style={style}
      onLoad={onReady}
    />
  );
}

/** Kept so the next launch starts in the backdrop's light or dark, before the layer has loaded (local-main.tsx). */
export const TONE_KEY = "friday.backdrop.tone";
const measured = new Map<string, "light" | "dark">();
/**
 * Whether a backdrop is light or dark: what its backdrop.json says, else, for a picture, measured from its own pixels; a page or a
 * video that says nothing is taken as dark, as most are. Undefined while a picture is still being measured.
 */
export function useTone(s: Shown | null): "light" | "dark" | undefined {
  const said = s?.b.tone;
  const url = s && s.from === "folder" && s.b.kind === "image" && !said ? fileUrl(s.b) : "";
  const [, bump] = useState(0);
  useEffect(() => {
    if (!url || measured.has(url)) return;
    const img = new Image();
    const done = (t: "light" | "dark") => (measured.set(url, t), bump((n) => n + 1));
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = c.height = 16;
        const x = c.getContext("2d")!;
        x.drawImage(img, 0, 0, 16, 16);
        const d = x.getImageData(0, 0, 16, 16).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
        done(sum / (d.length / 4) / 255 > 0.55 ? "light" : "dark");
      } catch {
        done("dark");
      }
    };
    img.onerror = () => done("dark");
    img.src = url;
  }, [url]);
  if (!s) return undefined;
  return said ?? (url ? measured.get(url) : "dark");
}

/** Your own light or dark back on the page: a backdrop's put away (none, or Code). */
function ownTheme(): void {
  const c = themeChoice();
  const dark = c === "system" ? !matchMedia("(prefers-color-scheme: light)").matches : c === "dark";
  document.documentElement.classList.toggle("dark", dark);
  const custom = readTheme();
  if (custom) applyTheme(custom, false);
  tellDesktopTheme();
}

/** The layer itself: the backdrop picked, crossfaded from the one before once it is ready, under the dim. */
function BackdropLayer() {
  const pick = usePick();
  const v = useBackdrops();
  const [mode] = useMode();
  const calm = useCalm();
  // A page backdrop is as big as the screen, whatever size the window is, centred: resizing the window shows more or less of it and
  // never lays it out or repaints it again, which made it flicker as the window was dragged (Arun, 2026-11-20). Only moving to a
  // screen of another size does.
  const [screenSize, setScreenSize] = useState(() => ({ "--bd-sw": `${screen.width}px`, "--bd-sh": `${screen.height}px` }) as CSSProperties);
  useEffect(() => {
    let last = `${screen.width}x${screen.height}`;
    const on = () => {
      const now = `${screen.width}x${screen.height}`;
      if (now === last) return;
      last = now;
      setScreenSize({ "--bd-sw": `${screen.width}px`, "--bd-sh": `${screen.height}px` } as CSSProperties);
    };
    addEventListener("resize", on);
    return () => removeEventListener("resize", on);
  }, []);
  const want = mode === "code" ? null : shownOf(pick.id, v);
  const [layers, setLayers] = useState<{ key: string; shown: Shown; ready: boolean }[]>([]);
  const wantKey = want ? shownKey(want) : "";
  useEffect(() => {
    setLayers((ls) => {
      if (!want) return [];
      if (ls.at(-1)?.key === wantKey) return ls.map((l) => (l.key === wantKey ? { ...l, shown: want } : l));
      return [...ls.filter((l) => l.ready).slice(-1), { key: wantKey, shown: want, ready: false }];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantKey]);
  // html.backdrop: every surface frosted over it (prefs.ts applyGlass), and the window's own ground left out.
  const on = !!want;
  const tone = useTone(want);
  /** Whether the page is in a backdrop's light or dark, to put your own back when it goes. */
  const held = useRef(false);
  // Ready: it fades in over the one before, which goes once it is covered.
  const ready = (key: string) => {
    setLayers((ls) => ls.map((x) => (x.key === key ? { ...x, ready: true } : x)));
    setTimeout(() => setLayers((ls) => {
      const at = ls.findIndex((x) => x.key === key);
      return at > 0 ? ls.slice(at) : ls;
    }), 500);
  };
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("backdrop", on);
    if (tone) root.dataset.backdropTone = tone;
    else delete root.dataset.backdropTone;
    applyGlass();
    try {
      if (on && tone) localStorage.setItem(TONE_KEY, tone);
      else if (!on) localStorage.removeItem(TONE_KEY);
    } catch {
      // Only a head start at the next launch.
    }
    if (!on && held.current) {
      held.current = false;
      ownTheme();
    }
    if (!on || !tone) return;
    held.current = true;
    // Light or dark as the backdrop is, whatever the theme says, and kept so: a theme switch (storage.ts setTheme) changes the
    // class and takes the frosted surfaces off, and both go back at once.
    const dark = tone === "dark";
    const hold = () => {
      if (root.classList.contains("dark") !== dark) root.classList.toggle("dark", dark);
      if (!root.classList.contains("glass")) applyGlass();
    };
    hold();
    tellDesktopTheme(dark ? "dark" : "light");
    const mo = new MutationObserver(hold);
    mo.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, [on, tone]);
  // And shown whole as it can be at any window size (Arun, 2026-11-20: "make sure majority of the backdrop can be seen with any window
  // size"): scaled down to cover the window, as a picture is, by the compositor alone, so it is still never laid out again.
  const layerEl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = layerEl.current;
    if (!el) return;
    const fit = () => {
      const f = el.querySelector<HTMLElement>(".bd-fill.bd-frame");
      if (!f || !f.offsetWidth || !f.offsetHeight) return;
      el.style.setProperty("--bd-scale", String(Math.max(el.clientWidth / f.offsetWidth, el.clientHeight / f.offsetHeight)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [layers.length, screenSize]);
  if (!layers.length) return null;
  const still = calm || !pick.motion;
  // Blur on the slot, not the picture, so a page keeps its own size (below) and is never laid out again for it.
  const media: CSSProperties = pick.blur ? { filter: `blur(${pick.blur}px)`, transform: "scale(1.06)" } : {};
  return (
    <div className="bd-layer" aria-hidden style={screenSize} ref={layerEl}>
      {layers.map((l, i) => (
        <div key={l.key} className="bd-slot" data-ready={l.ready || undefined} data-last={i === layers.length - 1 || undefined} style={media}>
          <BackdropView
            shown={l.shown}
            still={still}
            onReady={() => ready(l.key)}
          />
        </div>
      ))}
      <div className="bd-scrim" style={{ opacity: pick.dim / 100 }} />
    </div>
  );
}

/** Behind the app, from the first draw: its own root, first in the page's body, read and kept current from then on. */
export function mountBackdrop(): void {
  if (typeof document === "undefined" || document.getElementById("friday-backdrop")) return;
  const host = document.createElement("div");
  host.id = "friday-backdrop";
  document.body.prepend(host);
  startBackdrops();
  createRoot(host).render(<BackdropLayer />);
}
