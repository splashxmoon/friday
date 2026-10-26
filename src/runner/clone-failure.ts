/**
 * Why a clone failed, in words that point at the fix, with git's or gh's own
 * reason attached.
 *
 * This used to say "check the name and your login" for anything containing
 * "not found" — which includes "git not found" and a network that wasn't there
 * — so the one sentence was wrong about the cause as often as it was right, and
 * hid the line that would have said which.
 */
export function cloneFailure(name: string, raw: string): string {
  const first = raw
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-2)
    .join(" ")
    .slice(0, 240);
  const m = raw.toLowerCase();
  let hint = "";
  if (/could not resolve host|unable to access|failed to connect|timed out|network is unreachable|connection (reset|refused)/.test(m)) {
    hint = "It couldn't reach GitHub: check the connection and try again.";
  } else if (/executable file not found|is not recognized|command not found|enoent/.test(m)) {
    hint = "git isn't installed here, or isn't on the PATH Friday sees. Install git from git-scm.com.";
  } else if (/authentication failed|could not read username|terminal prompts disabled|bad credentials|requires authentication|http 401/.test(m)) {
    hint = "GitHub didn't accept this computer's login. Run `gh auth login` (or sign in once with git) and try again.";
  } else if (/repository not found|http 404|not found/.test(m)) {
    hint = "GitHub can't find it from this computer's login. If it's private, check that the account signed in to gh or git is the one that can see it.";
  } else if (/403|forbidden|rate limit/.test(m)) {
    hint = "GitHub refused it (403): this login may not have access, or it's being rate limited.";
  }
  return `Couldn't clone ${name}.${hint ? ` ${hint}` : ""}${first ? ` (${first})` : ""}`;
}
