import assert from "node:assert/strict";
import test from "node:test";
import { isDark, tokenColours, vscodeTheme } from "../src/client/theme.js";

const NIGHT = {
  name: "Night Owl",
  type: "dark",
  colors: {
    "editor.background": "#011627",
    "editor.foreground": "#d6deeb",
    "sideBar.background": "#011627",
    "button.background": "#7e57c2",
    "button.foreground": "#ffffff",
    "list.hoverBackground": "#0b2942",
    "descriptionForeground": "#5f7e97",
    "editorGroup.border": "#122d42",
    "gitDecoration.addedResourceForeground": "#addb67",
    "errorForeground": "#ef5350",
    "editorWarning.foreground": "#ecc48d",
    "editor.selectionBackground": "#1d3b53aa",
  },
  tokenColors: [
    { scope: "comment, punctuation.definition.comment", settings: { foreground: "#637777", fontStyle: "italic" } },
    { scope: ["string", "string.quoted"], settings: { foreground: "#ecc48d" } },
    { scope: "keyword", settings: { foreground: "#c792ea" } },
    { scope: "constant.numeric", settings: { foreground: "#f78c6c" } },
    { scope: "entity.name.function", settings: { foreground: "#82aaff" } },
    { scope: "entity.name.type", settings: { foreground: "#ffcb8b" } },
    { scope: "variable", settings: {} },
  ],
};

test("Themes: a VS Code theme becomes Friday's tokens, dark or light by its type or its background, with what it doesn't say derived", () => {
  const t = vscodeTheme(NIGHT)!;
  assert.equal(t.name, "Night Owl");
  assert.equal(t.dark, true);
  assert.equal(t.vars["--bg"], "#011627");
  assert.equal(t.vars["--ink"], "#d6deeb");
  assert.equal(t.vars["--accent"], "#7e57c2");
  assert.equal(t.vars["--on-accent"], "#ffffff");
  assert.equal(t.vars["--hover"], "#0b2942");
  assert.equal(t.vars["--text-muted"], "#5f7e97");
  assert.equal(t.vars["--border"], "#122d42");
  assert.equal(t.vars["--green"], "#addb67");
  assert.equal(t.vars["--red"], "#ef5350");
  assert.equal(t.vars["--amber"], "#ecc48d");
  assert.match(t.vars["--panel"]!, /^color-mix\(/, "a panel colour the theme didn't give is a step from the background");
  assert.equal(t.vars["--code-bg"], "#011627");
  // A light theme told apart by its background when it says no type; an alpha byte is dropped; short hex is widened.
  const light = vscodeTheme({ colors: { "editor.background": "#fffffff0", "editor.foreground": "#333" } })!;
  assert.equal(light.dark, false);
  assert.equal(light.vars["--bg"], "#ffffff");
  assert.equal(light.vars["--ink"], "#333333");
  assert.equal(light.name, "Imported theme");
  assert.ok(isDark("#011627") && !isDark("#fafafa"));
  // Not a theme: no colours, or no background.
  assert.equal(vscodeTheme({ name: "x" }), null);
  assert.equal(vscodeTheme({ colors: { foreground: "#000" } }), null);
  assert.equal(vscodeTheme("nope"), null);
});

test("Themes: token colours come from the first rule naming each scope, scopes as a list or comma-separated, rules without a colour skipped", () => {
  const c = tokenColours(NIGHT.tokenColors);
  assert.equal(c.comment, "#637777");
  assert.equal(c.string, "#ecc48d");
  assert.equal(c.keyword, "#c792ea");
  assert.equal(c.number, "#f78c6c");
  assert.equal(c.fn, "#82aaff");
  assert.equal(c.type, "#ffcb8b");
  assert.equal(c.variable, undefined);
  assert.deepEqual(tokenColours(undefined), {});
});
