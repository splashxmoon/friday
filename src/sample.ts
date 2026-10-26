import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Friday's own sample project: a first run with nothing to link and nothing to install.
 *
 * The best way to try Friday is your own agent on your own repo, and that needs a machine. This is the way that needs
 * nothing: a small project that ships with Friday, attached to a new session as a working copy, with a task that ends
 * in a real diff. It is a real bug in real code, so what the agent does is what it would do on yours.
 */

export const SAMPLE_TITLE = "Try Friday · sample project";

/** A lesson filed from the sample project: about a toy repo, not the person's code, so it is neither recalled nor suggested. */
export const fromSample = (text: string): boolean => text.endsWith(`(from “${SAMPLE_TITLE}”)`);

export const SAMPLE_TASK = `Bug report from the README: titles longer than 60 characters come out one letter short after slugify.

Find the cause in src/slugify.ts and fix it. Add a test to test/slugify.test.ts that would have caught it. Then say in a few lines what you changed, and which code in this project still has no tests.`;

/** Added to a task somebody wrote themselves, so the agent knows what it is looking at. */
export const SAMPLE_NOTE = "(This is Friday's sample project, attached as a working copy: linklist, a small TypeScript bookmarks service. Its README lists a known bug in src/slugify.ts, and src/parse.ts and src/format.ts have no tests.)";

export interface SampleFile {
  path: string;
  data: Buffer;
}

let cached: SampleFile[] | null = null;

/** Where the sample lives: the repo's own folder, or the copy beside a bundled server. */
async function findSample(): Promise<string> {
  const candidates = [path.resolve("sample"), fileURLToPath(new URL("../sample", import.meta.url)), fileURLToPath(new URL("./sample", import.meta.url))];
  for (const c of candidates) if (await access(c).then(() => true, () => false)) return c;
  throw new Error("The sample project isn't on this server.");
}

/** Every file in the sample, read once. */
export async function loadSample(root?: string): Promise<SampleFile[]> {
  if (cached) return cached;
  root ??= await findSample();
  const out: SampleFile[] = [];
  const base = root;
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push({ path: path.relative(base, full).split(path.sep).join("/"), data: await readFile(full) });
    }
  };
  await walk(root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  cached = out;
  return out;
}
