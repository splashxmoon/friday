import assert from "node:assert/strict";
import test from "node:test";
import { describePick, POINT_SCRIPT } from "../src/client/point.js";

test("a pick says where it is, what it says and what drew it, so the agent can find the file", () => {
  const text = describePick({
    selector: "#settings > button.primary",
    tag: "button",
    text: "Save changes",
    html: '<button class="primary" type="submit">',
    component: "SaveButton",
    url: "http://localhost:3000/settings?tab=profile",
    width: 120,
    height: 36,
  });
  assert.match(text, /^About this element on \/settings\?tab=profile:/);
  assert.match(text, /selector: `#settings > button\.primary`/);
  assert.match(text, /text: “Save changes”/);
  assert.match(text, /drawn by the SaveButton component/);
  assert.match(text, /```html\n<button class="primary" type="submit">\n```/);
});

test("what the page has no word for is left out rather than invented", () => {
  const text = describePick({ selector: "div", tag: "div", text: "", html: "<div>", url: "not a url", width: 1, height: 1 });
  assert.ok(!/text:|drawn by/.test(text));
  assert.match(text, /^About this element on not a url:/);
});

test("the script sent into the page is a single expression that compiles", () => {
  // It is sent as text, so a stray backtick or bad escape would only show up in somebody's preview.
  assert.doesNotThrow(() => new Function(`return ${POINT_SCRIPT}`));
});
