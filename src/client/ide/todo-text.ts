// What a "todo" ask says to the agent (Arun, 2026-11-19, wave 4: "TODOs become tasks: Friday finds the TODO and FIXME comments in
// your repo, lists them, and hands any of them to an agent in one click."). The extension (todos.js) sends the marker's words in
// `problem`, its tag in `source`, its line in `line`, and about twenty lines around it in `text`. The first line is the chat's name
// in its tab: "TODO file:line".

interface Todo {
  path: string;
  from: number;
  to: number;
  text: string;
  line?: number;
  problem?: string;
  source?: string;
}

export function todoText(a: Todo): string {
  const tag = /^(TODO|FIXME|HACK|XXX)$/.test(a.source ?? "") ? a.source! : "TODO";
  const line = a.line ?? a.from;
  const name = `${a.path.split(/[\\/]/).pop()}:${line}`;
  const words = (a.problem ?? "").trim();
  const ask = words
    ? `Do this ${tag}: "${words}"`
    : `Do what this ${tag} comment asks: it has no words, so read the code around it and work out what is missing`;
  const code = a.text ? `\n\n\`${a.path}:${a.from}–${a.to}\`\n\`\`\`\n${a.text.replace(/\n$/, "")}\n\`\`\`` : `\n\n\`${a.path}:${line}\``;
  return `${tag} ${name}

${ask} (line ${line} of \`${a.path}\`). Make the change the comment asks for, then remove the ${tag} comment, run the tests, and say what you did in a line. Change only what this one comment needs: leave the other TODOs and the rest of the file as they are.${code}
`;
}
