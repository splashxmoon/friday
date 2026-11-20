"use strict";
// The coding tool's remaining window in the IDE's status bar (Arun, 2026-11-20, wave 5: "the IDE status bar shows the current tool's
// remaining window only when it's under 20%"). The pure parts, tested on their own (test/ide-usage-ext.test.ts): which of Friday's tasks is the window's,
// and what the status item says.

/** Under this share of its fullest window left, the status bar says so; with more left it says nothing. */
const LOW = 20;

/** Folder names the way a path compares on this computer's file systems: slashes alike, no trailing slash, drive letters any case. */
function same(a, b) {
  const n = (p) => {
    const r = String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
    return /^[a-zA-Z]:/.test(r) ? r.toLowerCase() : r;
  };
  return !!a && !!b && n(a) === n(b);
}

/**
 * The task whose tool this window is working with: of the tasks in one of its folders, the one running, else the newest. A task
 * with no word about its plan (no window read yet) is passed over for one that has one.
 */
function currentTask(tasks, roots) {
  const mine = (Array.isArray(tasks) ? tasks : []).filter((t) => t && roots.some((r) => same(r, t.folder)));
  const rank = (t) => (t.plan ? 4 : 0) + (t.status === "running" ? 2 : 0);
  return mine.sort((a, b) => rank(b) - rank(a) || (b.at || 0) - (a.at || 0))[0] || null;
}

/** The status item's text and tip for a task; null when there is nothing to say (plenty left, or no reading). */
function usageItem(task) {
  const p = task && task.plan;
  if (!p || typeof p.left !== "number" || !isFinite(p.left) || p.left >= LOW) return null;
  const left = Math.max(0, Math.round(p.left));
  const name = String(p.name || "The tool");
  return {
    text: `$(warning) ${name} ${left}% left`,
    tooltip: left === 0 ? `${name} is out of its ${p.window || "limit"}.` : `${name} has ${left}% of its ${p.window || "limit"} left. Friday offers to hand the work on to another tool before it runs out.`,
    // A tool about to run out reads as a warning; one already out as an error.
    error: left <= 5,
  };
}

module.exports = { LOW, same, currentTask, usageItem };
