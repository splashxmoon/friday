import { lazy, Suspense, type ComponentProps } from "react";

const Inner = lazy(() => import("./ide-link-body.js"));

/**
 * A button that opens something in the IDE, from a page of Agents: a file at its line, or the session's own pull request as a diff
 * (Arun, 2026-11-20, Code and Agents wired together: "Every file mention opens in the IDE", "Review in the IDE from anywhere").
 * What it draws and does is loaded when it shows: these sit in pages that are in the first load, and few people ever see one.
 */
export const IdeLink = (p: ComponentProps<typeof Inner>) => (
  <Suspense fallback={null}>
    <Inner {...p} />
  </Suspense>
);
