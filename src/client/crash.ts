import { useEffect, useState } from "react";

/**
 * When the app itself can't be drawn: what went wrong, said plainly, with Reload, instead of a blank window (Arun, 2026-11-01:
 * "production screen app is blank after reloading for update"). React leaves the root empty after an error nothing caught;
 * this draws into it with the DOM alone, so it shows even when the app's own components are what failed. The error's own
 * words and the first lines of its stack, so a screenshot of it says where.
 *
 * Go home beside Reload (spec 13; Arun, 2026-11-24: "Go all out and fix these problems"): Reload opens the same page, and a
 * page that can't be drawn (a session whose log breaks it) failed again the moment it came back. Home is the page without
 * the session in its address. Failing again within seconds of a Reload is a loop, said so, with Go home first.
 */
export function showCrash(error: unknown): void {
  // After React has taken its tree down: drawn before, it was cleared with the rest.
  setTimeout(() => draw(error), 0);
}

/** Set as Reload is pressed, so the page it opens knows it came from this screen. */
const RELOADED = "friday.crash.reloaded";
/** Failing again this soon after a Reload from this screen is a loop. */
const LOOP_MS = 10_000;

function store(): Storage | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

/** Whether this page was opened by the crash screen's Reload (or the window's own) and failed within seconds of opening. */
export function crashLoop(o: { sinceLoad: number; reloadedAt: number | null; reloadNav: boolean; now: number }): boolean {
  if (o.sinceLoad > LOOP_MS) return false;
  if (o.reloadedAt !== null) return o.now - o.reloadedAt < LOOP_MS + 5_000;
  return o.reloadNav;
}

function looping(): boolean {
  const s = store();
  const raw = s?.getItem(RELOADED);
  const at = raw ? Number(raw) : null;
  let nav = false;
  try {
    nav = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type === "reload";
  } catch {}
  return crashLoop({ sinceLoad: performance.now(), reloadedAt: Number.isFinite(at) ? at : null, reloadNav: nav, now: Date.now() });
}

/** The app's home: its address without a session, a view or anything else after it (App.tsx routeUrl). */
export const homeUrl = (origin: string): string => `${origin}/`;

function draw(error: unknown): void {
  const root = document.getElementById("root");
  if (!root) return;
  const e = error instanceof Error ? error : new Error(String(error));
  const loop = looping();
  const box = document.createElement("div");
  box.setAttribute("role", "alert");
  box.className = "crash-screen";
  box.style.cssText = "box-sizing:border-box;max-width:560px;margin:15vh auto 0;padding:0 16px;font:14px/1.5 var(--font, system-ui);color:var(--ink, #ededed)";
  const title = document.createElement("div");
  title.textContent = loop ? "Friday couldn't draw this screen again" : "Friday couldn't draw this screen";
  title.style.cssText = "font-size:17px;font-weight:600;margin-bottom:8px;text-wrap:balance";
  const what = document.createElement("div");
  what.textContent = loop ? "It stopped again right after reloading. Go home to start from a clean page; your sessions are safe." : e.message || "Something went wrong.";
  what.style.cssText = "color:var(--ink-2, #b5b5b5);margin-bottom:12px;overflow-wrap:anywhere";
  const stack = document.createElement("pre");
  // The stack's first line is the message, in Chromium; said once, above it, only where it isn't.
  const lines = (e.stack ?? "").split("\n").slice(0, 6);
  stack.textContent = [loop && !lines[0]?.includes(e.message) ? e.message : "", ...lines].filter(Boolean).join("\n");
  stack.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;font:11.5px/1.45 var(--mono, ui-monospace, monospace);color:var(--text-muted, #929292);background:rgb(127 127 127 / .08);border-radius:8px;padding:10px 12px;margin:0 0 16px;max-height:40vh;overflow:auto";
  const row = document.createElement("div");
  row.style.cssText = "display:flex;flex-wrap:wrap;gap:8px";
  const button = (label: string, primary: boolean, act: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText = `height:32px;padding:0 14px;border-radius:999px;font:inherit;font-size:13px;font-weight:500;cursor:pointer;border:1px solid ${primary ? "transparent" : "var(--border-strong, rgb(127 127 127 / .35))"};background:${primary ? "var(--ink, #ededed)" : "transparent"};color:${primary ? "var(--bg, #191919)" : "var(--ink, #ededed)"}`;
    b.onclick = act;
    return b;
  };
  const reload = () => {
    store()?.setItem(RELOADED, String(Date.now()));
    location.reload();
  };
  const home = () => {
    store()?.removeItem(RELOADED);
    location.assign(homeUrl(location.origin));
  };
  const copy = () => void navigator.clipboard?.writeText(`${e.message}\n${e.stack ?? ""}`).catch(() => {});
  row.append(
    ...(loop
      ? [button("Go home", true, home), button("Reload", false, reload)]
      : [button("Reload", true, reload), button("Go home", false, home)]),
    button("Copy the error", false, copy),
  );
  box.append(title, what, stack, row);
  root.replaceChildren(box);
}

/** What a page the e2e suite marked (`window.__fridayE2E`) can be asked to do: fail at its root, to show this screen. */
type E2EWindow = Window & { __fridayE2E?: boolean; __fridayE2ECrash?: () => void };

/**
 * Nothing at all, except on a page the e2e suite marked before it loaded (e2e/local-guard.spec.ts): there, `__fridayE2ECrash()`
 * makes the root fail as a real crash would, so the crash screen can be checked. No production page is ever marked.
 */
export function CrashForTests() {
  const [boom, setBoom] = useState<Error | null>(null);
  useEffect(() => {
    const w = window as E2EWindow;
    if (w.__fridayE2E === true) w.__fridayE2ECrash = () => setBoom(new Error("The e2e suite asked the page to fail"));
  }, []);
  if (boom) throw boom;
  return null;
}
