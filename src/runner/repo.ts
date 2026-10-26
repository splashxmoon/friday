/**
 * What someone typed as "the repo": owner/name, a GitHub page URL, or any git
 * URL. Pure, so the browser and the server read it the same way. Returns null
 * for anything that could be read as a command-line flag.
 */
export function parseRepo(input: string): { url: string; name: string; slug?: string } | null {
  const s = input.trim();
  // A leading dash is the thing that could be read as a flag. A plain space
  // is not: every caller passes this as one element of an argv array, and
  // half of Windows lives under a home directory with a space in its name.
  if (!s || s.startsWith("-") || /[\x00-\x1f]/.test(s)) return null;
  const clean = (n: string) => n.replace(/\.git$/, "").replace(/[^\w.-]/g, "");
  const gh =
    s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/) ?? s.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (gh) return { slug: `${gh[1]}/${gh[2]}`, url: `https://github.com/${gh[1]}/${gh[2]}.git`, name: clean(gh[2]!) };
  const short = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (short) return { slug: `${short[1]}/${short[2]}`, url: `https://github.com/${short[1]}/${short[2]}.git`, name: clean(short[2]!) };
  if (/^(https?|ssh|git|file):\/\//.test(s) || /^[\w.-]+@[\w.-]+:/.test(s)) {
    // Split on a backslash too: a Windows path inside a file:// URL would
    // otherwise come back as one giant "name", scrubbed into nonsense.
    const name = clean(s.replace(/[\/\\]+$/, "").split(/[\/:\\]/).pop() ?? "");
    return name ? { url: s, name } : null;
  }
  return null;
}

/**
 * One spelling of a repo URL, for deciding whether two point at the same
 * place. git rewrites backslashes to forward slashes when it stores a remote,
 * so a Windows path handed in and the same path read back never match as
 * literal strings. Case is left alone: git preserves it, and folding it would
 * make two genuinely different repos look like one.
 */
export const canonicalUrl = (u: string) =>
  u
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
