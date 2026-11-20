import { lazy, Suspense, type ComponentProps } from "react";

const Dialog = lazy(() => import("./Ship.js").then((m) => ({ default: m.ShipDialog })));

/**
 * The commit dialog (Ship.tsx), loaded when it opens: four pages in the first load show it and only a commit asks for it. Drawn as
 * the dialog itself once it has come (the first press waits a moment for it, as any lazy page does).
 */
export const ShipDialog = (p: ComponentProps<typeof Dialog>) => (
  <Suspense fallback={null}>
    <Dialog {...p} />
  </Suspense>
);
