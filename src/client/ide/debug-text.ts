// What a stop in the debugger asks of the agent (Arun, 2026-11-19: "Debug with the agent: when you stop at a breakpoint or an
// exception, the agent sees the stack and the variables and tells you what's wrong, or fixes it."). The first line is the chat's
// name in its tab: "Debug refunds.ts:8". With no stop (the person said what goes wrong) it asks the agent to reproduce it first.

interface Stop {
  path: string;
  from: number;
  to: number;
  text: string;
  line?: number;
  problem?: string;
  source?: string;
  reason?: string;
  reproduce?: boolean;
  stack?: { name: string; path: string; line: number }[];
  vars?: { name: string; value: string; type?: string; scope?: string }[];
}

const WHY: Record<string, string> = {
  exception: "an exception",
  breakpoint: "a breakpoint",
  "data breakpoint": "a data breakpoint",
  "function breakpoint": "a function breakpoint",
  pause: "a pause",
  step: "a step",
  entry: "the start of the program",
};

export function debugText(a: Stop): string {
  const file = a.path ? a.path.split(/[\\/]/).pop() : "";
  // A fence longer than any run of backticks inside, so an error that echoes a ``` line cannot close it and pass for the person's words.
  const fence = (s: string) => {
    const f = "`".repeat(Math.max(3, ...(s.match(/`+/g) ?? []).map((r) => r.length + 1)));
    return `${f}\n${s.replace(/\n+$/, "")}\n${f}`;
  };

  if (a.reproduce) {
    const title = a.problem ? `Debug: ${a.problem.split("\n")[0].slice(0, 48)}${a.problem.length > 48 ? "…" : ""}` : `Debug ${file || "this"}`;
    const near = a.path && a.text ? `\n\nThe code I had open, \`${a.path}:${a.from}–${a.to}\`:\n${fence(a.text)}` : a.path ? `\n\nI had \`${a.path}\` open.` : "";
    return `${title}

Here is what goes wrong, in my words:
${fence(a.problem || "")}${near}

Reproduce it first: find how it is run here (the project's scripts and tests), and use the launch configuration in \`.vscode/launch.json\` if there is one, or add one if not, so I can run it under the debugger with F5. Run it yourself to see it fail, find the cause and say it in a line or two. Fix it only if the cause is clear, add a test that would have caught it, and tell me how to run it again in the debugger.
`;
  }

  const why = WHY[a.reason ?? ""] ?? (a.reason ? `a stop (${a.reason})` : "a stop");
  const at = a.path ? `${a.path}:${a.line ?? a.from}` : "";
  const title = `Debug ${at ? at.split(/[\\/]/).pop() : "the stop"}`;
  const said = a.problem ? `\n\nWhat the debugger said:\n${fence(a.problem)}` : "";
  const stack = a.stack?.length ? `\n\nThe stack, innermost first:\n${fence(a.stack.map((f, i) => `#${i} ${f.name}${f.path ? `  ${f.path}${f.line ? `:${f.line}` : ""}` : ""}`).join("\n"))}` : "";
  const vars = a.vars?.length ? `\n\nThe variables in that frame:\n${fence(a.vars.map((v) => `${v.name} = ${v.value}${v.type ? `  (${v.type})` : ""}`).join("\n"))}` : "";
  const code = a.path && a.text ? `\n\nThe code at the stop, \`${a.path}:${a.from}–${a.to}\` (the stopped line is marked >):\n${fence(a.text)}` : "";
  return `${title}

My program is stopped in the debugger on ${why}${at ? `, at \`${at}\`` : ""}. Read the stack and the variables below and tell me what is wrong: the likely cause, the line it comes from, and the fix you would make. The program is paused as it is, so you do not need to run it again to see this. Fix it only if the cause is clear; if it is a guess, say so and ask me before changing anything. When you have fixed it, say how to run it again (the debugger's Restart, or F5).${said}${stack}${vars}${code}
`;
}
