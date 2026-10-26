// The icon a file gets beside its name (fileIcons.ts): a tool's config file is the tool's, code is its language's, the rest a document.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { fileIconName, fileIconSrc } from "../src/client/fileIcons.js";

test("a file's icon: by its whole name first, then its extension, then a plain document", () => {
  assert.equal(fileIconName("next.config.mjs"), "next", "a tool's config before its .mjs");
  assert.equal(fileIconName("src/components/Header.jsx"), "react");
  assert.equal(fileIconName("src/client/Activity.tsx"), "react_ts");
  assert.equal(fileIconName("tsconfig.tsbuildinfo"), "tsconfig");
  assert.equal(fileIconName("tsconfig.build.json"), "tsconfig");
  assert.equal(fileIconName("package.json"), "nodejs");
  assert.equal(fileIconName("package-lock.json"), "npm");
  assert.equal(fileIconName("pnpm-lock.yaml"), "lock");
  assert.equal(fileIconName("vite.config.ts"), "vite");
  assert.equal(fileIconName("tailwind.config.js"), "tailwindcss");
  assert.equal(fileIconName("playwright.config.ts"), "settings", "any other tool's config reads as settings");
  assert.equal(fileIconName("Dockerfile"), "docker");
  assert.equal(fileIconName(".env.local"), "tune");
  assert.equal(fileIconName(".gitignore"), "git");
  assert.equal(fileIconName("README.md"), "readme");
  assert.equal(fileIconName("LICENSE"), "certificate");
  assert.equal(fileIconName("src/app.ts"), "typescript");
  assert.equal(fileIconName("lib/cart.py"), "python");
  assert.equal(fileIconName("public/style.css"), "css");
  assert.equal(fileIconName("docs/notes.txt"), "document");
  assert.equal(fileIconName("Makefile"), "document", "nothing known: a document");
  assert.equal(fileIconName("C:\\repo\\src\\main.go"), "go", "a Windows path");
  assert.equal(fileIconSrc("a.rs"), "/file-icons/rust.svg");
});

test("every icon a file can be given is on disk", () => {
  const have = new Set(readdirSync(new URL("../public/file-icons/", import.meta.url)).filter((f) => f.endsWith(".svg")).map((f) => f.slice(0, -4)));
  const names = ["next.config.mjs", "a.jsx", "a.tsx", "tsconfig.json", "package.json", "package-lock.json", "yarn.lock", "vite.config.ts", "tailwind.config.js", "x.config.js", "Dockerfile", ".env", ".gitignore", "README.md", "LICENSE", "a.js", "a.ts", "a.json", "a.md", "a.css", "a.scss", "a.html", "a.py", "a.go", "a.rs", "a.java", "a.kt", "a.rb", "a.php", "a.sh", "a.ps1", "a.yml", "a.toml", "a.sql", "a.svg", "a.png", "a.lock", "a.c", "a.cpp", "a.h", "a.hpp", "a.cs", "a.swift", "a.dart", "a.vue", "a.svelte", "a.prisma", "a.graphql", "a.xml", "a.txt", "a.zig", "a.ex", "a.scala", "a.hs", "a.lua", "a.pl", "a.r", "a.m", "a.ttf", "a.mp4", "a.mp3", "a.pdf", "a.zip", "Makefile"];
  for (const n of names) assert.ok(have.has(fileIconName(n)), `${n} → ${fileIconName(n)}.svg`);
});
