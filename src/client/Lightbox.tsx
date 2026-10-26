import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.js";

/**
 * A picture, large, in front of everything: the way Claude shows one, and not a window of its own.
 *
 * A link to an image with `target="_blank"` opened, in the desktop app, a second Electron window titled with the file's id.
 * This dims the page and puts the picture in the middle of it instead. Esc, the close button or a press outside it closes it.
 */
export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      before?.focus?.();
    };
  }, [onClose]);
  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={alt || "Image"} onClick={onClose}>
      <button ref={close} type="button" className="lightbox-x" aria-label="Close" title="Close" onClick={onClose}>
        <Icon name="x" size={18} />
      </button>
      <figure className="lightbox-figure" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt={alt} className="lightbox-img" />
        {alt && <figcaption className="lightbox-name">{alt}</figcaption>}
      </figure>
    </div>,
    document.body,
  );
}
