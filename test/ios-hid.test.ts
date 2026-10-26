import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { frameworksOf } from "../src/runner/ios-hid.js";

/** The touch helper is compiled against the frameworks of whichever AXe the runner uses (2026-10-20). */
test("the touch helper finds AXe's frameworks beside the app's copy and in Homebrew's libexec", () => {
  // Its real path: the frameworks are found from where the axe executable really is (/var is /private/var on a Mac).
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "friday-axe-")));
  try {
    // Inside the Mac app: Resources/axe/axe with Frameworks beside it.
    const app = path.join(root, "app", "axe");
    mkdirSync(path.join(app, "Frameworks", "FBSimulatorControl.framework"), { recursive: true });
    writeFileSync(path.join(app, "axe"), "");
    assert.equal(frameworksOf(path.join(app, "axe")), path.join(app, "Frameworks"));
    // Homebrew: bin/axe (a link to Cellar/axe/<v>/bin/axe, a script) with the frameworks in libexec.
    const cellar = path.join(root, "Cellar", "axe", "1.8.0");
    mkdirSync(path.join(cellar, "bin"), { recursive: true });
    mkdirSync(path.join(cellar, "libexec", "Frameworks", "FBSimulatorControl.framework"), { recursive: true });
    writeFileSync(path.join(cellar, "bin", "axe"), "#!/bin/bash\n");
    mkdirSync(path.join(root, "bin"));
    symlinkSync(path.join(cellar, "bin", "axe"), path.join(root, "bin", "axe"));
    assert.equal(path.resolve(frameworksOf(path.join(root, "bin", "axe"))!), path.join(cellar, "libexec", "Frameworks"));
    // An axe with no frameworks anywhere: no helper, input goes through AXe itself.
    writeFileSync(path.join(root, "axe"), "");
    assert.equal(frameworksOf(path.join(root, "axe")), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
