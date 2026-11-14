// What opens "Keep this going" (Code and Crew, connected, ported to the open-source edition from Friday Teams e4d637ea and
// 7afa7b97, keep-going-open.tsx) from anywhere, and the one place it is drawn: loaded with every page, so kept to an event and a
// lazy sheet (CrewCarrySheet.tsx).
import { lazy, Suspense, useEffect, useState } from "react";
import { loadRecents } from "./storage.js";

const KEEP_GOING = "friday:keep-going";
const WHEEL = "friday:keep-going-wheel";
const BRING = "friday:keep-going-bring";

const notice = (text: string) => dispatchEvent(new CustomEvent("friday:notice", { detail: text }));

/** What "Bring it in" opens on: the session, and whose work ("mate:<id>" or "room:<id>"), named for the sheet's title. */
export type BringAsk = { sid: string; invite: string; from: string; name: string };
/** The look before work comes in (CrewCarrySheet.tsx BringSheet): what there is, how it relates, what overlaps. */
export const openBring = (d: Omit<BringAsk, "invite"> & { invite?: string }) => {
  const invite = d.invite ?? loadRecents().find((r) => r.sid === d.sid)?.invite;
  if (!invite) return notice("Open the session first.");
  dispatchEvent(new CustomEvent(BRING, { detail: { ...d, invite } }));
};

/** What the sheet opens on: the session and its invite, the lane, and a crew mate and words already picked (@Kit). */
export type KeepGoingAsk = { sid: string; invite: string; lane?: string; mate?: string; note?: string };
/** `invite` left out: the one this computer keeps for the session (a menu that has only its session). */
export const openKeepGoing = (d: Omit<KeepGoingAsk, "invite"> & { invite?: string }) => {
  const invite = d.invite ?? loadRecents().find((r) => r.sid === d.sid)?.invite;
  if (!invite) return notice("Open the session first.");
  dispatchEvent(new CustomEvent(KEEP_GOING, { detail: { ...d, invite } }));
};

/** The path of one of a session's hand-off routes, with its invite. */
export const kgPath = (sid: string, invite: string, rest = "", q = "") => `/api/sessions/${encodeURIComponent(sid)}/keep-going${rest}?invite=${encodeURIComponent(invite)}${q}`;

type WheelAsk = { sid: string; invite: string; job: string; mateName: string; text: string; done: (a: "back" | "note" | null) => void };
/**
 * Typing in a lane a crew mate has now: "Take it back" (its work stops, the words go to the lane as they would have) or "Send Kit a
 * note" (the words go to the crew mate instead). Null: neither, the words stay in the box.
 */
export const askWheel = (d: Omit<WheelAsk, "done">): Promise<"back" | "note" | null> => new Promise((done) => dispatchEvent(new CustomEvent(WHEEL, { detail: { ...d, done } })));

const Sheet = lazy(() => import("./CrewCarrySheet.js").then((m) => ({ default: m.KeepGoingSheet })));
const Wheel = lazy(() => import("./CrewCarrySheet.js").then((m) => ({ default: m.WheelDialog })));
const Bring = lazy(() => import("./CrewCarrySheet.js").then((m) => ({ default: m.BringSheet })));

/** Mounted once in the app: the sheet any "Keep this going" opens, and the wheel's question. */
export function KeepGoingHost() {
  const [ask, setAsk] = useState<KeepGoingAsk | null>(null);
  const [wheel, setWheel] = useState<WheelAsk | null>(null);
  const [bring, setBring] = useState<BringAsk | null>(null);
  useEffect(() => {
    const on = (e: Event) => setAsk((e as CustomEvent<KeepGoingAsk>).detail);
    const onWheel = (e: Event) => setWheel((e as CustomEvent<WheelAsk>).detail);
    const onBring = (e: Event) => setBring((e as CustomEvent<BringAsk>).detail);
    addEventListener(KEEP_GOING, on);
    addEventListener(WHEEL, onWheel);
    addEventListener(BRING, onBring);
    return () => (removeEventListener(KEEP_GOING, on), removeEventListener(WHEEL, onWheel), removeEventListener(BRING, onBring));
  }, []);
  return (
    <Suspense fallback={null}>
      {ask && <Sheet ask={ask} onClose={() => setAsk(null)} />}
      {bring && <Bring ask={bring} onClose={() => setBring(null)} />}
      {wheel && (
        <Wheel
          ask={wheel}
          onClose={(a: "back" | "note" | null) => {
            wheel.done(a);
            setWheel(null);
          }}
        />
      )}
    </Suspense>
  );
}
