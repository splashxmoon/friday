import assert from "node:assert/strict";
import test from "node:test";
import { pictureAbs, rehypePicturePaths } from "../src/client/answer-format.js";

/** A picture's path in an agent's words (not in backticks) is shown as the picture under its name (answer-format.ts). */
type N = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: N[] };
const para = (...children: N[]): N => ({ type: "root", children: [{ type: "element", tagName: "p", children }] });
const text = (value: string): N => ({ type: "text", value });
const pictures = (tree: N): string[] => {
  const out: string[] = [];
  const walk = (n: N) => {
    if (n.tagName === "code" && n.properties?.dataPicture) out.push(n.children![0]!.value!);
    n.children?.forEach(walk);
  };
  walk(tree);
  return out;
};
const after = (tree: N): string[] => {
  const out: string[] = [];
  const walk = (n: N) => {
    if (n.tagName === "code" && n.properties?.dataPicture) out.push((n.properties.dataAfter as string) ?? "");
    n.children?.forEach(walk);
  };
  walk(tree);
  return out;
};
const run = (tree: N) => (rehypePicturePaths()(tree as never), tree);

test("picture paths in the words are found, with the punctuation after them left as words", () => {
  const t = run(para(text("Saved to docs/shot.png. The logo is logo.svg, and the old one ~/shots/a.webp; also C:\\shots\\b.jpg!")));
  assert.deepEqual(pictures(t), ["docs/shot.png", "logo.svg", "~/shots/a.webp", "C:\\shots\\b.jpg"]);
  assert.deepEqual(after(t), [".", ",", ";", ""]);
  // The words around them are all still there, in order.
  // The punctuation after a picture goes with it, to be said again if no picture shows.
  const said = (n: N): string => n.value ?? `${n.children?.map(said).join("") ?? ""}${(n.properties?.dataAfter as string) ?? ""}`;
  assert.equal(said(t), "Saved to docs/shot.png. The logo is logo.svg, and the old one ~/shots/a.webp; also C:\\shots\\b.jpg!");
});

test("not in links or code, not a web address, not a bare extension", () => {
  const t = run({ type: "root", children: [{ type: "element", tagName: "a", children: [text("docs/a.png")] }, { type: "element", tagName: "code", children: [text("b.png")] }, text("Export as .png or example.com/c.png or ../up.png, PNG files.")] });
  assert.deepEqual(pictures(t), []);
});

test("a whole path on a computer to a picture, and nothing else, is shown from where it is", () => {
  for (const p of ["/Users/a/.friday/shots/tool-1.png", "~/Desktop/x.svg", "C:\\Users\\a\\x.jpeg", "file:///tmp/a.gif"]) assert.ok(pictureAbs(p), p);
  for (const p of ["docs/a.png", "/Users/a/notes.md", "/Users/a/my shot.png", "/etc/passwd"]) assert.ok(!pictureAbs(p), p);
});

test("a picture named in backticks takes the punctuation after it too, and code that isn't a picture keeps its own", () => {
  const code = (v: string): N => ({ type: "element", tagName: "code", children: [text(v)] });
  const t = run(para(text("The logo is "), code("docs/logo.svg"), text(". Run "), code("npm test"), text(".")));
  const p = t.children![0]!.children!;
  assert.equal(p[2]!.value, " Run ");
  assert.equal(p[4]!.value, ".");
});
