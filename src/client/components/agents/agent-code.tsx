"use client";

import {
  type CSSProperties,
  Fragment,
  memo,
  useEffect,
  useState,
} from "react";
// Only the type here: the highlighter itself is fetched the first time some code is coloured, so it is not part of what
// every window downloads and parses before it can draw anything.
import type { Highlighter } from "shiki";
import { cn } from "@/lib/utils";

export type AgentCodeLanguage =
  | "bash"
  | "c"
  | "cpp"
  | "csharp"
  | "css"
  | "diff"
  | "go"
  | "html"
  | "java"
  | "json"
  | "kotlin"
  | "markdown"
  | "php"
  | "python"
  | "ruby"
  | "rust"
  | "sql"
  | "swift"
  | "text"
  | "toml"
  | "tsx"
  | "typescript"
  | "xml"
  | "yaml";

export interface AgentCodeToken {
  content: string;
  offset: number;
  light?: string;
  dark?: string;
}

export type AgentCodeTokenLines = AgentCodeToken[][];

export interface AgentCodeProps {
  code: string;
  language?: AgentCodeLanguage;
  className?: string;
}

export interface AgentCodeLineProps {
  code: string;
  tokens?: AgentCodeToken[];
  className?: string;
}

const LIGHT_THEME = "github-light-high-contrast";
const DARK_THEME = "github-dark-high-contrast";
let agentCodeHighlighter: Promise<Highlighter> | null = null;
const loadedLanguages = new Map<string, Promise<unknown>>();
const tokenCache = new Map<string, AgentCodeTokenLines>();
// Every version of a file being typed in is a key of its own, so the cache keeps the most recent few rather than all of them.
const TOKEN_CACHE_MAX = 50;

/**
 * The code blocks in Markdown are coloured in their own language, but only one whose grammar is already loaded. These are
 * the names (and their aliases) of the grammars the highlighter used to start with, the languages a person writes and the
 * ones those bring along, so a README's ```ts block is coloured as it always was.
 */
const FENCED = new Set(
  ("bash c cpp csharp css diff go html java json kotlin markdown php python ruby rust sql swift toml tsx typescript xml yaml " +
    "shellscript javascript jsx graphql lua haml glsl regexp sh shell zsh md c++ c# cs js cjs mjs kt kts py ts cts mts gql yml rb rs").split(" "),
);
const fencedIn = (code: string) => [...code.matchAll(/^[ \t]*(?:```|~~~)[ \t]*([\w#+-]+)/gm)].map((m) => m[1]!.toLowerCase()).filter((l) => FENCED.has(l));

// The highlighter starts with no grammars, and each language is loaded the first time something in it is shown. Starting
// with all twenty-three meant one README diff downloaded and compiled C++, PHP and Swift too, a long pause on opening a session.
function getAgentCodeHighlighter(language: AgentCodeLanguage, code: string): Promise<Highlighter> {
  if (!agentCodeHighlighter) {
    agentCodeHighlighter = import("shiki").then(({ createHighlighter }) => createHighlighter({
      themes: [LIGHT_THEME, DARK_THEME],
      langs: [],
    }));
  }
  const highlighter = agentCodeHighlighter;
  // Plain text has no grammar to load.
  const wanted = language === "text" ? [] : language === "markdown" ? [language, ...fencedIn(code)] : [language];
  return Promise.all(
    wanted.map((lang) => {
      let ready = loadedLanguages.get(lang);
      if (!ready) {
        ready = highlighter.then((h) => h.loadLanguage(lang as AgentCodeLanguage));
        loadedLanguages.set(lang, ready);
      }
      return ready;
    }),
  ).then(() => highlighter);
}

function tokenCacheKey(code: string, language: AgentCodeLanguage) {
  return `${language}\u0000${code}`;
}

export function useAgentCodeTokens(
  code: string,
  language: AgentCodeLanguage,
) {
  const key = tokenCacheKey(code, language);
  const cached = tokenCache.get(key);
  const [result, setResult] = useState<{
    key: string;
    code: string;
    language: AgentCodeLanguage;
    lines: AgentCodeTokenLines;
  } | null>(cached ? { key, code, language, lines: cached } : null);

  useEffect(() => {
    const current = tokenCache.get(key);
    if (current) {
      setResult({ key, code, language, lines: current });
      return;
    }

    let cancelled = false;
    getAgentCodeHighlighter(language, code).then((highlighter) => {
      if (cancelled) return;
      const lines = highlighter
        .codeToTokensWithThemes(code, {
          lang: language,
          themes: {
            light: LIGHT_THEME,
            dark: DARK_THEME,
          },
        })
        .map((line) =>
          line.map((token) => ({
            content: token.content,
            offset: token.offset,
            light: token.variants.light?.color,
            dark: token.variants.dark?.color,
          })),
      );
      tokenCache.set(key, lines);
      // A Map keeps the order things went in, so the first key is the oldest.
      if (tokenCache.size > TOKEN_CACHE_MAX) tokenCache.delete(tokenCache.keys().next().value!);
      setResult({ key, code, language, lines });
    });
    return () => {
      cancelled = true;
    };
  }, [code, key, language]);

  if (result?.key === key) return result.lines;
  if (result?.language === language && code.startsWith(result.code)) {
    return result.lines;
  }
  return null;
}

// Memoised: a file is hundreds of these, and a keystroke changes one of them.
export const AgentCodeLine = memo(function AgentCodeLine({
  code,
  tokens,
  className,
}: AgentCodeLineProps) {
  return (
    <span className={className}>
      {tokens
        ? tokens.map((token) => (
            <span
              key={`${token.offset}-${token.content}`}
              style={
                {
                  "--agent-code-light": token.light ?? "currentColor",
                  "--agent-code-dark": token.dark ?? token.light ?? "currentColor",
                } as CSSProperties
              }
              className="text-[var(--agent-code-light)] dark:text-[var(--agent-code-dark)]"
            >
              {token.content}
            </span>
          ))
        : code}
    </span>
  );
});

export function AgentCode({
  code,
  language = "bash",
  className,
}: AgentCodeProps) {
  const tokens = useAgentCodeTokens(code, language);
  let offset = 0;
  const lines = code.split("\n").map((content) => {
    const line = { content, offset };
    offset += content.length + 1;
    return line;
  });

  return (
    <pre
      className={cn(
        "m-0 overflow-x-auto whitespace-pre font-mono text-xs leading-5 text-foreground/85",
        className,
      )}
    >
      <code>
        {lines.map((line, index) => (
          <Fragment key={line.offset}>
            <AgentCodeLine code={line.content} tokens={tokens?.[index]} />
            {index < lines.length - 1 ? "\n" : null}
          </Fragment>
        ))}
      </code>
    </pre>
  );
}
