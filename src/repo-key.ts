/** One key per repo, from what the folder says about itself: its GitHub repo, its remote, or its folder name. */
export function repoKeyOf(remote: { url?: string | null; github?: string | null } | null | undefined, folder?: string | null): { key: string; name: string } | null {
  if (remote?.github) return { key: `github.com/${remote.github.toLowerCase()}`, name: remote.github };
  const url = remote?.url?.trim();
  if (url) {
    // git@host:owner/name.git and https://host/owner/name.git alike, without credentials or the .git.
    const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?\/?$/i.exec(url);
    if (m) {
      const path = m[2]!.replace(/^\/+/, "");
      return { key: `${m[1]!.toLowerCase()}/${path.toLowerCase()}`, name: path.split("/").slice(-2).join("/") };
    }
  }
  // A separate copy of a folder is named after it with an id on the end: it is the same project.
  const base = (folder ?? "").split(/[\\/]/).filter(Boolean).pop()?.replace(/-[0-9a-f]{8}$/i, "");
  return base ? { key: `folder:${base.toLowerCase()}`, name: base } : null;
}

/** A repo's name from its key, for one a person started by hand: owner/name, or the folder's name. */
export const repoNameOf = (key: string) => (key.startsWith("folder:") ? key.slice(7) : key.split("/").slice(-2).join("/"));
