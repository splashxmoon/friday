import { useEffect, useState, type RefObject } from "react";

/**
 * Whether a row of the chat is near enough to the view to be worth drawing again (Activity's FeedRow).
 *
 * The feed draws again on every live event, every row of it: each row is handed the session as it now is. In a long session
 * that is hundreds of finished turns drawn again, many times a second while agents work, for rows nobody can see (Arun,
 * 2026-10-30: "the app feel laggy when running a lot of tasks and agents"). A row this far from the view keeps what it last
 * drew and draws again as it comes near: well before it is seen, so scrolling never shows it out of date.
 *
 * One watcher for each scroll box (the feed's is marked data-scroll-root), however many rows it watches.
 */
const MARGIN = "1500px 0px";
const watchers = new Map<Element | null, IntersectionObserver>();
const told = new WeakMap<Element, (near: boolean) => void>();

function watcherFor(root: Element | null): IntersectionObserver {
  let w = watchers.get(root);
  if (!w) {
    w = new IntersectionObserver((entries) => {
      for (const e of entries) told.get(e.target)?.(e.isIntersecting);
    }, { root, rootMargin: MARGIN });
    watchers.set(root, w);
  }
  return w;
}

export function useNear(ref: RefObject<HTMLElement | null>): boolean {
  // Where nothing can watch (a test, an old browser), every row is near: drawn every time, as before.
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const root = el.closest("[data-scroll-root]");
    const w = watcherFor(root);
    told.set(el, setNear);
    w.observe(el);
    return () => {
      w.unobserve(el);
      told.delete(el);
      // A scroll box gone with its last row (a session closed) takes its watcher with it.
      if (root && !root.isConnected) {
        w.disconnect();
        watchers.delete(root);
      }
    };
  }, [ref]);
  return near;
}
