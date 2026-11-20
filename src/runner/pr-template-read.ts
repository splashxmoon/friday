import { readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import type { PrParts } from "../pr-body.js";
import { TEMPLATE_PATHS, fillPrTemplate } from "../pr-template.js";

/**
 * The repo's pull-request template, read on the computer the repo is on and filled from the session's parts (pr-template.ts).
 * Never fails a pull request: no template, an unreadable one or parts that don't parse leave the body as it was.
 */
const top = (cwd: string) =>
  new Promise<string>((ok) => execFile("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 10_000, windowsHide: true }, (e, out) => ok(e ? cwd : String(out).trim() || cwd)));

export async function templateOf(cwd: string): Promise<string | null> {
  const root = await top(cwd);
  for (const rel of TEMPLATE_PATHS) {
    const text = await readFile(path.join(root, ...rel.split("/")), "utf8").catch(() => "");
    if (text.trim()) return text.slice(0, 20_000);
  }
  return null;
}

export async function templatedBody(cwd: string, body: string, partsJson?: string): Promise<string> {
  if (!partsJson) return body;
  try {
    const template = await templateOf(cwd);
    if (!template) return body;
    const parts = JSON.parse(partsJson) as PrParts;
    return fillPrTemplate(template, parts, body);
  } catch {
    return body;
  }
}
