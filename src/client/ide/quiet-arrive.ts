import { awayFromApp, notificationsOn } from "../prefs.js";
import { summarize, type Held } from "./quiet-queue.js";

/** The held ones arrive: ONE toast you can press (the one session, or Needs you), or a system notification if you have left the window. */
export function arrive(items: Held[]): void {
  const text = summarize(items);
  if (!text) return;
  const sids = [...new Set(items.map((i) => i.sid))];
  const only = sids.length === 1 ? sids[0]! : null;
  if (awayFromApp()) {
    // Left the window since: the system notification, which holding would otherwise have skipped.
    if (typeof Notification === "undefined" || !notificationsOn() || Notification.permission !== "granted") return;
    try {
      const n = new Notification("While you were typing", { body: text.replace(/^While you were typing: /, ""), tag: "friday:held" });
      n.onclick = () => {
        window.focus();
        n.close();
        window.dispatchEvent(only ? new CustomEvent("friday:open-session", { detail: { sid: only } }) : new Event("friday:open-needs"));
      };
    } catch {
      // A courtesy; a browser that refuses it changes nothing.
    }
    return;
  }
  window.dispatchEvent(new CustomEvent("friday:held", { detail: { title: "While you were typing", what: text.replace(/^While you were typing: /, ""), sid: only } }));
}

