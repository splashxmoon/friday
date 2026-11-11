import { headlineClass, type CommandClass } from "./command-class.js";

/**
 * What a command a teammate asks to run would do, in plain words, for its permission card (Arun, 2026-11-11, option 3A of the Crew
 * overhaul, after Oh My Hermes: "Rewrites history on a remote branch"): what it wants to do, and what that means for you, in one
 * sentence that says what can't be undone. Read from the command itself, the riskiest of several.
 */
export interface PlainRisk {
  /** After "Kit wants to": "publish a package to npm". */
  does: string;
  /** What it means, or "" where nothing leaves this computer and nothing is lost. */
  risk: string;
  /** Worth a careful look before saying yes. */
  careful: boolean;
  /** Said of this command by name (npm publish, git push), not only of its kind. */
  named: boolean;
}

/** The commands people know by name, before the kind of command they are. */
const NAMED: { re: RegExp; does: string; risk: string }[] = [
  { re: /\b(?:npm|pnpm|yarn|bun)\s+publish\b/, does: "publish a package to npm", risk: "Everyone who installs it gets this version. It can't be taken back, only replaced by a newer one." },
  { re: /\bcargo\s+publish\b/, does: "publish a crate", risk: "Everyone who depends on it gets this version. It can't be taken back, only yanked." },
  { re: /\b(?:twine\s+upload|poetry\s+publish|uv\s+publish)\b/, does: "publish a package to PyPI", risk: "Everyone who installs it gets this version. It can't be taken back, only replaced by a newer one." },
  { re: /\bgit\s+push\b[^;&|]*(?:\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)/, does: "force-push a branch", risk: "It rewrites history on the remote branch: commits others pushed there can be lost." },
  { re: /\bgit\s+push\b[^;&|]*\s--delete\b|\bgit\s+push\s+\S+\s+:\S/, does: "delete a branch on the remote", risk: "The branch goes for everyone who works from it." },
  { re: /\bgit\s+push\b/, does: "push commits to the remote", risk: "Everyone who pulls the branch gets them." },
  { re: /\bgh\s+pr\s+merge\b/, does: "merge a pull request", risk: "Its changes land in the branch it merges into, for everyone." },
  { re: /\bgh\s+pr\s+create\b/, does: "open a pull request", risk: "Anyone who can see the repository can read it." },
  { re: /\bgh\s+release\b/, does: "make a release", risk: "Everyone watching the repository is told, and its files can be downloaded at once." },
  { re: /\bgit\s+reset\s+--hard\b|\bgit\s+clean\b[^;&|]*-[a-z]*f/, does: "throw away uncommitted changes", risk: "Work that wasn't committed is lost for good." },
  { re: /\bgit\s+(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)/, does: "throw away uncommitted changes", risk: "Work that wasn't committed is lost for good." },
  { re: /\bdrop\s+(?:table|database|schema)\b|\btruncate\s+table\b/i, does: "delete data from a database", risk: "The data goes for good, unless there's a backup." },
  { re: /\b(?:rm|Remove-Item|del|rmdir)\b/, does: "delete files", risk: "Deleted files don't go to the Trash: they can't be brought back from here." },
];

const KIND: Record<CommandClass, { does: string; risk: string }> = {
  read: { does: "look around the project", risk: "" },
  checks: { does: "run the checks", risk: "" },
  build: { does: "build the project", risk: "" },
  git: { does: "use git on this computer", risk: "" },
  install: { does: "install packages", risk: "It downloads code from outside and runs it on this computer." },
  publish: { does: "send work outside this computer", risk: "Others can see it once it's out, and it can't be called back." },
  deploy: { does: "deploy", risk: "It changes what's live for the people who use it." },
  destructive: { does: "delete or overwrite something", risk: "What it removes can't be brought back from here." },
  other: { does: "run a command Friday doesn't recognise", risk: "Read it before saying yes: Friday can't tell what it does." },
};

/** The plain words for the riskiest of these commands. */
export function plainRisk(items: readonly string[]): PlainRisk {
  const order: CommandClass[] = ["read", "checks", "build", "git", "install", "other", "publish", "deploy", "destructive"];
  const worst = [...items].sort((a, b) => order.indexOf(headlineClass(b)) - order.indexOf(headlineClass(a)))[0] ?? "";
  const kind = headlineClass(worst);
  const careful = ["install", "other", "publish", "deploy", "destructive"].includes(kind);
  const named = NAMED.find((n) => n.re.test(worst));
  const words = named && careful ? named : KIND[kind];
  return { does: items.length > 1 && !careful ? `run ${items.length} commands` : words.does, risk: words.risk, careful, named: !!named && careful };
}
