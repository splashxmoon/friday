// What an action above a function asks of the agent (Arun, 2026-11-19: "Inline actions above functions: Explain · Test · Fix ·
// Refactor, one click with the code attached."). The first line is the chat's name in its tab: "Explain partialRefund".

interface Lens {
  kind?: string;
  path: string;
  from: number;
  to: number;
  text: string;
  symbol?: string;
  symbolKind?: string;
}

const LABEL: Record<string, string> = { explain: "Explain", test: "Test", fix: "Fix", refactor: "Refactor" };

export function actionText(a: Lens): string {
  const kind = a.kind && LABEL[a.kind] ? a.kind : "explain";
  const name = a.symbol || `${a.path.split("/").pop()}:${a.from}`;
  const what = a.symbolKind === "class" ? "class" : a.symbolKind === "method" ? "method" : "function";
  const it = `\`${name}\``;
  const ask: Record<string, string> = {
    explain: `Explain the ${what} ${it}: what it does, where it is used and how, and anything that could trip someone up (edge cases, hidden assumptions, side effects). Don't change anything.`,
    test: `Write tests for the ${what} ${it}, covering what it is meant to do and its edge cases (empty and extreme inputs, errors, anything a caller could get wrong). Put them in the nearest existing test file and use the framework the project already uses, then run them and fix any that fail for a wrong test.`,
    fix: `Look for bugs in the ${what} ${it}: wrong results, unhandled cases, mistakes a caller would hit. Reproduce each one you find, fix the cause, add a test that would have caught it, and run the tests. Say what was wrong in a line or two. If there is nothing wrong, say so and change nothing.`,
    refactor: `Refactor the ${what} ${it} so it is clearer and simpler, without changing what it does. Keep its name and signature unless there is a good reason, keep the tests green (run them before and after), and say what you changed.`,
  };
  const code = a.text ? `\n\n\`${a.path}:${a.from}–${a.to}\`\n\`\`\`\n${a.text.replace(/\n$/, "")}\n\`\`\`` : `\n\n\`${a.path}:${a.from}–${a.to}\``;
  return `${LABEL[kind]} ${name}\n\n${ask[kind]}${code}\n`;
}
