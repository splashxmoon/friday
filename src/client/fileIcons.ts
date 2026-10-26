import { createElement } from "react";

/**
 * The icon for a file, by what it is: the language's own mark for code, the tool's for its config, a plain document for the
 * rest. The marks are the Material Icon Theme's (public/file-icons, MIT), the ones people know from their editor, so a changed
 * file reads at a glance as "the React component" or "the Next config" rather than as a letter and a name.
 */

/** Whole names first: a tool's config file is that tool's, whatever its extension. */
const BY_NAME: [RegExp, string][] = [
  [/^package\.json$/i, "nodejs"],
  [/^(package-lock\.json|\.npmrc)$/i, "npm"],
  [/^(yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock)$/i, "lock"],
  [/^tsconfig(\..+)?\.json$|\.tsbuildinfo$/i, "tsconfig"],
  [/^(\.eslintrc(\..+)?|eslint\.config\..+)$/i, "eslint"],
  [/^(\.prettierrc(\..+)?|prettier\.config\..+)$/i, "prettier"],
  [/^vite\.config\..+$/i, "vite"],
  [/^next\.config\..+$|^next-env\.d\.ts$/i, "next"],
  [/^tailwind\.config\..+$/i, "tailwindcss"],
  [/^(Dockerfile|docker-compose(\..+)?\.ya?ml|\.dockerignore)$/i, "docker"],
  [/^\.git(ignore|attributes|modules|keep)$/i, "git"],
  [/^\.env(\..+)?$/i, "tune"],
  [/^readme(\..+)?$/i, "readme"],
  [/^(licen[cs]e|copying)(\..+)?$/i, "certificate"],
  [/^\.editorconfig$|^.*\.config\.(js|cjs|mjs|ts)$/i, "settings"],
];

const BY_EXT: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  jsx: "react",
  tsx: "react_ts",
  json: "json",
  jsonc: "json",
  json5: "json",
  md: "markdown",
  mdx: "markdown",
  css: "css",
  scss: "sass",
  sass: "sass",
  html: "html",
  htm: "html",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  rb: "ruby",
  php: "php",
  sh: "console",
  bash: "console",
  zsh: "console",
  bat: "console",
  cmd: "console",
  ps1: "powershell",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "database",
  svg: "svg",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  ico: "image",
  lock: "lock",
  c: "c",
  cpp: "cpp",
  cc: "cpp",
  h: "h",
  hpp: "hpp",
  cs: "csharp",
  swift: "swift",
  dart: "dart",
  vue: "vue",
  svelte: "svelte",
  prisma: "prisma",
  graphql: "graphql",
  gql: "graphql",
  xml: "xml",
  txt: "document",
  zig: "zig",
  ex: "elixir",
  exs: "elixir",
  scala: "scala",
  hs: "haskell",
  lua: "lua",
  pl: "perl",
  r: "r",
  m: "matlab",
  ttf: "font",
  otf: "font",
  woff: "font",
  woff2: "font",
  mp4: "video",
  webm: "video",
  mov: "video",
  mp3: "audio",
  wav: "audio",
  pdf: "pdf",
  zip: "zip",
  gz: "zip",
  tgz: "zip",
  tar: "zip",
};

/** The icon's name for a path: the file's whole name first, then its extension; "document" for anything else. */
export function fileIconName(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  for (const [re, icon] of BY_NAME) if (re.test(name)) return icon;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return (ext && BY_EXT[ext]) || "document";
}

export const fileIconSrc = (path: string) => `/file-icons/${fileIconName(path)}.svg`;

/** The mark for a file, beside its name. Decoration only: the name says what the file is. */
export function FileIcon({ path, size = 16, className = "" }: { path: string; size?: number; className?: string }) {
  return createElement("img", { className: `file-icon ${className}`.trim(), src: fileIconSrc(path), width: size, height: size, alt: "", "aria-hidden": true, draggable: false });
}
