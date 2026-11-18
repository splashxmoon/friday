import { useState } from "react";
import { Lightbox } from "./Lightbox.js";
import { localPicture } from "./picture-url.js";

/** A picture to show: where it is on the agent's computer, and what to call it (the step that gave it, "Read shot.png"). */
export type ChatPicture = { path: string; name?: string };

/** What a picture is called: the name it was given, else its file's (not its whole path on the agent's computer). */
const nameOf = (p: ChatPicture) => p.name || p.path.split(/[\\/]/).pop() || p.path;

/**
 * The pictures a coding tool's steps gave back (a screenshot it took, an image it read), small, in a row under its work, each opening
 * large in front of the page with the others beside it (Arun, 2026-11-18: "allow for the coding tools and stuff to send images in
 * the chat too"). They are files on the computer the tool ran on (runner/tool-pictures.ts), shown through the session as any picture
 * an agent names is (LiveBlock localPicture). One that is gone, or not on this computer, is left out rather than drawn broken.
 */
export function PictureStrip({ pictures, max = 4, label = "Pictures from its steps" }: { pictures: readonly ChatPicture[]; max?: number; label?: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const seen = new Set<string>();
  const all = pictures.flatMap((p) => {
    const src = localPicture(p.path);
    if (!src || gone.has(p.path) || seen.has(p.path)) return [];
    seen.add(p.path);
    return [{ ...p, src }];
  });
  if (!all.length) return null;
  const shown = all.slice(0, all.length > max ? max - 1 : max);
  const more = all.length - shown.length;
  return (
    <div className="pic-strip" role="list" aria-label={label}>
      {shown.map((p, i) => (
        <button key={p.path} type="button" role="listitem" className={`pic-thumb${/\.svg$/i.test(p.path) ? " vector" : ""}`} title={`${nameOf(p)}: show it large`} onClick={() => setOpen(i)}>
          <img src={p.src} alt={nameOf(p)} loading="lazy" onError={() => setGone((g) => new Set(g).add(p.path))} />
        </button>
      ))}
      {more > 0 && (
        <button type="button" role="listitem" className="pic-thumb pic-more" title={`${more} more`} onClick={() => setOpen(shown.length)}>
          <img src={all[shown.length]!.src} alt="" aria-hidden loading="lazy" />
          <span>+{more}</span>
        </button>
      )}
      {open !== null && <Lightbox items={all.map((p) => ({ src: p.src, alt: nameOf(p), file: p.path }))} start={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

