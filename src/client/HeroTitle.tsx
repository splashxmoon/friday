/**
 * The line at the top of a new session: one, the same every time (UX audit F25, 2026-11-07). It used to turn through sixteen
 * questions, and each load read as a different page.
 */
export function HeroTitle({ lines = ["What should we build?"] }: { /** A page that asks something else: its first line. */ lines?: string[] }) {
  return <h1 className="hero-title">{lines[0]}</h1>;
}
