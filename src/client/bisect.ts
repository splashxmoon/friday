/**
 * Find what broke (Arun, 2026-11-19, wave 2: "Bisect: tell Friday what broke; an agent runs git bisect with a test it writes or
 * the one you give, and hands back the commit that broke it."): what the agent is asked, how its report is read, and what each
 * button of the card says back to it.
 */
export interface Culprit {
  /** The commit's hash, as the agent gave it (7 to 40 hex digits). */
  commit: string;
  title: string;
  author: string;
  date: string;
  files: string[];
  why: string;
  /** The command or script the bisect ran. */
  check: string;
}

/** The fence the agent ends its report with: read by the chat (BisectCard). */
export const BISECT_FENCE = "friday-bisect";

const SHA = /^[0-9a-f]{7,40}$/i;
export const shortSha = (c: string) => c.slice(0, 7);

/** The kind of ask the IDE sends (the extension's "Find the commit that broke this", a failed command's button). */
export interface BisectAsk {
  /** What broke, in the person's words. */
  what?: string;
  /** A command that used to pass and fails now: the check, unless they gave another. */
  command?: string;
  /** What that command printed when it failed. */
  output?: string;
  /** The folder it ran in, relative to the project's, when that is not the project's own ("packages/api"). */
  folder?: string;
}

const FORMAT = `Then report with one fenced block, \`\`\`${BISECT_FENCE}, holding one JSON object: {"commit": the commit's hash, "title": its subject line, "author": its author's name, "date": its date as YYYY-MM-DD, "files": an array of the files it changed that matter, "why": one or two plain lines on how that change broke it, "check": the command or script you ran}. Put a short plain line before the block saying what you found. If you could not pin it to one commit (it never worked, or the history can't be tested), say why in plain words and leave the block out.`;

// Worded as work to do, with the rules the person's checkout needs: the bisect moves HEAD through history, so it never runs there.
// smartReach must not read it as "don't change anything" or a plain question (it needs to run commands), see test/bisect.test.ts.
export function bisectText(a: BisectAsk = {}): string {
  const cmd = (a.command ?? "").trim();
  // A command with a backtick or several lines can't sit in inline code: it goes in a fenced block of its own.
  const block = /[`\n]/.test(cmd);
  const inline = block ? "the command below" : `\`${cmd}\``;
  const folder = (a.folder ?? "").trim().replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "");
  const where = cmd && folder ? ` Run it in \`${folder}\` (it failed there), not at the top of the project.` : "";
  const cmdBlock = cmd && block ? `\n\nThe command:\n\`\`\`\n${cmd.slice(0, 1500)}\n\`\`\`` : "";
  const first = cmd.split("\n")[0].trim();
  const what = (a.what ?? "").trim();
  const said = what ? ` What broke: ${what}${/[.!?]$/.test(what) ? "" : "."}` : "";
  const out = a.output?.trim() ? `\n\nWhat ${cmd ? (block ? "it" : inline) : "it"} printed when it failed:\n\`\`\`\n${a.output.replace(/\n+$/, "").slice(-3000)}\n\`\`\`` : "";
  const check = cmd
    ? `Use ${inline} as the check: it passed before and fails now.${where} Wrap it in a small script that exits 0 when it works and 1 when it is broken (and 125 for a commit that cannot be tested at all, such as one that does not build for another reason).`
    : `Write a small check script that exits 0 when it works and 1 when it is broken (and 125 for a commit that cannot be tested at all). Use the test I name if I named one; if I did not and you cannot tell what to test, ask me before you start.`;
  const short = first.replace(/`/g, "'");
  const title = cmd ? `Find what broke \`${short.length > 40 ? `${short.slice(0, 39)}…` : short}\`` : "Find what broke";
  return `${title}

Something that used to work is broken now.${said} Find the commit that broke it with git bisect.

1. Find a good commit, one where it worked: the last tag, or where this branch left main (git merge-base). Run the check there to make sure it really passes. If you are not sure which commit is good, ask me.
2. ${check} Run it on the current commit and on the good one first, to see that it tells them apart.
3. Run the bisect in a SEPARATE worktree (git worktree add --detach into a temporary folder), never in my checkout. My uncommitted work and my branch must stay exactly as they are: do not stash, switch, reset or check out anything here. Install what the check needs inside the worktree.
4. Run git bisect run with the check. Always finish with git bisect reset, even if something fails, then remove the worktree and the temporary files.
5. Do not fix anything yet. ${FORMAT}${cmdBlock}${out}
`;
}

/** What "Fix it" asks: fix forward, in the checkout, from what the bisect found. */
export function fixForwardText(c: Culprit): string {
  return `Fix what ${shortSha(c.commit)} broke

The bisect found that commit ${shortSha(c.commit)} ("${c.title}") broke it${c.why ? `: ${c.why}` : ""}. Fix it forward: keep what that commit set out to do and repair what it broke, in a new commit on my branch. Add a test that would have caught it, run the tests, and say what you changed in a line or two. Do not push.${c.check ? ` The check that found it was \`${c.check}\`.` : ""}
`;
}

/** What "Revert it" asks: a revert commit prepared where my own work is not touched, never pushed. */
export function revertText(c: Culprit): string {
  return `Revert ${shortSha(c.commit)}

Prepare a revert of commit ${shortSha(c.commit)} ("${c.title}"). Make it as a commit made by git revert, in a separate worktree on a new branch off my current branch, so my uncommitted work is not touched. If it conflicts with later changes, resolve it the careful way and say what you did. Run the tests there. Do not push, and do not merge it into my branch: tell me the branch name and what the revert takes away.
`;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** A fence's JSON as the culprit, or null when it is not one (an unfinished or broken block is drawn as plain code instead). */
export function readBisect(text: string): Culprit | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const commit = str(o.commit, 200);
  const title = str(o.title, 300);
  if (!SHA.test(commit) || !title) return null;
  const files = Array.isArray(o.files) ? o.files.map((f) => str(f, 300)).filter(Boolean).slice(0, 12) : [];
  return { commit, title, author: str(o.author, 120), date: str(o.date, 40), files, why: str(o.why, 600), check: str(o.check, 300) };
}

/** "Ana Ruiz · 2026-11-02": who and when, whichever the agent gave. */
export function byLine(c: Culprit): string {
  return [c.author, c.date].filter(Boolean).join(" · ");
}
