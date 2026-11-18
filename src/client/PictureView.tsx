import { useState, type ReactNode } from "react";
import { Lightbox } from "./Lightbox.js";
/**
 * One picture file, open in a side panel (the file tree's viewer, a changed picture in the Changes panel): the picture itself,
 * fitted to the panel, its size and kind under it, and large in front of the page on a press (Arun, 2026-11-18: "also be able to
 * see in the side panels and stuff too"). It read "isn't a text file, so there's nothing useful to read." An SVG is an `<img>`.
 */
export default function PictureView({ src, path, note }: { src: string; path: string; /** A line under it, e.g. who changed it. */ note?: ReactNode }) {
  const [big, setBig] = useState(false);
  const [size, setSize] = useState<[number, number] | null>(null);
  const [tries, setTries] = useState(0);
  const [bad, setBad] = useState(false);
  const name = path.split(/[\\/]/).pop() || path;
  const kind = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toUpperCase() ?? "Picture";
  const at = tries ? `${src}${src.includes("?") ? "&" : "?"}try=${tries}` : src;
  return (
    <div className="pic-view">
      {bad ? (
        <p className="muted small pic-view-gone">
          {name} couldn't be shown: it isn't in this session's folders on a computer that's connected, or it isn't finished yet.{" "}
          <button type="button" className="link-btn" onClick={() => (setBad(false), setTries((n) => n + 1))}>
            Try again
          </button>
        </p>
      ) : (
        <button type="button" className={`pic-view-frame${/\.svg$/i.test(path) ? " vector" : ""}`} title={`Show ${name} large`} onClick={() => setBig(true)}>
          <img key={at} src={at} alt={name} onLoad={(e) => setSize([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])} onError={() => setBad(true)} />
        </button>
      )}
      <div className="pic-view-meta muted small">
        <span>{[kind, size && size[0] ? `${size[0]} × ${size[1]}` : ""].filter(Boolean).join(" · ")}</span>
        {note}
      </div>
      {big && <Lightbox src={at} alt={path} onClose={() => setBig(false)} />}
    </div>
  );
}
