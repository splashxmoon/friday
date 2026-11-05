import { lazy, Suspense } from "react";

/**
 * An agent's words as a rendered answer, for views the app draws before any session (the Team room, its threads). The Markdown,
 * maths and motion behind an answer (streamdown, parse5, framer-motion: ~300 KB packed) load with the session screen, not with
 * app.js: imported statically from Teammates.tsx they doubled the first load (app.js 327 -> 637 KB brotli, Oct 22 -> Nov 4).
 * Until they arrive the words show as they are. test/client-bundle.test.ts keeps them out of the first load.
 */
const Rich = lazy(() => import("./rich-answer.js"));

export function LazyAnswer({ text }: { text: string }) {
  return (
    <Suspense fallback={<span style={{ whiteSpace: "pre-wrap" }}>{text}</span>}>
      <Rich text={text} />
    </Suspense>
  );
}
