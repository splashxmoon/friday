import { useEffect } from "react";

/**
 * "Use as context" (TeamLibrary.tsx): a brief of a teammate's session, put into the message box of the session somebody is
 * working in, as a file they see and can take out before sending.
 *
 * The Team page usually isn't on screen with that box: the press goes there, and the box may not be drawn yet. So the brief
 * waits here, per session, until that session's box takes it; a box already drawn is told at once. Kept for this tab only.
 */
export interface Brief {
  title: string;
  text: string;
}

const waiting = new Map<string, Brief[]>();
const EVENT = "friday:context-drop";

/** A file named after the session it came from, which is what the chip in the box shows. */
export function briefFile(b: Brief): File {
  const slug = b.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "session";
  return new File([b.text], `${slug}-brief.md`, { type: "text/markdown" });
}

export function dropContext(sid: string, b: Brief): void {
  waiting.set(sid, [...(waiting.get(sid) ?? []), b]);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { sid } }));
}

/** In a session's message box: takes what waits for this session, now and as it comes. */
export function useContextDrops(sid: string, add: (files: File[]) => void, onAdded?: (b: Brief[]) => void): void {
  useEffect(() => {
    const take = () => {
      const got = waiting.get(sid);
      if (!got?.length) return;
      waiting.delete(sid);
      add(got.map(briefFile));
      onAdded?.(got);
    };
    take();
    const on = (e: Event) => (e as CustomEvent<{ sid: string }>).detail?.sid === sid && take();
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [sid]); // eslint-disable-line react-hooks/exhaustive-deps
}
