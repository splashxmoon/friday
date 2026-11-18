/**
 * An agent's own test page: a harness it wrote to check its work in a browser, printing PASS and FAIL lines (Arun, 2026-11-18: a
 * Preview showing a `…check.html` page of "PASS Select same type… FAIL palette finds…": "fix this, dont make this appear", "still
 * have the agent have browser control i just dont want those logs there"). Such a page opens out of the person's sight: the agent
 * still drives it (browser-driver.ts), and it never comes up in the Preview by itself or by show_preview.
 *
 * Known by its name: a file called check, test, spec, harness or selftest, or starting or ending so (`check.html`, `kiln-check.html`,
 * `test-rename.html`, `pqcheck.html`), or a page under a tests folder (`/__tests__/`, `/test/`, `/e2e/`). Not a page that only has
 * the word inside another (`checkout.html`, `latest.html`, `contest.html`).
 */
const ENDS = /(?:check|checks|harness|selftest|specs?|(?:^|[^a-z])tests?)\.html?$/i;
const STARTS = /^(?:check|checks|test|tests|spec|specs|harness|selftest)[-_.][\w.-]*\.html?$/i;
const FOLDER = /\/(?:__tests__|tests?|e2e|checks?|harness|selftest)\//i;

export function testPage(url: string): boolean {
  let path = "";
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return false;
  }
  const file = path.slice(path.lastIndexOf("/") + 1);
  return ENDS.test(file) || STARTS.test(file) || FOLDER.test(path);
}
