import { useEffect, useRef } from "react";

/**
 * "Do this when you get there": the palette's way to start a page's own flow (New skill, Invite by email) from anywhere.
 * The intent waits until the page that handles it is showing, then is used once; a page already open gets it at once.
 */
export type PageIntent = "new-skill" | "invite" | "settings-search" | "settings-section";

let pending: PageIntent | null = null;

export function askPage(intent: PageIntent): void {
  pending = intent;
  dispatchEvent(new CustomEvent("friday:intent", { detail: intent }));
}

/** Takes the intent if it is this one: true once, then it's gone. */
export function takeIntent(intent: PageIntent): boolean {
  if (pending !== intent) return false;
  pending = null;
  return true;
}

export function useIntent(intent: PageIntent, run: () => void): void {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    if (takeIntent(intent)) latest.current();
    const on = () => takeIntent(intent) && latest.current();
    addEventListener("friday:intent", on);
    return () => removeEventListener("friday:intent", on);
  }, [intent]);
}
