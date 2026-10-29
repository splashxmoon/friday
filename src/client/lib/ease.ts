/**
 * One curve for everything that moves, as style.css --ease-out: 120ms hovers, 180ms opening and closing, 240ms layout moves, and
 * nothing that bounces (Arun, 2026-10-29: "so clean and beautiful really with a clear direction in design language"; DIRECTION.md §7).
 */
export const EASE_OUT = [0.2, 0.8, 0.2, 1] as const;
export const EASE_IN_OUT = EASE_OUT;
export const EASE_DRAWER = EASE_OUT;
/** The three timings, in seconds for Framer Motion. */
export const T_HOVER = 0.12;
export const T_OPEN = 0.18;
export const T_MOVE = 0.24;

/** CSS string form of EASE_OUT for inline style transitions. */
export const EASE_OUT_CSS = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/** Press feedback on buttons and other tappable surfaces. */
export const SPRING_PRESS = {
  type: "spring",
  stiffness: 500,
  damping: 35,
  mass: 0.6,
} as const;

/** Content swaps — label/icon slots trading places inside a control. */
export const SPRING_SWAP = {
  type: "spring",
  stiffness: 460,
  damping: 32,
  mass: 0.55,
} as const;

/** Overlay panel entrances — modals and sheets summoned by pointer. */
export const SPRING_PANEL = {
  type: "spring",
  stiffness: 420,
  damping: 40,
  mass: 0.5,
} as const;

/** Shared-layout glides — pills, indicators and panels morphing between positions. */
export const SPRING_LAYOUT = {
  type: "spring",
  stiffness: 360,
  damping: 32,
  mass: 0.6,
} as const;

/** Cursor-follow physics for decorative mouse tracking (magnetic, tilt, dock). */
export const SPRING_MOUSE = {
  stiffness: 200,
  damping: 15,
  mass: 0.3,
} as const;

/** Dragged handles and fills (sliders) — critically damped `useSpring` config,
 * so the value follows the pointer butterily and never rebounds off an end. */
export const SPRING_GLIDE = {
  stiffness: 700,
  damping: 50,
  mass: 0.5,
} as const;
