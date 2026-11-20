// What a "cover" ask says to the agent (Arun, wave 2: "Test generation from coverage: Friday reads your coverage report and writes
// tests for what isn't covered, starting with what changed."). Three kinds, told apart by what the extension (cover.js) sent:
//   a function (symbol): its uncovered lines, in `source`, and its code in `text`;
//   "changed": the uncovered lines inside the git diff, one "file: 3-5, 9" line each in `text`;
//   "run": no report in the folder yet, so the agent finds and runs the project's coverage command.
// The first line is the chat's name in its tab.

interface Cover {
  path: string;
  from: number;
  to: number;
  text: string;
  symbol?: string;
  symbolKind?: string;
  problem?: string;
  source?: string;
}

const HOW = "Use the test framework the project already uses and put each test in the nearest existing test file (a new file beside the others only if there is none), in the style of the tests around it. Test what the code is meant to do, not just that it runs: no test that passes whatever the code does. Run the tests and fix any that fail for a wrong test; if one fails because the code is wrong, don't bend the test: say so and show the bug.";
const AGAIN = "Then run the project's coverage command again so the report is up to date, and say the coverage before and after in a line.";

export function coverText(a: Cover): string {
  if (a.problem === "run") {
    return `Run coverage

${a.source ? `${a.source} ` : "There is no coverage report in this folder yet. "}Find how this project measures test coverage (a script in package.json such as "coverage" or "test:coverage", or its test runner's own flag: jest or vitest with --coverage, pytest with --cov, go test with -coverprofile) and run it. Write the report where Friday reads it: coverage/lcov.info, coverage/coverage-final.json or coverage.xml in the project's folder (lcov, istanbul json or cobertura xml). If the tool needs a setting to write one of those, add it to the project's own config and say so. Only measure it for now, tests come next. Say the overall percentage and the three files with the most lines no test runs.
`;
  }
  if (a.problem === "changed") {
    // Lines "Changed since the report:" and "Not in the report:" are files the report can't speak for; the rest are exact lines.
    const lines = a.text.replace(/\n$/, "").split("\n");
    const unsure = lines.filter((l) => /^(Changed since the report|Not in the report): /.test(l));
    const exact = lines.filter((l) => !unsure.includes(l) && l.trim());
    const first = exact.length
      ? `These are the lines this branch added or changed that no test runs, by file:\n\`\`\`\n${exact.join("\n")}\n\`\`\`\n\n`
      : "";
    const second = unsure.length
      ? `${exact.length ? "Also, " : ""}the coverage report can't speak for these files (they changed after it was made, or no test has ever loaded them):\n\`\`\`\n${unsure.join("\n")}\n\`\`\`\n\nRun the project's coverage command first so the report is current, then find the lines in those files that no test runs and cover those too.\n\n`
      : "";
    return `Cover what changed

${a.source ?? ""}

${first}${second}Write tests for them, starting with the file at the top, so everything that changed is checked by a test. ${HOW} ${AGAIN}
`;
  }
  const name = a.symbol || `${a.path.split("/").pop()}:${a.from}`;
  const what = a.symbolKind === "method" ? "method" : "function";
  const code = a.text ? `\n\n\`${a.path}:${a.from}–${a.to}\`\n\`\`\`\n${a.text.replace(/\n$/, "")}\n\`\`\`` : `\n\n\`${a.path}:${a.from}–${a.to}\``;
  return `Cover ${name}

The coverage report says no test runs part of the ${what} \`${name}\` (${a.source || "some of its lines"}). Write tests that run those lines: each branch, error and edge case they stand for. ${HOW} ${AGAIN}${code}
`;
}
