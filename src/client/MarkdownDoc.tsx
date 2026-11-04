import { useState, type MouseEvent, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import { openOutside } from "./openOutside.js";
import { slugOf } from "./WorkPanels.js";
import "./work.css";

/**
 * A Markdown file read as a page, the way Work sessions showed their documents and Claude shows one (Arun, 2026-11-03: "if you
 * open a .md file it will appear like it did in the work sessions before, nicely designed and formatted"): the same prose type,
 * measure and spacing (work.css .work-prose), headings you can link to, links that open where they point. Its source is a
 * switch away in the file panel (Tree.tsx FileView).
 */
export function MarkdownDoc({ text, path }: { text: string; path: string }) {
  const parts = {
    a: ({ href, children }: { href?: string; children?: ReactNode }) => <DocLink href={href ?? ""} from={path}>{children}</DocLink>,
    img: ({ src, alt }: { src?: string | Blob; alt?: string }) => <DocImage src={typeof src === "string" ? src : ""} alt={alt ?? ""} />,
    h1: heading("h1"),
    h2: heading("h2"),
    h3: heading("h3"),
    h4: heading("h4"),
  };
  return (
    <article className="work-prose md-doc">
      <Streamdown mode="static" parseIncompleteMarkdown={false} controls={false} components={parts}>
        {text}
      </Streamdown>
    </article>
  );
}

const textOf = (n: ReactNode): string => (typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(textOf).join("") : n && typeof n === "object" && "props" in n ? textOf((n as { props: { children?: ReactNode } }).props.children) : "");
const heading =
  (Tag: "h1" | "h2" | "h3" | "h4") =>
  ({ children }: { children?: ReactNode }) => <Tag id={`doc-${slugOf(textOf(children))}`}>{children}</Tag>;

/** A path beside this file, made whole: "../notes/plan.md" from "docs/a/readme.md" is "docs/notes/plan.md". */
export function besideFile(from: string, to: string): string {
  const parts = from.replace(/\\/g, "/").split("/").slice(0, -1);
  for (const p of to.split(/[?#]/)[0]!.replace(/\\/g, "/").split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") parts.pop();
    else parts.push(p);
  }
  return parts.join("/");
}

/** To the web: the browser. To a heading here: scrolled to. To a file beside it: opened in the panel, as a file named in a reply is. */
function DocLink({ href, from, children }: { href: string; from: string; children?: ReactNode }) {
  const [nowhere, setNowhere] = useState(false);
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (/^(https?:|mailto:)/i.test(href)) return void openOutside(href);
    if (href.startsWith("#")) {
      const id = slugOf(decodeURIComponent(href.slice(1)));
      const target = e.currentTarget.closest(".md-doc")?.querySelector<HTMLElement>(`[id="doc-${CSS.escape(id)}"]`);
      if (!target) return setNowhere(true);
      return void target.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    window.dispatchEvent(new CustomEvent("friday:open-file", { detail: { path: besideFile(from, href) }, cancelable: true }));
  };
  return (
    <>
      <a href={href} onClick={go} title={href}>
        {children}
      </a>
      {nowhere && <em className="muted small"> (no such heading)</em>}
    </>
  );
}

/** A picture from the web loads only when asked: opening a file shouldn't tell a site you read it. One beside the file is named. */
function DocImage({ src, alt }: { src: string; alt: string }) {
  const [shown, setShown] = useState(false);
  if (/^https?:/i.test(src) && shown) return <img src={src} alt={alt} loading="lazy" />;
  if (/^https?:/i.test(src))
    return (
      <button type="button" className="md-doc-img" onClick={() => setShown(true)} title={src}>
        Show picture{alt ? `: ${alt}` : ""}
      </button>
    );
  return <span className="md-doc-img">{alt || src.split("/").at(-1)}</span>;
}
