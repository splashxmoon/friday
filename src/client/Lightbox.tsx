import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.js";
import { isVideo } from "./picture-url.js";

/** `alt`: what it is called; `file`: where it is, when that isn't its name (a step's screenshot, called by the step). */
export type LightboxPicture = { src: string; alt: string; file?: string };

/**
 * A picture, large, in front of everything: the way Claude shows one, and not a window of its own.
 *
 * A link to an image with `target="_blank"` opened, in the desktop app, a second Electron window titled with the file's id.
 * This dims the page and puts the picture in the middle of it instead. Esc, the close button or a press outside it closes it.
 *
 * Several (a step's screenshots): ← and → go between them, and it says which of how many (Arun, 2026-11-18: "allow us to handle to
 * view images like svg, png, etc as well"). A press on the picture shows it at its own size, to be scrolled, and back. It sits on
 * a checkerboard, so a drawing with no background of its own (an SVG's black lines, a PNG cut-out) shows on the dark page. Always an
 * `<img>`: an SVG is drawn as a picture, never put in the page as markup, so nothing in it runs.
 */
export function Lightbox({ src, alt, onClose, items, start = 0 }: { src?: string; alt?: string; onClose: () => void; items?: readonly LightboxPicture[]; start?: number }) {
  const all: readonly LightboxPicture[] = items?.length ? items : [{ src: src ?? "", alt: alt ?? "" }];
  const [at, setAt] = useState(() => Math.min(Math.max(0, start), all.length - 1));
  const [actual, setActual] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  const pic = all[Math.min(at, all.length - 1)]!;
  const many = all.length > 1;
  const go = (d: number) => {
    setActual(false);
    setAt((i) => (i + d + all.length) % all.length);
  };
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => before?.focus?.();
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (many && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        e.stopPropagation();
        e.preventDefault();
        go(e.key === "ArrowRight" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose, many]); // eslint-disable-line react-hooks/exhaustive-deps
  const base = (p: string) => p.split(/[\\/]/).pop() || p;
  const name = pic.file ? pic.alt : base(pic.alt);
  const fileName = base(pic.file ?? pic.alt);
  // A video plays here, with its controls, in the place a picture shows (Arun, 2026-11-19: "handle support for videos like mp4").
  const video = isVideo(fileName) || isVideo(pic.src);
  return createPortal(
    <div className={`lightbox${actual ? " actual" : ""}`} role="dialog" aria-modal="true" aria-label={name || "Image"} onClick={onClose}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        {many && (
          <span className="lightbox-count" aria-live="polite">
            {at + 1} of {all.length}
          </span>
        )}
        <a className="lightbox-btn" href={pic.src} download={fileName || true} aria-label="Download" title="Download">
          <Icon name="download" size={16} />
        </a>
        <button ref={close} type="button" className="lightbox-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <Icon name="x" size={18} />
        </button>
      </div>
      {many && (
        <>
          <button type="button" className="lightbox-nav prev" aria-label="Previous picture" title="Previous (←)" onClick={(e) => (e.stopPropagation(), go(-1))}>
            <Icon name="navBack" size={20} />
          </button>
          <button type="button" className="lightbox-nav next" aria-label="Next picture" title="Next (→)" onClick={(e) => (e.stopPropagation(), go(1))}>
            <Icon name="navForward" size={20} />
          </button>
        </>
      )}
      <figure className="lightbox-figure" onClick={(e) => e.stopPropagation()}>
        <div className="lightbox-stage">
          {video ? (
            <video key={pic.src} src={pic.src} className="lightbox-img lightbox-video" controls autoPlay playsInline aria-label={name || "Video"} />
          ) : (
          <img key={pic.src} src={pic.src} alt={name} className={`lightbox-img${/\.svg$/i.test(fileName) || /\.svg(?:$|[?&#])/i.test(pic.src) ? " vector" : ""}`} title={actual ? "Fit to the window" : "Show at its own size"} onClick={() => setActual((a) => !a)} />
          )}
        </div>
        {name && (
          <figcaption className="lightbox-name" title={pic.file ?? pic.alt}>
            {name}
          </figcaption>
        )}
      </figure>
    </div>,
    document.body,
  );
}
