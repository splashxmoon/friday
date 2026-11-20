"use strict";
/**
 * Friday's notices inside the IDE wait while you type (Arun, 2026-11-19, wave 4: "while you're typing in the editor, Friday holds its
 * pings; they arrive as a quiet summary when you pause"). The page holds its own pings (src/client/ide/quiet.ts); this holds the
 * one that pops over the editor itself, "an agent changed N files". Plain CommonJS, the clock and timers passed in so it tests.
 */

const QUIET_MS = 20_000;

/**
 * notes: { sid, text, tool?, title? }. `show(list)` is called once with what was held, after quietMs without a keystroke.
 * `on()` says whether the setting (friday.quietWhileTyping) is on.
 */
function createQuietNotes({ show, on = () => true, quietMs = QUIET_MS, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let last = -Infinity;
  let queue = [];
  let timer = null;
  const typing = () => on() && now() - last < quietMs;
  const arm = () => {
    if (timer !== null) clearTimer(timer);
    // A little past the end of the pause, so the clock has really crossed it.
    timer = setTimer(() => {
      timer = null;
      flush();
    }, Math.max(0, last + quietMs - now()) + 50);
    if (timer && typeof timer.unref === "function") timer.unref();
  };
  const flush = (force) => {
    if (!queue.length) return;
    if (!force && typing()) return arm();
    const list = queue;
    queue = [];
    if (timer !== null) clearTimer(timer);
    timer = null;
    show(list);
  };
  return {
    /** A real edit by the person in the focused editor. */
    typed() {
      last = now();
      if (queue.length) arm();
    },
    typing,
    /** True: held, it comes in the summary. False: the caller says it now. The same chat held twice is one, the newest. */
    hold(note) {
      if (!typing()) return false;
      queue = queue.filter((q) => q.sid !== note.sid);
      queue.push(note);
      arm();
      return true;
    },
    /** The setting turned off: what is held comes now. */
    release() {
      flush(true);
    },
    size: () => queue.length,
    dispose() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

/** One line for what was held: the one notice as it was, or a count for several. */
function summaryText(list) {
  if (list.length === 1) return list[0].text;
  return `✳ While you were typing, agents changed files in ${list.length} chats`;
}

module.exports = { createQuietNotes, summaryText, QUIET_MS };
