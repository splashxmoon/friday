import { useState } from "react";
import { Icon } from "../icons.js";
import { machineError } from "../GitHubConnect.js";
import type { Identity } from "../storage.js";
import { isLocal } from "../edition.js";
import { ContextMenu } from "../ui.js";
import { askForIde } from "./file-links.js";
import { getMode, ideCanOpen } from "./mode.js";
import { openPrFileInIde, reviewOwnPrInIde } from "./pr-review.js";

type None = { file?: undefined; pr?: undefined; menu?: undefined; prFile?: undefined };
type Props = { className?: string; arrow?: boolean } & (
  | (Omit<None, "file"> & { file: { path: string; line?: number | null; lane?: string } })
  | (Omit<None, "pr"> & { pr: { folder?: string; base?: string; head?: string; url?: string; icon?: boolean; /** Its icon alone, its words its tooltip (the Pull request panel's head). */ compact?: boolean } })
  // A file mention's right-click menu, drawn where the pointer was: the IDE, or the path.
  | (Omit<None, "menu"> & { menu: { x: number; y: number; path: string; line?: number; lane?: string; from?: Element | null; copy: () => void; close: () => void } })
  // A file of a teammate's pull request (the guided tour): its head checked out in a copy of its own, the file open there.
  | (Omit<None, "prFile"> & { prFile: { identity: Identity; url: string; title?: string; path: string; line?: number } })
);

/** One file of a teammate's pull request: busy while the copy is made, the reason if it can't be. */
function PrFileButton({ className, f }: { className?: string; f: { identity: Identity; url: string; title?: string; path: string; line?: number } }) {
  const [state, set] = useState<"" | "busy" | string>("");
  return (
    <button
      type="button"
      className={className}
      disabled={state === "busy"}
      title={state && state !== "busy" ? state : "Check the pull request out in a copy and open this file in the IDE"}
      onClick={() => {
        set("busy");
        openPrFileInIde(f.identity, { url: f.url, title: f.title }, { path: f.path, line: f.line }).then(
          () => set(""),
          (e) => set(`Couldn't open it: ${machineError(e)}`),
        );
      }}
    >
      {state === "busy" ? "Opening…" : state ? "Couldn't open it" : "Open in the IDE"}
    </button>
  );
}

/** The body of IdeLink: nothing when there is nowhere to open it (hosted, in Code, no folder). */
export default function IdeLinkBody({ className, arrow, file, pr, menu, prFile }: Props) {
  if (prFile) return isLocal() ? <PrFileButton className={className} f={prFile} /> : null;
  if (menu) {
    const { path, line, lane, from } = menu;
    return (
      <ContextMenu
        at={menu}
        onClose={menu.close}
        items={() => [
          { label: "Open in the IDE", icon: "code", hint: line ? `Line ${line}` : undefined, onSelect: () => void (askForIde({ path, from, ...(line ? { line } : {}), ...(lane ? { lane } : {}) }) || menu.copy()) },
          { label: "Copy the path", icon: "copy", onSelect: menu.copy },
        ]}
      />
    );
  }
  if (file) {
    if (!isLocal() || getMode() !== "agents" || !ideCanOpen()) return null;
    return (
      <button type="button" className={className} onClick={(e) => void (askForIde({ path: file.path, from: e.currentTarget, ...(file.line ? { line: file.line } : {}), ...(file.lane ? { lane: file.lane } : {}) }) || navigator.clipboard?.writeText(file.path).catch(() => {}))}>
        Open in the IDE {arrow && <Icon name="arrowRight" size={12} />}
      </button>
    );
  }
  if (!isLocal() || !pr?.folder) return null;
  const n = pr.url?.split("/pull/")[1];
  return (
    <button type="button" className={className} title="Review in the IDE: the pull request's changes as a diff" aria-label={pr.compact ? "Review in the IDE" : undefined} onClick={() => reviewOwnPrInIde({ folder: pr.folder!, ...(pr.base ? { base: pr.base } : {}), ...(pr.head ? { head: pr.head } : {}), label: `Pull request${n ? ` #${n}` : ""}` })}>
      {(pr.icon || pr.compact) && <Icon name="code" size={pr.compact ? 13 : 12} />}
      {!pr.compact && " Review in the IDE"}
    </button>
  );
}
