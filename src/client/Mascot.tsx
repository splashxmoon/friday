import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";

/**
 * Friday's mascot: a soft round character with a sprout on top, whose face says what is going on.
 *
 * Drawn as an SVG of a few shapes, so it is sharp at any size and costs nothing to load. Its face is two pill eyes, and nearly
 * all of its feeling is in them: how open they are, how they lean, where they look. A mood sets those; the eyes ease from one
 * to the next on a strong ease-out, it blinks now and then, and breathes. All motion stops for anyone who asked for less.
 */
export type MascotMood =
  /** Nothing going on: looks about, blinks. */
  | "idle"
  /** You are writing to it: eyes a little wider, looking at what you write. */
  | "listening"
  /** Working something out: looks up and to the side. */
  | "thinking"
  /** At work: eyes narrowed, looking down at it, a little bob. */
  | "working"
  /** Waiting on you: wide eyes, head on one side, a small "o". */
  | "asking"
  /** Done, and it went well: smiling eyes and cheeks. */
  | "happy"
  /** Something went wrong: eyes lean down and away. */
  | "worried"
  /** Left alone a while: eyes nearly shut. */
  | "sleepy"
  /** Poked: eyes wide open. */
  | "surprised";

/** One eye as a mood draws it: stretch across and up, a lean in degrees, and a nudge down. */
type Eye = { sx: number; sy: number; rot: number; dy: number };
type Face = { l: Eye; r: Eye; look?: [number, number]; smile?: boolean; cheeks?: boolean; o?: boolean; tilt?: number };

const E = (sx = 1, sy = 1, rot = 0, dy = 0): Eye => ({ sx, sy, rot, dy });
const FACES: Record<MascotMood, Face> = {
  idle: { l: E(), r: E() },
  listening: { l: E(1.08, 1.16), r: E(1.08, 1.16), look: [0, 0.8], tilt: 3 },
  thinking: { l: E(1, 0.62, 0, 1.5), r: E(1, 1.02), look: [0.75, -0.8], tilt: 5 },
  working: { l: E(1.05, 0.7, 0, 1.5), r: E(1.05, 0.7, 0, 1.5), look: [0, 0.6] },
  asking: { l: E(1.12, 1.18), r: E(1.12, 1.18), o: true, tilt: -8 },
  happy: { l: E(), r: E(), smile: true, cheeks: true },
  worried: { l: E(0.95, 0.85, -16, 1.5), r: E(0.95, 0.85, 16, 1.5), look: [0, 0.35] },
  sleepy: { l: E(1.1, 0.14, 0, 4), r: E(1.1, 0.14, 0, 4), look: [0, 0.3] },
  surprised: { l: E(1.22, 1.28), r: E(1.22, 1.28), o: true },
};

/**
 * What it looks like. The face (eyes, cheeks, mouth) is the same on every one, in the same place, so every mood works on
 * every body; only the shape around it and its colours differ (the colours are in the stylesheet, by `data-kind`).
 */
export type MascotKind = "bot" | "ghost" | "cat" | "sprout";

/** Things that sway are given `m-sway` and the point they hang from. */
const sway = (x: number, y: number): CSSProperties => ({ transformOrigin: `${x}px ${y}px` });

const BODIES: Record<MascotKind, ReactElement> = {
  // A little robot: a rounded head with a dark visor its eyes glow on, ear bolts, and an antenna with a light.
  bot: (
    <>
      <g className="m-sway" style={sway(50, 20)}>
        <path className="m-line" d="M50 21 V10" />
        <circle className="m-accent" cx="50" cy="8" r="5" />
      </g>
      <rect className="m-head" x="5" y="38" width="10" height="20" rx="5" />
      <rect className="m-head" x="85" y="38" width="10" height="20" rx="5" />
      <rect className="m-head" x="11" y="20" width="78" height="70" rx="26" />
      <rect className="m-visor" x="19" y="30" width="62" height="44" rx="18" />
      <ellipse className="m-shine" cx="30" cy="25" rx="9" ry="3" />
    </>
  ),
  // A ghost: a dome with a wavy hem, floating.
  ghost: (
    <>
      <path
        className="m-head"
        d="M12 58 C12 30 29 12 50 12 C71 12 88 30 88 58 V84 Q82 94 75 86 Q69 79 63 86 Q56.5 94 50 86 Q43.5 79 37 86 Q31 94 25 86 Q18 79 12 86 Z"
      />
      <ellipse className="m-shine" cx="33" cy="30" rx="11" ry="6" transform="rotate(-30 33 30)" />
    </>
  ),
  // A cat: a round face with two ears, pink inside, and whiskers.
  cat: (
    <>
      <g className="m-sway" style={sway(26, 34)}>
        <path className="m-head" d="M13 44 L19 9 Q21 4 26 7 L46 24 Z" />
        <path className="m-inner" d="M20 36 L23 15 L37 27 Z" />
      </g>
      <g className="m-sway" style={sway(74, 34)}>
        <path className="m-head" d="M87 44 L81 9 Q79 4 74 7 L54 24 Z" />
        <path className="m-inner" d="M80 36 L77 15 L63 27 Z" />
      </g>
      <ellipse className="m-head" cx="50" cy="57" rx="41" ry="35" />
      <ellipse className="m-shine" cx="34" cy="38" rx="11" ry="6" transform="rotate(-24 34 38)" />
      <path className="m-line thin" d="M4 58 L17 61 M5 67 L17 65 M96 58 L83 61 M95 67 L83 65" />
    </>
  ),
  // The first one: a round with a sprout.
  sprout: (
    <>
      <path className="m-line leaf m-sway" style={sway(50, 20)} d="M50 20 C50 14 52 10 55 7" />
      <path className="m-accent m-sway" style={sway(50, 20)} d="M55 7 C58 1 67 1 70 4 C66 10 59 11 55 7 Z" />
      <ellipse className="m-head" cx="50" cy="56" rx="40" ry="37" />
      <ellipse className="m-shine" cx="36" cy="38" rx="13" ry="8" transform="rotate(-24 36 38)" />
    </>
  ),
};

const still = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Where the pointer is, as -1..1 either way from the mascot's middle: full at a few of its widths away, so it follows you across the page. */
function useGaze(el: React.RefObject<SVGSVGElement | null>, on: boolean): [number, number] | null {
  const [at, setAt] = useState<[number, number] | null>(null);
  useEffect(() => {
    if (!on || still()) return;
    let frame = 0;
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.current?.getBoundingClientRect();
        if (!r?.width) return;
        const reach = r.width * 4;
        const clamp = (v: number) => Math.max(-1, Math.min(1, v / reach));
        setAt([clamp(e.clientX - (r.left + r.width / 2)), clamp(e.clientY - (r.top + r.height / 2))]);
      });
    };
    const leave = () => setAt(null);
    window.addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", leave);
    };
  }, [el, on]);
  return at;
}

/** A blink every few seconds, never on the beat, so it reads as alive rather than as a timer. */
function useBlink(on: boolean): boolean {
  const [shut, setShut] = useState(false);
  useEffect(() => {
    if (!on || still()) return;
    let t = 0;
    const next = () => {
      t = window.setTimeout(() => {
        setShut(true);
        t = window.setTimeout(() => {
          setShut(false);
          next();
        }, 120);
      }, 2400 + Math.random() * 3600);
    };
    next();
    return () => clearTimeout(t);
  }, [on]);
  return shut;
}

export function Mascot({
  kind = "sprout",
  mood = "idle",
  size = 32,
  follow = false,
  still: frozen = false,
  label,
  className,
  onPoke,
}: {
  kind?: MascotKind;
  mood?: MascotMood;
  size?: number;
  /** Its eyes follow the pointer while its mood doesn't say where to look. */
  follow?: boolean;
  /** Drawn in its mood but not moving: for the many small copies down a conversation. */
  still?: boolean;
  /** Said to a screen reader; without it the mascot is decoration. */
  label?: string;
  className?: string;
  /** Pressed: it is a button then. */
  onPoke?: () => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const face = FACES[mood];
  const gaze = useGaze(svg, follow && !frozen);
  const blink = useBlink(!frozen && mood !== "sleepy" && !face.smile);
  const [lx, ly] = face.look ?? gaze ?? [0, 0];
  const eye = (e: Eye, x: number): CSSProperties => ({ transform: `translate(${x}px, ${48 + e.dy}px) rotate(${e.rot}deg) scale(${e.sx}, ${e.sy})` });
  const drawing = (
    <svg
      ref={svg}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={`mascot${frozen ? " still" : ""}${className ? ` ${className}` : ""}`}
      data-mood={mood}
      data-kind={kind}
      {...(label && !onPoke ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <g className="m-all" style={{ transform: `rotate(${face.tilt ?? 0}deg)` }}>
        <g className="m-body">{BODIES[kind]}</g>
        <g className="m-face" style={{ transform: `translate(${lx * 9}px, ${ly * 7}px)` }}>
          <ellipse className="m-cheek" cx="27" cy="64" rx="6.5" ry="3.8" style={{ opacity: face.cheeks ? 1 : 0 }} />
          <ellipse className="m-cheek" cx="73" cy="64" rx="6.5" ry="3.8" style={{ opacity: face.cheeks ? 1 : 0 }} />
          <g className={`m-eyes${blink ? " shut" : ""}`} style={{ opacity: face.smile ? 0 : 1 }}>
            <rect className="m-eye" x="-4.75" y="-9" width="9.5" height="18" rx="4.75" style={eye(face.l, 38)} />
            <rect className="m-eye" x="-4.75" y="-9" width="9.5" height="18" rx="4.75" style={eye(face.r, 62)} />
          </g>
          {/* Smiling eyes are their own shapes, crossfaded in: a pill can't bend into an arc. */}
          <g className="m-smile" style={{ opacity: face.smile ? 1 : 0 }}>
            <path d="M31.5 50 Q38 42 44.5 50" />
            <path d="M55.5 50 Q62 42 68.5 50" />
          </g>
          <ellipse className="m-o" cx="50" cy="66" rx="3" ry="3.6" style={{ opacity: face.o ? 1 : 0 }} />
        </g>
      </g>
    </svg>
  );
  if (!onPoke) return drawing;
  return (
    <button type="button" className="mascot-poke" aria-label={label ?? "Friday"} onClick={onPoke}>
      {drawing}
    </button>
  );
}

/** Whether nobody has moved the pointer, typed or scrolled for `ms`: the mascot dozes off, and wakes at the first touch. */
export function useAway(ms: number): boolean {
  const [away, setAway] = useState(false);
  useEffect(() => {
    let t = window.setTimeout(() => setAway(true), ms);
    const back = () => {
      clearTimeout(t);
      setAway(false);
      t = window.setTimeout(() => setAway(true), ms);
    };
    const kinds = ["pointermove", "keydown", "wheel", "pointerdown"] as const;
    kinds.forEach((k) => window.addEventListener(k, back, { passive: true }));
    return () => {
      clearTimeout(t);
      kinds.forEach((k) => window.removeEventListener(k, back));
    };
  }, [ms]);
  return away;
}

/** A poke: surprised for a moment, then pleased, then back to whatever it was. */
export function usePoke(): [MascotMood | null, () => void] {
  const [mood, setMood] = useState<MascotMood | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const poke = () => {
    timers.current.forEach(clearTimeout);
    setMood("surprised");
    timers.current = [window.setTimeout(() => setMood("happy"), 380), window.setTimeout(() => setMood(null), 1500)];
  };
  return [mood, poke];
}

/**
 * The mascot's mood for a run in a conversation: at work while it runs, asking while it waits on someone, worried when it
 * stopped on an error or left a command failing, pleased when it finished cleanly.
 */
export function runMood(r: { active: boolean; outcome?: string; failing?: number }): MascotMood {
  if (r.active) return "working";
  if (r.outcome === "waiting") return "asking";
  if (r.outcome === "error" || (r.failing ?? 0) > 0) return "worried";
  if (r.outcome === "done") return "happy";
  return "idle";
}
