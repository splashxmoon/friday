// The Tasks view lists Code's chats and the Agents sessions working in this folder (Arun, 2026-11-20: "each saying where it lives").
// Plain functions, so the view's words and what it passes on are one place and testable without the IDE.

/** Where a task lives, in a word: Code's own chat, an Agents session, or an Agents session open as a tab in Code. */
function whereLabel(x) {
  if (x && x.where === "agents") return x.linked ? "Agents · open in Code" : "Agents";
  return "Code";
}

/**
 * What a row is, for its context menu: "friday.task.agents" (open it in Agents, or as a tab in Code), "friday.task.linked" (a tab in
 * Code, still Agents' own), "friday.task.code".
 */
function contextOf(x) {
  if (x && x.where === "agents") return x.linked ? "friday.task.linked" : "friday.task.agents";
  return "friday.task.code";
}

/** The codicon each row wears, so where it lives shows even when a long title cuts the description off. */
function iconOf(x) {
  if (x && x.where === "agents") return x.linked ? "link" : "organization";
  return "comment";
}

/** The tasks the rest of the extension marks files for and announces: not an Agents session that only lives in the list. */
function ownTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : []).filter((x) => !(x && x.where === "agents" && !x.linked));
}

/** The session a command was given: a sid, or the tree element a context menu passes (`{ task }`). */
function sidOf(arg) {
  if (typeof arg === "string") return arg;
  if (arg && arg.task && typeof arg.task.sid === "string") return arg.task.sid;
  return "";
}

/** Same folder, ignoring slash style, a trailing slash and a Windows drive letter's case. */
function sameDir(a, b) {
  const k = (v) => {
    const r = String(v || "").replace(/\\/g, "/").replace(/\/+$/, "");
    return /^[a-zA-Z]:/.test(r) ? r.toLowerCase() : r;
  };
  return !!a && !!b && k(a) === k(b);
}

module.exports = { whereLabel, contextOf, iconOf, ownTasks, sidOf, sameDir };
