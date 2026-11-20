import { lazy, Suspense, useEffect, useState } from "react";
import type { Identity } from "../storage.js";

// The window itself loads when it is first opened (it is only sometimes shown: test/client-bundle.test.ts budgets).
const CodeSearch = lazy(() => import("./CodeSearch.js").then((m) => ({ default: m.CodeSearch })));

/** Mounted with Code (VsCodeView): opens the search on the window bar's pill, and has the folder's files ahead of the first look (and again when the window gets focus back). */
export function CodeSearchHost({ identity, folder }: { identity: Identity; folder: string | null }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener("friday:code-search", on);
    return () => window.removeEventListener("friday:code-search", on);
  }, []);
  useEffect(() => {
    if (!folder) return;
    let off = () => {};
    let live = true;
    void import("./search-files.js").then((m) => {
      if (!live) return;
      void m.loadFiles(identity, folder);
      off = m.refreshOnFocus(identity, () => folder);
    });
    return () => ((live = false), off());
  }, [identity, folder]);
  return open ? <Suspense fallback={null}><CodeSearch identity={identity} folder={folder} onClose={() => setOpen(false)} /></Suspense> : null;
}
