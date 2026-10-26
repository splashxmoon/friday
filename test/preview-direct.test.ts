import assert from "node:assert/strict";
import test from "node:test";
import { loadsDirectly } from "../src/client/Preview.js";

/**
 * A blank Preview for a Vite project: the page was fetched through Friday's
 * proxy, where "/src/main.jsx" is looked for at the root of Friday, not of the
 * dev server. In the desktop app the machine is this computer, so none of that
 * is needed.
 */
test("the desktop app opens the dev server itself when the linked machine is this computer", () => {
  assert.equal(loadsDirectly({ mode: "linked", protocol: "https:", desktop: true, ownMachine: true }), true);
});

test("it goes through Friday for somebody else's machine, or from a plain browser", () => {
  assert.equal(loadsDirectly({ mode: "linked", protocol: "https:", desktop: true, ownMachine: false }), false, "a different computer");
  assert.equal(loadsDirectly({ mode: "linked", protocol: "https:", desktop: false, ownMachine: true }), false, "a browser cannot reach another computer's localhost");
  assert.equal(loadsDirectly({ mode: "none", protocol: "https:", desktop: true, ownMachine: true }), false);
});

test("a Friday running on this machine still opens it directly, over http only", () => {
  assert.equal(loadsDirectly({ mode: "local", protocol: "http:", desktop: false, ownMachine: false }), true);
  assert.equal(loadsDirectly({ mode: "local", protocol: "https:", desktop: false, ownMachine: false }), false);
});
