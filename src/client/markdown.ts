/**
 * Minimal, escape-first markdown for agent output: headings, lists, quotes,
 * fenced code, pipe tables, emphasis and http(s) links. Everything is escaped
 * before any tag is added, so the result is safe for dangerouslySetInnerHTML.
 */
export function md(src: string): string {
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');

  let html = "";
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  let table: string[][] = [];
  let code: string[] | null = null;

  const endPara = () => {
    if (para.length) html += `<p>${inline(para.join(" "))}</p>`;
    para = [];
  };
  const endList = () => {
    if (list) html += `</${list}>`;
    list = null;
  };
  const endTable = () => {
    if (!table.length) return;
    const [head, ...rows] = table;
    html += `<div class="table-wrap"><table><thead><tr>${head!.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows
      .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
      .join("")}</tbody></table></div>`;
    table = [];
  };
  const endAll = () => {
    endPara();
    endList();
    endTable();
  };

  for (const raw of src.split("\n")) {
    const line = raw.trimEnd();
    if (code) {
      if (line.startsWith("```")) {
        html += `<pre><code>${esc(code.join("\n"))}</code></pre>`;
        code = null;
      } else code.push(raw);
      continue;
    }
    let m: RegExpMatchArray | null;
    if (line.startsWith("```")) {
      endAll();
      code = [];
    } else if (!line.trim()) {
      endAll();
    } else if (/^\s*\|/.test(line)) {
      endPara();
      endList();
      if (/^\s*\|?\s*:?-{2,}/.test(line)) continue; // header separator row
      table.push(line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    } else if ((m = line.match(/^(#{1,4})\s+(.*)/))) {
      endAll();
      const lvl = Math.min(m[1]!.length + 2, 6);
      html += `<h${lvl}>${inline(m[2]!)}</h${lvl}>`;
    } else if ((m = line.match(/^\s*[-*]\s+(.*)/))) {
      endPara();
      endTable();
      if (list !== "ul") {
        endList();
        html += "<ul>";
        list = "ul";
      }
      html += `<li>${inline(m[1]!)}</li>`;
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      endPara();
      endTable();
      if (list !== "ol") {
        endList();
        html += "<ol>";
        list = "ol";
      }
      html += `<li>${inline(m[1]!)}</li>`;
    } else if ((m = line.match(/^>\s?(.*)/))) {
      endAll();
      html += `<blockquote>${inline(m[1]!)}</blockquote>`;
    } else {
      endList();
      endTable();
      para.push(line.trim());
    }
  }
  if (code) html += `<pre><code>${esc(code.join("\n"))}</code></pre>`;
  endAll();
  return html;
}
