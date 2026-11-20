import { test } from "node:test";
import assert from "node:assert/strict";
import { hasUiChange, isUiFile, mergeErrors, MAX_PAGES, oneError, pagesFor, routeOf, type Layout } from "../src/preview-check.js";

const layout = (deps: string[] = [], has: string[] = []): Layout => ({ deps: new Set(deps), has: (p) => has.includes(p) });
const next = layout(["next", "react"], ["app/layout.tsx"]);
const nextSrc = layout(["next"], ["src/app/layout.tsx"]);
const vite = layout(["vite", "react", "react-router-dom"]);

test("only files that draw something count", () => {
  assert.ok(isUiFile("src/Button.tsx"));
  assert.ok(isUiFile("styles/site.css"));
  assert.ok(isUiFile("index.html"));
  assert.ok(!isUiFile("src/server.ts"));
  assert.ok(!isUiFile("src/Button.test.tsx"));
  assert.ok(!isUiFile("src/Button.stories.tsx"));
  assert.ok(!isUiFile("e2e/home.spec.ts"));
  assert.ok(hasUiChange([{ path: "a.tsx", status: "modified" }]));
  assert.ok(!hasUiChange([{ path: "a.tsx", status: "deleted" }]));
  assert.ok(!hasUiChange([{ path: "a.ts" }, { path: "README.md" }]));
});

test("Next app router: pages, layouts and groups", () => {
  assert.equal(routeOf("app/page.tsx", next), "/");
  assert.equal(routeOf("app/about/page.tsx", next), "/about");
  assert.equal(routeOf("app/(marketing)/pricing/page.tsx", next), "/pricing");
  assert.equal(routeOf("app/dashboard/layout.tsx", next), "/dashboard");
  assert.equal(routeOf("app/layout.tsx", next), "/");
  assert.equal(routeOf("src/app/blog/page.jsx", nextSrc), "/blog");
  // Dynamic and slot segments have no address of their own.
  assert.equal(routeOf("app/posts/[id]/page.tsx", next), null);
  assert.equal(routeOf("app/@modal/login/page.tsx", next), null);
  // A component inside app/ is no page.
  assert.equal(routeOf("app/components/Nav.tsx", next), null);
  assert.equal(routeOf("components/Nav.tsx", next), null);
});

test("Next pages router, Nuxt and Astro", () => {
  const p = layout(["next"]);
  assert.equal(routeOf("pages/index.tsx", p), "/");
  assert.equal(routeOf("pages/about.tsx", p), "/about");
  assert.equal(routeOf("pages/blog/index.tsx", p), "/blog");
  assert.equal(routeOf("pages/blog/[slug].tsx", p), null);
  assert.equal(routeOf("pages/_app.tsx", p), null);
  assert.equal(routeOf("pages/api/hello.ts", p), null);
  assert.equal(routeOf("src/pages/Pricing.astro", layout(["astro"])), "/pricing");
  assert.equal(routeOf("pages/contact-us.vue", layout(["nuxt"])), "/contact-us");
});

test("Vite apps and SvelteKit: nothing guessed without a file router, nothing from components", () => {
  // A Vite app's src/pages and src/routes are components its own router lists: any page, so no path of their own.
  assert.equal(routeOf("src/pages/Home.tsx", vite), null);
  assert.equal(routeOf("src/pages/AboutUs.tsx", vite), null);
  assert.equal(routeOf("src/routes/settings.tsx", vite), null);
  assert.equal(routeOf("src/views/UserProfile.vue", layout(["vue", "vue-router"])), null);
  const kit = layout(["@sveltejs/kit"]);
  assert.equal(routeOf("src/routes/about/+page.svelte", kit), "/about");
  assert.equal(routeOf("src/routes/+layout.svelte", kit), "/");
  assert.equal(routeOf("src/components/Button.tsx", vite), null);
  assert.equal(routeOf("src/App.css", vite), null);
});

test("file routers: only page-like files with plain names are routes", () => {
  const n = layout(["next"]);
  assert.equal(routeOf("src/pages/Home.module.css", n), null);
  assert.equal(routeOf("src/pages/about/styles.css", n), null);
  assert.equal(routeOf("src/pages/components/Card.tsx", n), null);
  assert.equal(routeOf("pages/partials/Head.tsx", n), null);
  assert.equal(routeOf("pages/Home.module.tsx", n), null);
  const remix = layout(["@remix-run/react"]);
  assert.equal(routeOf("src/routes/posts.$postId.tsx", remix), null);
  assert.equal(routeOf("src/routes/index.lazy.tsx", layout(["@tanstack/react-router"])), null);
  assert.equal(routeOf("src/routes/posts.tsx", remix), "/posts");
  assert.equal(routeOf("src/pages/about.tsx", n), "/about");
});

test("plain sites: an html file at the root or in public/ is its own address, no other", () => {
  const s = layout();
  assert.equal(routeOf("index.html", s), "/");
  assert.equal(routeOf("about.html", s), "/about.html");
  assert.equal(routeOf("public/pricing.html", s), "/pricing.html");
  assert.equal(routeOf("public/docs/index.html", s), "/docs/");
  // Templates, reports and build output are not served at their own paths.
  assert.equal(routeOf("src/app/foo/foo.component.html", s), null);
  assert.equal(routeOf("coverage/lcov-report/index.html", s), null);
  assert.equal(routeOf("templates/email/welcome.html", s), null);
  assert.equal(routeOf("docs/index.html", s), null);
  assert.equal(routeOf("dist/index.html", s), null);
});

test("pages to check: the pages changed, and / when something draws on all of them or nothing is found", () => {
  assert.deepEqual(pagesFor(["app/about/page.tsx"], next), ["/about"]);
  assert.deepEqual(pagesFor(["app/about/page.tsx", "app/pricing/page.tsx"], next), ["/about", "/pricing"]);
  // A component or a stylesheet could be on any page: the home page too.
  assert.deepEqual(pagesFor(["app/about/page.tsx", "components/Nav.tsx"], next), ["/about", "/"]);
  assert.deepEqual(pagesFor(["src/styles.css"], vite), ["/"]);
  // Nothing that draws: still the home page rather than nothing.
  assert.deepEqual(pagesFor(["src/server.ts"], vite), ["/"]);
  assert.deepEqual(pagesFor(["app/page.tsx", "app/page.tsx"], next), ["/"]);
});

test("pages to check: never more than a few, and / is kept", () => {
  const files = ["a", "b", "c", "d", "e", "f"].map((n) => `app/${n}/page.tsx`).concat("components/X.tsx");
  const got = pagesFor(files, next);
  assert.equal(got.length, MAX_PAGES);
  assert.equal(got.at(-1), "/");
  assert.deepEqual(got.slice(0, 3), ["/a", "/b", "/c"]);
});

test("console lines: one line each, shortened, each once", () => {
  assert.equal(oneError("TypeError: x is not a function\n    at foo (a.js:1:2)"), "TypeError: x is not a function");
  assert.equal(oneError("\x1b[31mred\x1b[0m   words"), "red words");
  assert.equal(oneError("x".repeat(500)).length, 240);
  assert.deepEqual(mergeErrors([["a", "b"], ["b", "c"]]), ["a", "b", "c"]);
  assert.equal(mergeErrors([Array.from({ length: 20 }, (_, i) => `e${i}`)]).length, 6);
});

test("pages to check: a pages/ folder without a file router is not a list of routes", () => {
  assert.deepEqual(pagesFor(["src/pages/about/styles.css", "src/pages/Home.module.css"], vite), ["/"]);
  assert.deepEqual(pagesFor(["src/app/foo/foo.component.html"], layout()), ["/"]);
});
