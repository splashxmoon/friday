// The @names in a coding session's box, each in its own colour as it is typed (Arun, 2026-11-13: "the color coded @s in the coding
// session"): a crew mate in its mascot's colour, an agent here in its tool's, a person and a crew room in their own quiet ones. A
// textarea can't colour part of its text, so a copy sits under it (useTextBackdrop), the textarea's letters clear while there is
// a name to draw.
import { useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useTextBackdrop } from "./Teammates.js";

export type Tinted = { name: string; colour: string };

/** Where each @name starts and ends in `text`: the longest name that follows an "@" at the start or after a space. */
export function tintedIn(text: string, names: readonly Tinted[]): { at: number; end: number; colour: string }[] {
  const out: { at: number; end: number; colour: string }[] = [];
  const low = text.toLowerCase();
  const by = [...names].filter((n) => n.name.trim()).sort((a, b) => b.name.length - a.name.length);
  for (let i = low.indexOf("@"); i !== -1; i = low.indexOf("@", i + 1)) {
    if (i > 0 && !/\s/.test(text[i - 1]!)) continue;
    const hit = by.find((n) => low.startsWith(n.name.toLowerCase(), i + 1) && !/[\p{L}\p{N}_-]/u.test(text[i + 1 + n.name.length] ?? ""));
    if (hit) out.push({ at: i, end: i + 1 + hit.name.length, colour: hit.colour });
  }
  return out;
}

export function TintedMentions({ text, textarea, names }: { text: string; textarea: RefObject<HTMLTextAreaElement | null>; names: readonly Tinted[] }) {
  const marks = text.includes("@") ? tintedIn(text, names) : [];
  const back = useRef<HTMLDivElement>(null);
  const on = marks.length > 0;
  useTextBackdrop(textarea, back, on);
  if (!on) return null;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [i, m] of marks.entries()) {
    if (m.at > at) parts.push(text.slice(at, m.at));
    parts.push(
      <span key={i} className="mt-mention" style={{ "--c": m.colour } as CSSProperties}>
        {text.slice(m.at, m.end)}
      </span>,
    );
    at = m.end;
  }
  parts.push(text.slice(at));
  return (
    <div ref={back} className="tm-backdrop" aria-hidden="true">
      {parts}
      {text.endsWith("\n") ? " " : ""}
    </div>
  );
}
