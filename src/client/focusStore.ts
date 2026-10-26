import { createContext, useContext } from "react";
import type { Focus } from "../focus.js";

/**
 * Where the others in the room are looking, and a way to say where you are.
 *
 * A context, so a diff row or the tree can mark who is on it and report where the pointer is without the session view
 * threading it through every card between them.
 */
export interface FocusValue {
  /** Everyone else who is here, with where they are. */
  others: Record<string, { name: string; at: Focus }>;
  /** This person's file and line, as the diff or the tree sees it. Pass nothing for "no file": that clears only `from`'s own. */
  here: (p: Here, from: HereFrom) => void;
}

export type Here = { path?: string; line?: number };
export type HereFrom = "tree" | "diff";
/** Each source's file, newest last; a source with no file has no slot. */
export type HereSlots = [HereFrom, Here][];

/** One source says where it is, or (no path) that it is nowhere, leaving the other source's slot alone. */
export const setHere = (slots: HereSlots, from: HereFrom, p: Here): HereSlots => [...slots.filter(([f]) => f !== from), ...(p.path ? [[from, p] as [HereFrom, Here]] : [])];
/** What the room sees: the newest file still said, else nothing. */
export const hereOf = (slots: HereSlots): Here => slots.at(-1)?.[1] ?? {};

/** The page's `here`: keeps each source's slot, and tells `say` what the room sees whenever that changes. */
export function herePublisher(say: (p: Here) => void): FocusValue["here"] {
  let slots: HereSlots = [];
  let said: Here = {};
  return (p, from) => {
    slots = setHere(slots, from, p);
    const now = hereOf(slots);
    if (now.path === said.path && now.line === said.line) return;
    said = now;
    say(now);
  };
}

/** A diff of `path` as the room hears it: a row's line while the pointer is on it, and nothing from the diff once it leaves or the diff goes. */
export const diffHere = (here: FocusValue["here"], path: string) => ({
  row: (line: number) => ({ onMouseEnter: () => here({ path, line }, "diff"), onMouseLeave: () => here({}, "diff") }),
  gone: () => here({}, "diff"),
});

export const FocusContext = createContext<FocusValue>({ others: {}, here: () => {} });
export const useFocus = () => useContext(FocusContext);
