"use strict";
// The IDE's twin of src/repo-rules.ts (this file is plain CommonJS and can't import it): .friday/rules.md, a readable markdown
// list, each rule a line "- [x] text  <!-- from: ..., at: YYYY-MM-DD, tools: all -->" ([ ] is off). test/repo-rules.test.ts holds
// the two to the same answers (Arun, 2026-11-19: "correct the agent once ... and it becomes a rule every tool follows").
const LINE = /^()[-*]\s+\[([ xX])\]\s+(.*?)\s*$/;
const META = /\s*<!--\s*(.*?)\s*-->\s*$/;
const HEAD = "# Rules for this repo\n\nFriday tells every coding tool these before it starts. Turn one off with [ ], or edit the text.\n";
const clean = (s) => String(s || "").replace(/<!--/g, "<!-").replace(/-->/g, "->").replace(/\s+/g, " ").trim();
const source = (s) => clean(s).replace(/\s*,\s*/g, "; ");
const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function parseLine(line) {
  const m = LINE.exec(line);
  if (!m) return null;
  let text = m[3];
  let from = "";
  let at = "";
  let tools = "all";
  const meta = META.exec(text);
  if (meta) {
    text = text.slice(0, meta.index).trim();
    const k = /^from:\s*(.*?)\s*(?:,\s*at:\s*(\S*?))?\s*(?:,\s*tools:\s*(.*?))?$/.exec(meta[1]);
    if (k) {
      from = k[1] || "";
      at = k[2] || "";
      tools = (k[3] && k[3].trim()) || "all";
    }
  }
  if (!text) return null;
  return { text, on: m[2] !== " ", from, at, tools };
}

function formatRule(r) {
  const meta = `<!-- from: ${source(r.from) || "you"}, at: ${r.at || today()}, tools: ${clean(r.tools).replace(/\s*,\s*/g, ",") || "all"} -->`;
  return `- [${r.on ? "x" : " "}] ${clean(r.text)}  ${meta}`;
}

const parseRules = (text) => String(text || "").split(/\r?\n/).map(parseLine).filter(Boolean);

function mapNth(text, n, fn) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let i = -1;
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const r = parseLine(line);
    if (!r || ++i !== n) {
      out.push(line);
      continue;
    }
    const next = fn(r, line);
    if (typeof next === "string") out.push(next);
    else if (next) out.push(formatRule(next));
  }
  return out.join(eol);
}

const setRuleOn = (text, n, on) => mapNth(text, n, (r, line) => (r.on === on ? line : line.replace(/\[[ xX]\]/, on ? "[x]" : "[ ]")));
const editRule = (text, n, body) => mapNth(text, n, (r) => (clean(body) ? { ...r, text: clean(body) } : r));
const removeRule = (text, n) => mapNth(text, n, () => null);

function addRule(text, r) {
  const rule = { text: clean(r.text), on: r.on !== false, from: r.from || "you", at: r.at || today(), tools: r.tools || "all" };
  if (!rule.text) return text;
  if (parseRules(text).some((x) => x.text.toLowerCase() === rule.text.toLowerCase())) return text;
  const base = text.trim() ? text.replace(/\s*$/, "\n") : `${HEAD}\n`;
  return `${base}${formatRule(rule)}\n`;
}

module.exports = { parseRules, formatRule, setRuleOn, editRule, removeRule, addRule, HEAD };
