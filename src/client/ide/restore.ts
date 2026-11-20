import { useEffect, useSyncExternalStore, type RefObject } from "react";
import { releaseRestoredRoot, restoredIdeRoot, setIdeRoot } from "./mode.js";
import { hostApi } from "../local.js";
import type { Identity } from "../storage.js";
import { isFolderMissing, type IdeListParams, type IdeListResult } from "../../ide-contract.js";

/**
 * Session restore (Arun, 2026-11-19, wave 4: "quit Friday mid-work and come back exactly where you were: the folder, open files and
 * layout, the chat tabs, scroll positions, and agents that were running"). What comes back, and from where:
 *   - the folder: mode.ts keeps the last one in localStorage; checked here that it is still there;
 *   - the IDE's open files and layout: the IDE's own, kept per folder in its page's storage, which only survives a launch because
 *     the runner keeps its port (runner/vscode.ts stablePort);
 *   - the column's width and open state: VsCodeView's CHAT_KEY; the chat tabs and the one shown: code-chats.ts;
 *   - the chat's scroll position: here;
 *   - a tool cut off by closing: ide-restore.ts says so, RestoreBar.tsx offers to carry on.
 */

/** Where each chat was scrolled to: its first row on screen (by its seq, and how far down from the top it was), else plain pixels. */
interface Place {
  seq?: number;
  off?: number;
  top: number;
}
const KEY = "friday.code.scroll";
const KEEP = 60;
let places: Record<string, Place> | null = null;

function load(): Record<string, Place> {
  if (places) return places;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, Place>;
    places = raw && typeof raw === "object" ? raw : {};
  } catch {
    places = {};
  }
  return places;
}
function save() {
  const all = load();
  const ids = Object.keys(all);
  // The oldest go (insertion order), so the list doesn't grow with every chat ever opened.
  for (const id of ids.slice(0, Math.max(0, ids.length - KEEP))) delete all[id];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage blocked: positions last until the window closes.
  }
}
/** Where a chat was left, or nothing when it was at its end (the feed follows the end by itself). */
export const placeOf = (sid: string): Place | null => load()[sid] ?? null;
export function rememberPlace(sid: string, place: Place | null): void {
  const all = load();
  delete all[sid];
  if (place) all[sid] = place;
  save();
}

/** The feed row at the top of a scroll box and how far below its edge it starts. */
export function readPlace(el: HTMLElement): Place | null {
  // At the end (within a few pixels): nothing to put back, the feed opens there.
  if (el.scrollHeight - el.clientHeight - el.scrollTop <= 24) return null;
  const edge = el.getBoundingClientRect().top;
  for (const row of el.querySelectorAll<HTMLElement>("[data-seq]")) {
    const r = row.getBoundingClientRect();
    if (r.bottom > edge + 2) return { seq: Number(row.dataset.seq), off: Math.round(r.top - edge), top: Math.round(el.scrollTop) };
  }
  return { top: Math.round(el.scrollTop) };
}

/** Moves a scroll box to a place; false when its row isn't drawn yet. */
export function putPlace(el: HTMLElement, p: Place): boolean {
  if (p.seq !== undefined) {
    const row = el.querySelector<HTMLElement>(`[data-seq="${p.seq}"]`);
    if (row) {
      el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - (p.off ?? 0);
      return true;
    }
  }
  if (el.scrollHeight - el.clientHeight < p.top) return false;
  el.scrollTop = p.top;
  return true;
}

/**
 * Remembers where the chat in `box` is scrolled to, per session, and puts it back when that chat is drawn again (a reload, a
 * launch, a tab shown again). The feed opens at its end and follows it for a moment while it draws (conversation.tsx), so the
 * place is put back again as it grows, until it holds for a while, the person scrolls, or three seconds pass.
 */
export function useChatScroll(box: RefObject<HTMLElement | null>, sid: string | undefined): void {
  useEffect(() => {
    if (!sid) return;
    let stop = false;
    let el: HTMLElement | null = null;
    let restoring = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    // Where it was left by the person's last scroll, read as it happened: when the chat is swapped for another the feed's box is
    // already out of the page by the time this cleans up, and reading it then saw nothing and wiped the place (review, 2026-11-19).
    let latest: Place | null | undefined;
    const want = placeOf(sid);
    const write = () => {
      if (latest !== undefined) rememberPlace(sid, latest);
    };
    const mine = () => (restoring = false);
    const adopt = (found: HTMLElement) => {
      if (found === el) return;
      el = found;
      // The person's own hands on it end the putting back.
      for (const ev of ["wheel", "pointerdown", "touchmove", "keydown"]) el.addEventListener(ev, mine, { passive: true });
    };
    // Any scroll box of the feed inside this column counts, whenever it was drawn: a slow session, or the feed remounted.
    const onScroll = (e: Event) => {
      const t = e.target;
      if (restoring || !(t instanceof HTMLElement) || !t.matches("[data-scroll-root]")) return;
      adopt(t);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (el?.isConnected) latest = readPlace(el);
      });
      clearTimeout(timer);
      timer = setTimeout(write, 200);
    };
    const flush = () => {
      clearTimeout(timer);
      write();
    };
    const hide = () => document.visibilityState === "hidden" && flush();
    let tries = 0;
    let held = 0;
    const look = () => {
      if (stop) return;
      const found = box.current?.querySelector<HTMLElement>("[data-scroll-root]") ?? null;
      if (found) adopt(found);
      if (el && restoring && want) {
        // Held when it reads as it was put and stayed so a few ticks: the feed has stopped drawing and pulling to its end.
        const before = el.scrollTop;
        const ok = putPlace(el, want);
        held = ok && Math.abs(el.scrollTop - before) < 2 ? held + 1 : 0;
        if (held >= 6) restoring = false;
      } else if (el && !want) restoring = false;
      if (++tries > 30 && restoring) restoring = false;
      if (restoring || !el) {
        if (tries < 60) setTimeout(look, 100);
      }
    };
    look();
    const host = box.current;
    host?.addEventListener("scroll", onScroll, { capture: true, passive: true });
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", flush);
    return () => {
      stop = true;
      flush();
      cancelAnimationFrame(frame);
      host?.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
      if (el) for (const ev of ["wheel", "pointerdown", "touchmove", "keydown"]) el.removeEventListener(ev, mine);
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", flush);
    };
  }, [box, sid]);
}

/** A folder the last launch had open that is not there any more: said once on Code's start screen, then forgotten. */
let missed: string | null = null;
const missedListeners = new Set<() => void>();
const setMissed = (f: string | null) => ((missed = f), missedListeners.forEach((l) => l()));
export const useMissedFolder = (): string | null => useSyncExternalStore((l) => (missedListeners.add(l), () => void missedListeners.delete(l)), () => missed, () => null);
export const dismissMissedFolder = (): void => setMissed(null);

/**
 * The folder Code opened on from the last launch must still be there: a folder deleted, renamed or on a drive that isn't plugged in
 * would give the IDE a window with nothing in it. The folder is held back (mode.ts: as if none was open) until this answers, for two
 * seconds at most, so the IDE isn't started on a missing one; if it is gone, Code opens on its start screen, and says which folder.
 */
export function checkRestoredRoot(identity: Identity): () => void {
  const root = restoredIdeRoot();
  let live = true;
  if (!root) return () => {};
  void (async () => {
    // The runner may still be starting at launch: asked again for a few seconds before giving up. Only a folder that answers
    // "not there" is dropped; a runner that isn't answering says nothing about it.
    for (let i = 0; i < 10 && live; i++) {
      try {
        await hostApi<IdeListResult>(identity, "/api/runner/ide.list", { method: "POST", body: JSON.stringify({ root, dir: "" } satisfies IdeListParams) });
        releaseRestoredRoot();
        return;
      } catch (e) {
        if (isFolderMissing(String((e as Error)?.message))) {
          if (live && restoredIdeRoot() === root) (setMissed(root), setIdeRoot(null));
          releaseRestoredRoot();
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  })();
  return () => void (live = false);
}
