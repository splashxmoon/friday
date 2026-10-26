import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * One spelling per place on disk, so "is this inside that folder?" can't be
 * answered wrong by a symlink, a `..`, a trailing slash or a different case.
 *
 * The deepest part that exists is resolved for real (a file about to be
 * written doesn't exist yet, but the folder it lands in does, and that folder
 * may be a link to somewhere else); the rest is appended as written. A link
 * that points at nothing yet is followed by hand, since writing through it
 * would create its target. Case is folded where the file system folds it by
 * default (Windows and macOS).
 */
export function folderKey(p: string, platform: NodeJS.Platform = process.platform): string {
  let head = path.resolve(p);
  const rest: string[] = [];
  for (let hops = 0; ; ) {
    try {
      head = realpathSync.native(head);
      break;
    } catch {}
    // A dangling link: carry on from where it points.
    if (hops++ < 40 && lstatSync(head, { throwIfNoEntry: false })?.isSymbolicLink()) {
      head = path.resolve(path.dirname(head), readlinkSync(head));
      continue;
    }
    const up = path.dirname(head);
    if (up === head) break;
    rest.unshift(path.basename(head));
    head = up;
  }
  return pathKey(path.join(head, ...rest), platform);
}

/**
 * A path spelled one way without asking the disk: slashes, a trailing slash and case. For a path another machine sent
 * (its runner resolved links there), where this server has no disk to ask.
 */
export function pathKey(p: string, platform: string): string {
  const key = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" || platform === "darwin" ? key.toLowerCase() : key;
}

/** The file system a path from another machine is on, when its runner didn't say: a drive letter is Windows. */
export const platformOf = (p: string): string => (/^[a-z]:[\\/]/i.test(p) ? "win32" : "linux");

/** Two folders on one machine share files: the same one, or one inside the other. */
export function overlaps(a: string, b: string, platform: string = platformOf(a)): boolean {
  const x = pathKey(a, platform);
  const y = pathKey(b, platform);
  return x === y || x.startsWith(y + "/") || y.startsWith(x + "/");
}

/** `p` is `root` or somewhere under it, on disk rather than on paper. */
export function contains(root: string, p: string): boolean {
  const r = folderKey(root);
  const k = folderKey(p);
  return k === r || k.startsWith(r + "/");
}
