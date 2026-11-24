import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Library, Shelf, SkillRow, SkillText } from "../runner/skill-library.js";
import type { SkillFolder } from "../skill-import.js";
import { SKILL_CATALOG } from "../skill-catalog.js";
import type { EngineTool } from "../types.js";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MessageResponse } from "@/components/ai-elements/message";
import { PageHeader } from "@/components/dass";
import { api } from "./api.js";
import { EngineMark, GitHubMark } from "./BrandMarks.js";
import { Icon } from "./icons.js";
import { hostApi } from "./local.js";
import { MenuButton, relTime } from "./ui.js";
import type { Identity } from "./storage.js";
import "./mcp-servers.css";
import "./skills-page.css";

/**
 * Skills (Arun, 2026-11-19: "i want to work on the skills page.... allow users to creat their own skills or import skills from
 * either their coding tools or from github", then "rework the UI and logic for these skills too... better navigation logic and UX
 * logic too along with a better new skill modal").
 *
 * Your skills are folders with a SKILL.md in ~/.agents/skills (runner/skill-library.ts): every coding tool Friday runs and every
 * crew mate can use them. The page is a list and the skill open beside it: what to look at down the left (yours, each coding
 * tool's, your projects'), the skills as rows, and the one picked read in full on the right (its instructions as they render, its
 * files), changed there in place. The skill open is in the address, so back closes it; ↑ and ↓ go through the list, / searches and
 * N starts a new one. A new skill starts from a sentence a coding tool drafts it from, one of Friday's templates, a blank page, a
 * GitHub repository, or a coding tool's own.
 */

const call = <T,>(identity: Identity, op: string, body?: unknown) =>
  hostApi<T>(identity, `/api/runner/${op}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });

type View = "mine" | "all" | string;
type Item = { row: SkillRow; shelf: Shelf | null };
type Read = SkillText & { mine: boolean; dir: string };

type SkillFilter = "files" | "several" | "noBuiltin" | "noPlugins";
type SkillSort = "name" | "recent" | "files";
const SORTS: Record<SkillSort, string> = { name: "A to Z", recent: "Recently changed", files: "Most files" };
const FILTER_WORDS: Record<SkillFilter, string> = { files: "With files", several: "In several places", noBuiltin: "No built-in", noPlugins: "No plugins" };

/** A choice kept in this browser; none (private window, blocked storage) is the default. */
function remembered<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function keep(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Nowhere to keep it: it lasts the visit.
  }
}

/** What a search matched, marked where it is in the words. */
function lit(text: string, needle: string): ReactNode {
  if (!needle) return text;
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className="skl-hl">{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}

/** A shelf's mark: its tool's, or a folder for a project's skills, which every tool working there reads. */
function ShelfMark({ shelf, size }: { shelf: Shelf; size: number }) {
  return shelf.kind === "friday" ? <Icon name="skills" size={size} /> : shelf.kind === "project" || !shelf.tool ? <Icon name="folder" size={size} /> : <EngineMark tool={shelf.tool} size={size} />;
}

/** Where a tool's skill comes from, when not its own folder. */
const FROM: Record<NonNullable<SkillRow["from"]>, string> = { builtin: "Built in", synced: "Synced", vscode: "From VS Code", plugin: "Plugin", managed: "Managed" };

/** This computer's home folder, from where the library is (<home>/.agents/skills): the page is told no other way. */
let homeDir = "";
const tildePath = (p: string) => (homeDir && (p === homeDir || p.startsWith(homeDir + "/") || p.startsWith(homeDir + "\\")) ? `~${p.slice(homeDir.length)}` : p);
const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

/** The skill open, as the address says it: `skill=<folder>` for one of yours, `skill=<tool>:<folder>` for a tool's. */
const keyOf = (it: Item) => (it.shelf ? `${it.shelf.id}:${it.row.folder}` : it.row.folder);
const keyInUrl = () => new URLSearchParams(location.search).get("skill") ?? "";
function putKey(key: string, push: boolean) {
  const u = new URL(location.href);
  if (key) u.searchParams.set("skill", key);
  else u.searchParams.delete("skill");
  if (u.href === location.href) return;
  if (push) history.pushState(history.state, "", u);
  else history.replaceState(history.state, "", u);
}

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function SkillsPage({ identity, onUse, tabs }: { identity: Identity; /** Customize's tabs, at the toolbar's left (App.tsx). */ tabs?: ReactNode; /** A new session, its box filled with this (App.tsx, as Code Review hands one over). */ onUse?: (brief: string) => void }) {
  const [lib, setLib] = useState<Library | null>(null);
  const [failed, setFailed] = useState("");
  const [view, setView] = useState<View>("mine");
  const [q, setQ] = useState("");
  const [key, setKey] = useState(keyInUrl);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [said, setSaid] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const load = useCallback(
    () =>
      call<Library>(identity, "skills.library").then(
        (l) => ((homeDir = l.dir.replace(/[\\/]\.agents[\\/]skills$/, "")), setLib(l), setFailed("")),
        (e: Error) => setFailed(e.message),
      ),
    [identity],
  );
  useEffect(() => void load(), [load]);
  // Back on the page from a coding tool or the terminal: what changed in the folders shows.
  useEffect(() => {
    const again = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, [load]);
  // Back and forward open and close skills as the address says.
  useEffect(() => {
    const back = () => setKey(keyInUrl());
    addEventListener("popstate", back);
    return () => removeEventListener("popstate", back);
  }, []);
  useEffect(() => {
    if (!said) return;
    const t = setTimeout(() => setSaid(""), 6000);
    return () => clearTimeout(t);
  }, [said]);

  // Finding one (Arun, 2026-11-19: "i need better filters and accessiblity to easily find skills and stuff"): a search looks
  // everywhere unless narrowed to the place picked, the filters say what kind, the sort says in what order; all remembered here.
  const needle = q.trim().toLowerCase();
  const [narrow, setNarrow] = useState(false);
  const [filters, setFilters] = useState<Set<SkillFilter>>(() => new Set(remembered<SkillFilter[]>("friday.skills.filters", [])));
  const [sort, setSort] = useState<SkillSort>(() => remembered<SkillSort>("friday.skills.sort", "name"));
  useEffect(() => keep("friday.skills.filters", [...filters]), [filters]);
  useEffect(() => keep("friday.skills.sort", sort), [sort]);
  const flip = (f: SkillFilter) => setFilters((s) => (s.has(f) ? (s.delete(f), new Set(s)) : new Set(s).add(f)));
  const mine = lib?.mine ?? [];
  const shelves = lib?.shelves ?? [];
  const mineNames = useMemo(() => new Set(mine.map((s) => s.folder)), [mine]);
  // Every place a skill of a name is: "Also in Codex", and the "In more than one place" filter.
  const placesOf = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of mine) m.set(s.name, [...(m.get(s.name) ?? []), "Your skills"]);
    for (const sh of shelves) for (const s of sh.skills) m.set(s.name, [...(m.get(s.name) ?? []), sh.label]);
    return m;
  }, [mine, shelves]);
  const matches = (s: SkillRow, shelf: Shelf | null) =>
    (!needle || `${s.name} ${s.folder} ${s.description}`.toLowerCase().includes(needle)) &&
    (!filters.has("files") || s.files > 0) &&
    (!filters.has("several") || (placesOf.get(s.name)?.length ?? 0) > 1) &&
    (!filters.has("noBuiltin") || (s.from !== "builtin" && s.from !== "managed")) &&
    (!filters.has("noPlugins") || shelf?.kind !== "plugins");
  const order = (a: SkillRow, b: SkillRow) => (sort === "recent" ? (b.updated ?? 0) - (a.updated ?? 0) : sort === "files" ? b.files - a.files : 0) || a.name.localeCompare(b.name);
  const pick_ = (list: SkillRow[], shelf: Shelf | null) => list.filter((s) => matches(s, shelf)).sort(order);
  // A search looks everywhere, unless narrowed to the place picked.
  const scope: View = needle && !narrow ? "all" : view;
  const groups: { title: string; shelf: Shelf | null; list: SkillRow[] }[] =
    scope === "mine" ? [{ title: "Your skills", shelf: null, list: pick_(mine, null) }]
    : scope === "all" ? [{ title: "Your skills", shelf: null, list: pick_(mine, null) }, ...shelves.map((s) => ({ title: s.label, shelf: s, list: pick_(s.skills, s) }))]
    : shelves.filter((s) => s.id === scope).map((s) => ({ title: s.label, shelf: s, list: pick_(s.skills, s) }));
  const found = groups.reduce((n, g) => n + g.list.length, 0);
  const placeName = view === "mine" ? "your skills" : (shelves.find((s) => s.id === view)?.label ?? "here");
  // A group folded away (as Code Review's piles fold): its rows are out of ↑ ↓ too.
  const [shut, setShut] = useState<Set<string>>(() => new Set());
  const fold = (title: string) => setShut((s) => (s.has(title) ? (s.delete(title), new Set(s)) : new Set(s).add(title)));
  const items: Item[] = groups.filter((g) => !shut.has(g.title)).flatMap((g) => g.list.map((row) => ({ row, shelf: g.shelf })));
  // The skill open: looked for everywhere, not only in what the filter shows, so a link opens it whatever the view.
  const everything: Item[] = [...mine.map((row) => ({ row, shelf: null })), ...shelves.flatMap((s) => s.skills.map((row) => ({ row, shelf: s })))];
  const open = key ? (everything.find((it) => keyOf(it) === key) ?? null) : null;
  // A link to a tool's skill shows that tool's list.
  const shown = useRef(false);
  useEffect(() => {
    if (shown.current || !lib || !open) return;
    shown.current = true;
    if (open.shelf && view === "mine") setView(open.shelf.id);
  }, [lib, open, view]);

  const pick = (it: Item | null, push = true) => {
    const k = it ? keyOf(it) : "";
    setKey(k);
    putKey(k, push);
  };
  const afterChange = async (folder: string | null, words: string) => {
    setSaid(words);
    await load();
    if (folder !== null) {
      setView((v) => (v === "all" ? v : "mine"));
      pick({ row: { folder, name: folder, description: "", dir: "", files: 0 }, shelf: null }, false);
    } else pick(null, false);
  };

  // Keys: / searches, N starts a new skill, ↑ and ↓ go through the list, Escape closes the one open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || creating || importing || document.querySelector("[role=dialog]")) return;
      if (typing(e.target)) {
        if (e.key === "Escape" && e.target === search.current) (search.current?.blur(), setQ(""));
        if (e.key === "ArrowDown" && e.target === search.current && items[0]) (e.preventDefault(), pick(items[0], false), listRef.current?.querySelector<HTMLElement>(".skl-row")?.focus());
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        search.current?.focus();
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        setCreating(true);
      } else if (e.key === "Escape" && key) {
        pick(null, false);
      } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length) {
        e.preventDefault();
        const at = items.findIndex((it) => keyOf(it) === key);
        const next = items[Math.max(0, Math.min(items.length - 1, at < 0 ? 0 : at + (e.key === "ArrowDown" ? 1 : -1)))]!;
        pick(next, false);
        requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(keyOf(next))}"]`)?.focus());
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  const filter = (id: View, label: string, n: number | null, icon: ReactNode) => (
    <button key={id} type="button" className={`mdir-filter${n === 0 && needle ? " none" : ""}`} aria-pressed={view === id} onClick={() => setView(id)}>
      {icon}
      <span>{label}</span>
      {n !== null && <span className="mdir-count">{n}</span>}
    </button>
  );
  const total = mine.filter((s) => matches(s, null)).length + shelves.reduce((n, s) => n + s.skills.filter((x) => matches(x, s)).length, 0);
  const empty = view === "mine" && !mine.length && !needle && !!lib;

  return (
    <div className="page conns-page msv-page skl-page px-6! max-[640px]:px-4!">
      <div className="page-inner">
        <PageHeader title="Skills" />
        {tabs && <div className="customize-bar">{tabs}</div>}
        <div className="msv">
          <section className="mdir" aria-label="Skills">
            <div className="mdir-head skl-head">
              <label className="mdir-search skl-search">
                <Icon name="search" size={14} />
                <input ref={search} type="search" placeholder="Search skills" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search skills" />
                {!q && <kbd className="skl-kbd">/</kbd>}
              </label>
              <div className="mdir-head-acts">
                <Button type="button" variant="outline" size="sm" className="mdir-custom-btn" onClick={() => setImporting(true)}>
                  <GitHubMark size={13} /> Import
                </Button>
                <Button type="button" size="sm" className="mdir-custom-btn" onClick={() => setCreating(true)} title="New skill (N)">
                  <Icon name="plus" size={14} /> New skill
                </Button>
              </div>
            </div>
            {said && (
              <p className="skl-said" role="status">
                <Icon name="check" size={13} /> {said}
              </p>
            )}
            <div className={`skl-shell${open ? " has-open" : ""}${empty ? " no-detail" : ""}`}>
              <nav className="mdir-filters" aria-label="Where skills are">
                {filter("mine", "Your skills", mine.filter((s) => matches(s, null)).length, <Icon name="book" size={14} />)}
                {shelves.length > 0 && filter("all", "All", total, <Icon name="grid" size={14} />)}
                {shelves.length > 0 && <span className="mdir-sep" aria-hidden="true" />}
                {shelves.map((s) => filter(s.id, s.label, s.skills.filter((x) => matches(x, s)).length, <ShelfMark shelf={s} size={14} />))}
              </nav>
              {empty ? (
                <EmptyMine onNew={() => setCreating(true)} onImport={() => setImporting(true)} shelf={shelves.find((s) => s.kind !== "friday") ?? null} onShelf={(id) => setView(id)} />
              ) : (
                <>
                  <div className="skl-listcol" ref={listRef}>
                    <div className="skl-tools">
                      <span className="skl-count" role="status" aria-live="polite">
                        {needle ? `${found} result${found === 1 ? "" : "s"}` : `${found} skill${found === 1 ? "" : "s"}`}
                      </span>
                      {needle && view !== "all" && (
                        <button type="button" className="skl-scope" aria-pressed={narrow} onClick={() => setNarrow((n) => !n)} title={narrow ? "Search everywhere" : `Search only ${placeName}`}>
                          {narrow ? `Only in ${placeName}` : "Everywhere"}
                        </button>
                      )}
                      <span className="skl-grow" />
                      <MenuButton
                        label={filters.size ? `Filters, ${filters.size} on` : "Filter skills"}
                        icon="list"
                        end
                        className={`skl-tool-btn${filters.size ? " is-on" : ""}`}
                        items={() => [
                          { heading: "Show only" },
                          { label: "With scripts or files", sub: "A folder of references or scripts beside it", icon: "file", checked: filters.has("files"), onSelect: () => flip("files") },
                          { label: "In more than one place", sub: "The same skill in several tools", icon: "copy", checked: filters.has("several"), onSelect: () => flip("several") },
                          { heading: "Hide" },
                          { label: "Built-in skills", sub: "The ones tools come with", icon: "box", checked: filters.has("noBuiltin"), onSelect: () => flip("noBuiltin") },
                          { label: "Plugins' skills", sub: "Claude Code's plugins", icon: "plug", checked: filters.has("noPlugins"), onSelect: () => flip("noPlugins") },
                          ...(filters.size ? [{ label: "Clear filters", icon: "x" as const, onSelect: () => setFilters(new Set()) }] : []),
                        ]}
                      />
                      <MenuButton
                        label={`Sort: ${SORTS[sort]}`}
                        text={SORTS[sort]}
                        caret="chevronsUpDown"
                        end
                        className="skl-sort"
                        items={() => (Object.keys(SORTS) as SkillSort[]).map((k) => ({ label: SORTS[k], checked: sort === k, onSelect: () => setSort(k) }))}
                      />
                    </div>
                    {filters.size > 0 && (
                      <div className="skl-chips" aria-label="Filters on">
                        {[...filters].map((f) => (
                          <button key={f} type="button" className="skl-chip" onClick={() => flip(f)} aria-label={`Remove filter: ${FILTER_WORDS[f]}`}>
                            {FILTER_WORDS[f]} <Icon name="x" size={11} />
                          </button>
                        ))}
                      </div>
                    )}
                    {!lib && !failed && <p className="mdir-empty">Reading the skills on this computer…</p>}
                    {groups
                      .filter((g) => g.list.length || (!g.shelf && scope === "mine"))
                      .map((g) => (
                        <section key={g.title} className="skl-group" aria-label={g.title}>
                          {/* Code Review's pile heading (Arun, 2026-11-19: "fix these cards... they are not consistent with my design
                              language"): where they are, folding what's under it, the count at its end. */}
                          {(scope === "all" || g.shelf) && (
                            <h3 className="rv-pile skl-pile m-0">
                              <button type="button" className="rv-pile-btn" aria-expanded={!shut.has(g.title)} onClick={() => fold(g.title)}>
                                <Icon name="chevronDown" size={14} className="rv-pile-chev" />
                                {g.shelf ? <ShelfMark shelf={g.shelf} size={13} /> : <Icon name="book" size={13} />}
                                <span className="rv-pile-name">{g.title}</span>
                                <span className="rv-pile-n">{g.list.length}</span>
                              </button>
                            </h3>
                          )}
                          {shut.has(g.title) ? null : g.list.length ? (
                            <ul className="skl-rows" role="listbox" aria-label={g.title}>
                              {g.list.map((row) => {
                                const it = { row, shelf: g.shelf };
                                const k = keyOf(it);
                                const have = !!g.shelf && mineNames.has(row.folder);
                                // Two lines, as a pull request's row: its name, then what it's for, and at the end of that line how
                                // big it is or that it's yours already. No mark on every row: the heading above says whose they are.
                                return (
                                  <li key={row.dir}>
                                    <button type="button" role="option" aria-selected={k === key} data-key={k} className="skl-row" onClick={() => pick(it)}>
                                      <b className="skl-row-name">{lit(row.name, needle)}</b>
                                      <span className="skl-row-sub">
                                        <span className="skl-row-what">
                                          {row.from && <span className="skl-from">{FROM[row.from]}</span>}
                                          {(() => {
                                            const elsewhere = (placesOf.get(row.name) ?? []).filter((p) => p !== g.title);
                                            return elsewhere.length ? (
                                              <span className="skl-from skl-also" title={`Also in ${elsewhere.join(", ")}`}>
                                                {elsewhere.length === 1 ? `Also in ${elsewhere[0]}` : `In ${elsewhere.length + 1} places`}
                                              </span>
                                            ) : null;
                                          })()}
                                          {row.description ? lit(row.description, needle) : "Says nothing about when to use it."}
                                        </span>
                                        {have ? (
                                          <span className="skl-have" title="Copied to your skills">
                                            <Icon name="check" size={12} /> Yours
                                          </span>
                                        ) : (
                                          row.files > 0 && (
                                            <span className="skl-files" title={`${row.files} file${row.files === 1 ? "" : "s"} beside its SKILL.md`}>
                                              <Icon name="file" size={12} />
                                              {row.files} file{row.files === 1 ? "" : "s"}
                                            </span>
                                          )
                                        )}
                                      </span>
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          ) : (
                            <p className="mdir-empty">{needle ? `No skill matches “${q.trim()}”.` : "None yet."}</p>
                          )}
                        </section>
                      ))}
                    {scope === "all" && lib && !items.length && <p className="mdir-empty">{needle ? `No skill matches “${q.trim()}”` : "No skill fits these filters"}{filters.size ? <> · <button type="button" className="link-btn" onClick={() => setFilters(new Set())}>Clear filters</button></> : null}</p>}
                    {failed && (
                      <p className="msv-error" role="alert">
                        Couldn't read the skills on this computer: {failed}
                      </p>
                    )}
                  </div>
                  <aside className="skl-detail" aria-label={open ? open.row.name : "Skill"}>
                    {open ? (
                      <SkillDetail
                        key={open.row.dir}
                        identity={identity}
                        item={open}
                        have={!!open.shelf && mineNames.has(open.row.folder)}
                        onBack={() => pick(null, false)}
                        onOpenMine={() => (setView("mine"), pick({ row: { ...open.row, dir: "" }, shelf: null }))}
                        onChanged={afterChange}
                        onUse={onUse}
                      />
                    ) : (
                      <div className="skl-pick">
                        <Icon name="book" size={18} />
                        <b>Pick a skill to read it</b>
                        <span>
                          ↑ ↓ go through the list · <kbd className="skl-kbd">/</kbd> searches · <kbd className="skl-kbd">N</kbd> starts a new one
                        </span>
                      </div>
                    )}
                  </aside>
                </>
              )}
            </div>
          </section>
        </div>
      </div>
      {creating && (
        <NewSkill
          identity={identity}
          shelves={shelves.filter((s) => s.kind !== "friday")}
          onClose={() => setCreating(false)}
          onImport={() => (setCreating(false), setImporting(true))}
          onShelf={(id) => (setCreating(false), setView(id))}
          onSaved={(folder, words) => (setCreating(false), void afterChange(folder, words))}
        />
      )}
      {importing && <GithubImport identity={identity} have={mineNames} onClose={() => setImporting(false)} onDone={(n, first) => (setImporting(false), void afterChange(first, n))} />}
    </div>
  );
}

/** None of your own yet: what a skill is, and the ways to have one. */
function EmptyMine({ onNew, onImport, shelf, onShelf }: { onNew: () => void; onImport: () => void; shelf: Shelf | null; onShelf: (id: string) => void }) {
  return (
    <div className="skl-empty">
      <span className="skl-empty-mark" aria-hidden="true">
        <Icon name="book" size={20} />
      </span>
      <b>Write a skill once, and every agent has it</b>
      <p>A skill is how to do one kind of task: how you review a pull request, ship a release, or write a migration. Every coding tool and crew mate reads it when a task matches what it says it's for.</p>
      <span className="skl-empty-acts">
        <Button type="button" size="sm" onClick={onNew}>
          <Icon name="plus" size={14} /> New skill
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onImport}>
          <GitHubMark size={13} /> Import from GitHub
        </Button>
        {shelf && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onShelf(shelf.id)}>
            Copy from {shelf.label}
          </Button>
        )}
      </span>
    </div>
  );
}

/**
 * A skill open beside the list: its name, what it's for and where it is, then its instructions as they render or its files, and
 * what can be done with it. One of yours is changed here in place.
 */
function SkillDetail({ identity, item, have, onBack, onOpenMine, onChanged, onUse }: { identity: Identity; item: Item; have: boolean; onBack: () => void; onOpenMine: () => void; onChanged: (folder: string | null, said: string) => Promise<void>; onUse?: ((brief: string) => void) | undefined }) {
  const [read, setRead] = useState<Read | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<"text" | "files">("text");
  const [file, setFile] = useState<{ path: string; text: string; cut: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  /** Bumped after a save, so what's shown is read again. */
  const [ver, setVer] = useState(0);
  const mine = !item.shelf;
  const [more, setMore] = useState(false);
  const md = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    call<Read>(identity, "skills.readAt", { dir: item.row.dir }).then(
      (r) => live && setRead(r),
      (e: Error) => live && setErr(e.message),
    );
    return () => void (live = false);
  }, [identity, item.row.dir, ver]);
  const openFile = (p: string) =>
    call<{ text: string; cut: boolean }>(identity, "skills.file", { dir: item.row.dir, path: p }).then(
      (r) => setFile({ path: p, ...r }),
      (e: Error) => setErr(e.message),
    );
  const act = async (f: () => Promise<void>) => {
    setBusy(true);
    setErr("");
    try {
      await f();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  const copy = (text: string, what: string) => void navigator.clipboard?.writeText(text).then(() => (setCopied(true), setErr(""), setTimeout(() => setCopied(false), 1500), what));
  const heads = read ? (read.body.match(/^#{2,3}\s+\S/gm) ?? []).length : 0;
  // The section being read, lit in the outline as the pane scrolls: the last heading above a line a third of the way down.
  const [here, setHere] = useState(0);
  useEffect(() => {
    const pane = md.current?.closest(".skl-detail");
    if (!pane || heads < 3) return;
    const look = () => {
      const line = pane.getBoundingClientRect().top + pane.clientHeight / 3;
      const hs = [...(md.current?.querySelectorAll("h2, h3") ?? [])];
      let at = 0;
      hs.forEach((h, i) => h.getBoundingClientRect().top <= line && (at = i));
      setHere(at);
    };
    look();
    pane.addEventListener("scroll", look, { passive: true });
    return () => pane.removeEventListener("scroll", look);
  }, [heads, read?.body, tab, editing]);
  if (editing && read)
    return (
      <div className="skl-detail-in">
        <div className="skl-detail-bar">
          <button type="button" className="skl-back" onClick={() => setEditing(false)}>
            <Icon name="arrowLeft" size={14} /> {read.name}
          </button>
        </div>
        <SkillEditor
          identity={identity}
          folder={read.folder}
          initial={{ name: read.name, description: read.description, body: read.body }}
          submit="Save"
          onCancel={() => setEditing(false)}
          onSaved={(s) => (setEditing(false), setVer((v) => v + 1), void onChanged(s.folder, `${s.name} saved.`))}
        />
      </div>
    );
  // The open skill, laid out to be read and used (Arun, 2026-11-19: "design this content stuff better please, and actually helpful
  // and nicer and qol features too"): its name with Use it and Edit, one line of facts, what it's for in a box of its own (three
  // lines, the rest a press away), then its instructions at a reading width beside an outline of their sections, or its files.
  const name = read?.name ?? item.row.name;
  const description = (read?.description ?? item.row.description).trim();
  const words = read ? read.body.split(/\s+/).filter(Boolean).length : 0;
  const outline = read ? [...read.body.matchAll(/^(#{2,3})\s+(.+)$/gm)].map((m) => ({ depth: m[1]!.length, text: m[2]!.replace(/[*_`[\]]/g, "").trim() })).slice(0, 16) : [];
  const jump = (i: number) => md.current?.querySelectorAll("h2, h3")[i]?.scrollIntoView({ block: "start", behavior: "smooth" });
  const whose = item.shelf ? (item.shelf.kind === "project" ? `${item.shelf.label}'s project skill` : `${item.shelf.label}'s${item.row.from ? `, ${FROM[item.row.from].toLowerCase()}` : ""}`) : "Yours, for every tool";
  const files = read?.files.length ?? item.row.files;
  const facts = [whose, files ? `${files} file${files === 1 ? "" : "s"}` : "", item.row.updated ? `changed ${relTime(item.row.updated)}${/^(now|just)/.test(relTime(item.row.updated)) ? "" : " ago"}` : "", words ? `${words.toLocaleString()} word${words === 1 ? "" : "s"}` : ""].filter(Boolean);
  const brief = `Use the ${name} skill (${item.row.dir}/SKILL.md): `;
  // A tool's own or a project's (Arun, 2026-11-20: "also allow for deleting of skills too"); not one that comes with its tool, a
  // plugin's, a synced set's or a managed one, which are theirs (skill-library.ts removeAt).
  // Nor one Friday writes (skill-library.ts FRIDAY_WRITES): it would be back the next time Friday starts.
  const ours = item.shelf?.kind === "friday";
  const deletable = !mine && !!item.shelf && item.shelf.kind !== "plugins" && !ours && !item.row.from;
  return (
    <div className="skl-detail-in">
      <button type="button" className="skl-back skl-back-narrow" onClick={onBack}>
        <Icon name="arrowLeft" size={14} /> Skills
      </button>
      <header className="skl-head2">
        <span className="skl-mark skl-mark-lg" aria-hidden="true">
          {item.shelf ? <ShelfMark shelf={item.shelf} size={18} /> : <Icon name="book" size={17} />}
        </span>
        <div className="skl-head2-text">
          <h2>{name}</h2>
        </div>
        <div className="skl-head2-acts">
          {onUse && (
            <Button type="button" size="sm" onClick={() => onUse(brief)} title="Start a session with this skill">
              <Icon name="play" size={12} /> Use it
            </Button>
          )}
          {mine ? (
            <Button type="button" variant="outline" size="sm" disabled={!read} onClick={() => setEditing(true)}>
              <Icon name="pencil" size={13} /> Edit
            </Button>
          ) : have ? (
            <Button type="button" variant="outline" size="sm" onClick={onOpenMine}>
              Open yours
            </Button>
          ) : ours ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const r = await call<{ skill: SkillRow }>(identity, "skills.copy", { dir: item.row.dir });
                  await onChanged(r.skill.folder, `${r.skill.name} is in your skills now: every coding tool can use it.`);
                })
              }
            >
              <Icon name="copy" size={13} /> {busy ? "Copying…" : "Copy to your skills"}
            </Button>
          )}
          <MenuButton
            label={`More for ${name}`}
            end
            items={() => [
              { label: `Copy /${item.row.folder}`, sub: "What you type to call it in Claude Code", icon: "terminal", onSelect: () => copy(`/${item.row.folder}`, "call") },
              { label: "Copy where it is", sub: tildePath(item.row.dir), icon: "folder", onSelect: () => copy(item.row.dir, "path") },
              ...(mine
                ? [
                    {
                      label: "Duplicate",
                      icon: "copy" as const,
                      onSelect: () =>
                        void act(async () => {
                          const r = await call<{ skill: SkillRow }>(identity, "skills.duplicate", { folder: item.row.folder });
                          await onChanged(r.skill.folder, `A copy of ${item.row.name} is in your skills as ${r.skill.folder}.`);
                        }),
                    },
                    { label: "Remove", icon: "trash" as const, danger: true, onSelect: () => setAsking(true) },
                  ]
                : deletable
                  ? [{ label: "Delete", sub: "Moves its folder to Friday's trash", icon: "trash" as const, danger: true, onSelect: () => setAsking(true) }]
                  : []),
            ]}
          />
        </div>
      </header>
      <p className="skl-facts">
        {facts.map((f, i) => (
          <span key={i}>{f}</span>
        ))}
      </p>
      {copied && (
        <p className="skl-copied" role="status">
          <Icon name="check" size={12} /> Copied
        </p>
      )}
      {asking && (
        <div className="mdir-confirm" role="alertdialog" aria-label={`${mine ? "Remove" : "Delete"} ${item.row.name}?`}>
          <span className="mdir-confirm-text">
            <b>
              {mine ? "Remove" : "Delete"} {item.row.name}?
            </b>
            <span>
              {mine
                ? "No agent will use it after this. Its folder moves to Friday's trash folder, so it can be put back."
                : item.shelf?.kind === "project"
                  ? `Agents working in ${item.shelf.label} won't load it after this. Its folder moves out of the repository into Friday's trash, so git will show it as deleted until you commit or put it back.`
                  : `${item.shelf?.label ?? "Its tool"} won't load it after this. Its folder moves to Friday's trash folder, so it can be put back.`}
            </span>
          </span>
          <span className="mdir-confirm-acts">
            <Button type="button" variant="ghost" size="sm" onClick={() => setAsking(false)}>
              Keep it
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  if (mine) await call(identity, "skills.remove", { folder: item.row.folder });
                  else await call(identity, "skills.removeAt", { dir: item.row.dir });
                  await onChanged(null, `${item.row.name} was ${mine ? "removed" : "deleted"}. It's in Friday's trash folder if you want it back.`);
                })
              }
            >
              {mine ? "Remove" : "Delete"}
            </Button>
          </span>
        </div>
      )}
      <section className="skl-when" aria-label="When to use it">
        <span className="skl-when-label">When to use it</span>
        <p className={more ? undefined : "is-clamped"}>{description || "It doesn't say, so the tools can't tell when it fits. Edit it to say."}</p>
        {description.length > 220 && (
          <button type="button" className="link-btn skl-more" onClick={() => setMore((m) => !m)}>
            {more ? "Show less" : "Show all"}
          </button>
        )}
      </section>
      {item.shelf && !have && (
        <p className="mdir-note skl-tool-note">
          {ours
            ? "Friday writes it and keeps it up to date, and every coding tool reads it."
            : item.shelf.kind === "project"
            ? `Every coding tool working in ${item.shelf.label} reads it. Copy it to your skills to use it everywhere.`
            : `${item.shelf.label} loads it by itself, and Friday tells the other coding tools it's here. Copy it to your skills to change it.`}
        </p>
      )}
      {err && (
        <p className="msv-error" role="alert">
          {err}
        </p>
      )}
      <div className="skl-tabbar">
        <div className="msv-seg skl-tabs" role="tablist" aria-label="What to show">
          <button type="button" role="tab" aria-selected={tab === "text"} onClick={() => (setTab("text"), setFile(null))}>
            Instructions
          </button>
          <button type="button" role="tab" aria-selected={tab === "files"} onClick={() => setTab("files")}>
            Files <span className="mdir-count">{files}</span>
          </button>
        </div>
      </div>
      {!read ? (
        !err && <p className="mdir-state">Reading it…</p>
      ) : tab === "text" ? (
        <div className={`skl-read${outline.length >= 3 ? " has-outline" : ""}`}>
          <div className="skl-md" ref={md}>
            {read.body.trim() ? <MessageResponse>{read.body}</MessageResponse> : <p className="mdir-empty">It has no instructions.</p>}
          </div>
          {outline.length >= 3 && (
            <nav className="skl-outline" aria-label="On this page">
              <span>On this page</span>
              {outline.map((h, i) => (
                <button key={i} type="button" data-depth={h.depth} aria-current={i === here || undefined} onClick={() => jump(i)}>
                  {h.text}
                </button>
              ))}
            </nav>
          )}
        </div>
      ) : file ? (
        <div className="skl-file">
          <button type="button" className="skl-back" onClick={() => setFile(null)}>
            <Icon name="arrowLeft" size={13} /> Files
          </button>
          <b>{file.path}</b>
          {file.text ? <pre>{file.text}</pre> : <p className="mdir-empty">Not text: open it in its folder.</p>}
          {file.cut && file.text && <p className="mdir-note">The first 200 KB.</p>}
        </div>
      ) : read.files.length ? (
        <ul className="skl-filelist">
          {read.files.map((f) => (
            <li key={f}>
              <button type="button" onClick={() => void openFile(f)}>
                <Icon name={/\.(py|sh|js|mjs|cjs|ts|rb|ps1)$/i.test(f) ? "code" : "file"} size={13} />
                <span>{f}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mdir-empty">Just its SKILL.md. Scripts and references it needs go in its folder beside it.</p>
      )}
    </div>
  );
}

const STARTERS: Record<string, string> = {
  Steps: "\n## Steps\n\n1. \n2. \n3. \n",
  "Done when": "\n## Done when\n\n- \n",
  "Don't": "\n## Don't\n\n- \n",
  Example: "\n## Example\n\n```\n\n```\n",
};

/**
 * A skill's name, when to use it, and its instructions, with what each is for said as it's typed: what the tools will call it,
 * whether the line they decide by says enough, and the instructions as they'll read, a click away.
 */
function SkillEditor({ identity, folder, initial, submit, onCancel, onSaved }: { identity: Identity; folder: string | null; initial: { name: string; description: string; body: string }; submit: string; onCancel: () => void; onSaved: (s: SkillRow) => void }) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [body, setBody] = useState(initial.body);
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const slug = slugOf(name);
  const short = description.trim().length > 0 && description.trim().length < 25;
  const save = async () => {
    if (busy || !slug || !description.trim() || !body.trim()) return;
    setBusy(true);
    setErr("");
    try {
      onSaved((await call<{ skill: SkillRow }>(identity, "skills.save", { folder: folder ?? "", name, description, body })).skill);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  // A section added: the caret goes into it, where its first line is to be written.
  const caret = useRef<number | null>(null);
  useEffect(() => {
    if (caret.current === null || !area.current) return;
    area.current.focus();
    area.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [body, mode]);
  const add = (text: string) => {
    const t = area.current;
    const at = t && mode === "write" ? t.selectionEnd : body.length;
    const before = body.slice(0, at).replace(/\n*$/, "");
    const piece = before ? text : text.replace(/^\n/, "");
    const next = `${before}${before ? "\n" : ""}${piece}${body.slice(at)}`;
    const from = before.length;
    const hit = [next.indexOf("1. ", from), next.indexOf("- ", from)].filter((i) => i >= 0).sort((a, b) => a - b)[0];
    caret.current = hit !== undefined ? hit + (next.startsWith("1. ", hit) ? 3 : 2) : next.length;
    setBody(next);
    setMode("write");
  };
  return (
    <form
      className="msv-fields skl-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") (e.preventDefault(), void save());
      }}
    >
      <label className="mdir-field">
        <span>Name</span>
        <input value={name} maxLength={60} placeholder="review-pull-request" autoComplete="off" spellCheck={false} autoFocus={!initial.name} onChange={(e) => setName(e.target.value)} />
        <small>
          {slug ? (
            <>
              The tools call it <code>{slug}</code>: /{slug} in Claude Code, ${slug} in Codex.
            </>
          ) : (
            "Lower case and hyphens: what the tools call it."
          )}
        </small>
      </label>
      <label className="mdir-field">
        <span>
          When to use it <em>{description.length}/1000</em>
        </span>
        <textarea className="skl-desc" rows={2} value={description} maxLength={1000} placeholder="Reviewing a pull request: checks it against our standards and writes the review. Use when asked to review a PR or a diff." onChange={(e) => setDescription(e.target.value)} />
        <small className={short ? "skl-warn" : undefined}>{short ? "Say more: what it does and when to reach for it. The tools pick a skill by this line alone." : "What it does and when to reach for it. The tools pick a skill by this line alone."}</small>
      </label>
      <div className="mdir-field skl-body-field">
        <span className="skl-body-head">
          <span>Instructions</span>
          <span className="skl-starters" aria-label="Add a section">
            {Object.entries(STARTERS).map(([label, text]) => (
              <button key={label} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => add(text)}>
                + {label}
              </button>
            ))}
          </span>
          <span className="msv-seg skl-mode" role="radiogroup" aria-label="Write or preview">
            {(["write", "preview"] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}>
                {m === "write" ? "Write" : "Preview"}
              </button>
            ))}
          </span>
        </span>
        {mode === "write" ? (
          <textarea
            ref={area}
            className="skl-body"
            rows={16}
            value={body}
            spellCheck={false}
            aria-label="Instructions"
            placeholder={"# Review a pull request\n\n## Steps\n\n1. Read the description and the linked issue first.\n2. Run the tests.\n\n## Done when\n\n- The review is posted, with what to change."}
            onChange={(e) => setBody(e.target.value)}
          />
        ) : (
          <div className="skl-md skl-preview">{body.trim() ? <MessageResponse>{body}</MessageResponse> : <p className="mdir-empty">Nothing to show yet.</p>}</div>
        )}
        <small>Markdown. The steps, what to check, and how the agent knows it's done. Scripts and references go in the skill's folder.</small>
      </div>
      {err && (
        <p className="msv-error" role="alert">
          {err}
        </p>
      )}
      <div className="msv-dlg-foot">
        <span className="skl-hint">
          <kbd className="skl-kbd">{/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"}</kbd>
          <kbd className="skl-kbd">↵</kbd> saves
        </span>
        <span className="msv-acts">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy || !slug || !description.trim() || !body.trim()}>
            {busy ? "Saving…" : submit}
          </Button>
        </span>
      </div>
    </form>
  );
}

type ToolRow = { tool: EngineTool; name: string; path: string | null; loggedIn: boolean | null; unavailable?: string };
const DRAFTERS: EngineTool[] = ["claude", "codex", "cursor", "opencode", "gemini", "antigravity", "copilot"];

const DRAFT_SYSTEM = `You write agent skills: instructions a coding agent (Claude Code, Codex and others) follows for one kind of task.
Answer with one SKILL.md and nothing else: no preamble, no code fence around it.
It starts with a header between --- lines with two keys:
name: lower case words joined by hyphens, a few words, as a verb ("review-pull-request").
description: one sentence, in double quotes, saying what the skill does and when to use it ("Use when …"). Agents decide to use a skill from this line alone.
Then the instructions in Markdown: a one-line title, the steps as a numbered list (concrete commands and checks where they help), a "Done when" list of what proves it worked, and a short "Don't" list if there are traps. Write for any project, not one case. Under 600 words.`;

/** A drafted SKILL.md, as the editor's fields: whatever came around it is dropped. */
export function fromDraft(text: string): { name: string; description: string; body: string } {
  let t = text.trim().replace(/^```[a-z]*\n([\s\S]*?)\n```$/i, "$1").trim();
  const at = t.indexOf("---");
  if (at > 0) t = t.slice(at);
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const head = m?.[1] ?? "";
  const val = (k: string) => (head.match(new RegExp(`^${k}:\\s*(.*)$`, "m"))?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
  const body = (m ? t.slice(m[0].length) : t).trim();
  const title = body.match(/^#\s+(.+)$/m)?.[1] ?? "";
  return { name: slugOf(val("name")) || slugOf(title), description: val("description"), body };
}

/**
 * A new skill. First where it starts from: a sentence a coding tool on this computer drafts it from, one of Friday's templates, a
 * blank page, a GitHub repository, or a coding tool's own skill. Then it's written in the same editor as any skill.
 */
function NewSkill({ identity, shelves, onClose, onImport, onShelf, onSaved }: { identity: Identity; shelves: Shelf[]; onClose: () => void; onImport: () => void; onShelf: (id: string) => void; onSaved: (folder: string, said: string) => void }) {
  const [step, setStep] = useState<"start" | "describe" | "template" | "edit">("start");
  const [from, setFrom] = useState<"start" | "describe" | "template">("start");
  const [draft, setDraft] = useState({ name: "", description: "", body: "" });
  const [idea, setIdea] = useState("");
  const [tools, setTools] = useState<ToolRow[] | null>(null);
  const [tool, setTool] = useState<EngineTool | "">("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    hostApi<{ tools: ToolRow[] }>(identity, "/api/runner/tools").then(
      (r) => {
        const ok = (r.tools ?? []).filter((t) => t.path && t.loggedIn !== false && !t.unavailable && DRAFTERS.includes(t.tool)).sort((a, b) => DRAFTERS.indexOf(a.tool) - DRAFTERS.indexOf(b.tool));
        setTools(ok);
        setTool((t) => t || ok[0]?.tool || "");
      },
      () => setTools([]),
    );
  }, [identity]);
  const usable = tools ?? [];
  const toolName = usable.find((t) => t.tool === tool)?.name ?? "A coding tool";
  const write = async () => {
    if (!idea.trim() || !tool || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await hostApi<{ text: string }>(identity, "/api/runner/ask", { method: "POST", body: JSON.stringify({ tool, system: DRAFT_SYSTEM, prompt: `Write a skill for this:\n\n${idea.trim()}`, timeoutMs: 180_000 }) });
      const d = fromDraft(r.text ?? "");
      if (!d.body) throw new Error("It came back empty. Try again, or say a little more.");
      setDraft(d);
      setFrom("describe");
      setStep("edit");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const starts: { id: string; icon: ReactNode; title: string; line: string; go: () => void; off?: string | undefined }[] = [
    {
      id: "describe",
      icon: <Icon name="chat" size={16} />,
      title: "Describe it",
      line: `Say what it's for in a sentence or two; ${usable.length ? toolName : "a coding tool"} drafts it for you to finish.`,
      go: () => setStep("describe"),
      off: tools && !usable.length ? "Sign in to a coding tool to draft with it." : undefined,
    },
    { id: "template", icon: <Icon name="grid" size={16} />, title: "Start from a template", line: "Review a diff, find the root cause, write a commit message, and more.", go: () => setStep("template") },
    { id: "blank", icon: <Icon name="file" size={16} />, title: "Blank", line: "A name, when to use it, and the steps: yours to write.", go: () => (setDraft({ name: "", description: "", body: "" }), setFrom("start"), setStep("edit")) },
    { id: "github", icon: <GitHubMark size={15} />, title: "Import from GitHub", line: "Skills from a repository, each brought in whole.", go: onImport },
    ...(shelves.length ? [{ id: "copy", icon: <Icon name="copy" size={16} />, title: `Copy from ${shelves[0]!.label}`, line: ((n) => (n === 1 ? "The skill your coding tools have, made yours to change." : `One of the ${n} skills your coding tools have, made yours to change.`))(shelves.reduce((n, s) => n + s.skills.length, 0)), go: () => onShelf(shelves[0]!.id) }] : []),
  ];
  const templates = SKILL_CATALOG.filter((s) => s.kind === "instruction" && s.instructions);
  const groups = [...new Set(templates.map((t) => t.group ?? "More"))];
  const title = step === "start" ? "New skill" : step === "describe" ? "Describe the skill" : step === "template" ? "Start from a template" : from === "describe" ? "Finish the draft" : "New skill";
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="mdir-sheet msv-dlg skl-sheet skl-new sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {step === "start"
              ? "Saved as a SKILL.md in ~/.agents/skills, where every coding tool and crew mate reads it."
              : step === "describe"
                ? "What the task is, and anything particular about how you want it done."
                : step === "template"
                  ? "Each is a starting point: change it to how your team works."
                  : from === "describe"
                    ? `${toolName} drafted it. Read it through and make it yours.`
                    : "Every coding tool and crew mate can use it once it's saved."}
          </DialogDescription>
        </DialogHeader>
        {step !== "start" && (
          <button type="button" className="skl-back" onClick={() => (setErr(""), setStep(step === "edit" ? from : "start"))} disabled={busy}>
            <Icon name="arrowLeft" size={13} /> Back
          </button>
        )}
        {step === "start" ? (
          <ul className="skl-starts">
            {starts.map((s) => (
              <li key={s.id}>
                <button type="button" className="skl-start" onClick={s.go} disabled={!!s.off} title={s.off}>
                  <span className="skl-mark" aria-hidden="true">
                    {s.icon}
                  </span>
                  <span className="skl-start-text">
                    <b>{s.title}</b>
                    <span>{s.off ?? s.line}</span>
                  </span>
                  <Icon name="chevronRight" size={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : step === "describe" ? (
          <form
            className="msv-fields"
            onSubmit={(e) => {
              e.preventDefault();
              void write();
            }}
          >
            <label className="mdir-field">
              <span>What should it do?</span>
              <textarea
                className="skl-desc skl-idea"
                rows={4}
                autoFocus
                value={idea}
                maxLength={2000}
                placeholder="Before a release: bump the version in package.json, write the changelog from the merged pull requests, tag it and push the tag. We use semver and Conventional Commits."
                onChange={(e) => setIdea(e.target.value)}
                disabled={busy}
              />
            </label>
            {usable.length > 1 && (
              <div className="skl-drafter">
                <span>Drafted by</span>
                <span className="msv-seg" role="radiogroup" aria-label="Which coding tool drafts it">
                  {usable.slice(0, 4).map((t) => (
                    <button key={t.tool} type="button" role="radio" aria-checked={tool === t.tool} onClick={() => setTool(t.tool)} disabled={busy}>
                      <EngineMark tool={t.tool} size={13} /> {t.name}
                    </button>
                  ))}
                </span>
              </div>
            )}
            {busy && (
              <p className="skl-working" role="status">
                <span className="skl-dots" aria-hidden="true" /> {toolName} is writing it. Usually under a minute.
              </p>
            )}
            {err && (
              <p className="msv-error" role="alert">
                {err}
              </p>
            )}
            <div className="msv-dlg-foot">
              <span />
              <span className="msv-acts">
                <Button type="button" variant="ghost" size="sm" onClick={() => (setDraft({ name: "", description: idea.trim().slice(0, 300), body: "" }), setFrom("describe"), setStep("edit"))} disabled={busy}>
                  Write it myself
                </Button>
                <Button type="submit" size="sm" disabled={!idea.trim() || !tool || busy}>
                  {busy ? "Drafting…" : "Draft it"}
                </Button>
              </span>
            </div>
          </form>
        ) : step === "template" ? (
          <div className="skl-templates">
            {groups.map((g) => (
              <section key={g}>
                <h4>{g}</h4>
                <ul>
                  {templates
                    .filter((t) => (t.group ?? "More") === g)
                    .map((t) => (
                      <li key={t.id}>
                        <button type="button" className="skl-start" onClick={() => (setDraft({ name: slugOf(t.name), description: t.description, body: t.instructions ?? "" }), setFrom("template"), setStep("edit"))}>
                          <span className="skl-start-text">
                            <b>{t.name}</b>
                            <span>{t.description}</span>
                          </span>
                          <Icon name="chevronRight" size={14} />
                        </button>
                      </li>
                    ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <SkillEditor key={`${draft.name}|${draft.body.length}`} identity={identity} folder={null} initial={draft} submit="Add skill" onCancel={onClose} onSaved={(s) => onSaved(s.folder, `${s.name} is in your skills: every coding tool and crew mate can use it.`)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface Found {
  path: string;
  name: string;
  description: string;
}

/** Skills from a GitHub repository: its address, the skills in it to tick, then each brought in as its whole folder. */
function GithubImport({ identity, have, onClose, onDone }: { identity: Identity; have: Set<string>; onClose: () => void; onDone: (said: string, first: string | null) => void }) {
  const [url, setUrl] = useState("");
  const [found, setFound] = useState<{ repo: string; skills: Found[]; more: number } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const folderOf = (p: string) => p.split("/").slice(-2, -1)[0] ?? "";
  const look = async (address = url) => {
    if (!address.trim() || busy) return;
    setBusy(true);
    setErr("");
    setFound(null);
    setQ("");
    try {
      const r = await api<{ repo: string; skills: Found[]; more: number }>(identity, "/api/skills/github/discover", { method: "POST", body: JSON.stringify({ url: address.trim() }) });
      if (!r.skills.length) throw new Error(`No skills in ${r.repo}: a skill is a folder with a SKILL.md in it.`);
      setFound(r);
      // One skill: ticked already. Several: none, so nothing comes in by accident.
      setPicked(new Set(r.skills.length === 1 && !have.has(folderOf(r.skills[0]!.path)) ? [r.skills[0]!.path] : []));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const bring = async () => {
    if (!found || !picked.size || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ repo: string; folders: SkillFolder[]; skipped: string[] }>(identity, "/api/skills/github/folders", { method: "POST", body: JSON.stringify({ url: url.trim(), paths: [...picked] }) });
      const w = await call<{ added: SkillRow[]; skipped: { folder: string; why: string }[] }>(identity, "skills.write", { folders: r.folders.map((f) => ({ folder: f.folder, skill: f.skill, files: f.files })) });
      const left = r.folders.reduce((n, f) => n + f.leftBehind, 0);
      const parts = [
        w.added.length ? `${w.added.length === 1 ? w.added[0]!.name : `${w.added.length} skills`} from ${r.repo} ${w.added.length === 1 ? "is" : "are"} in your skills now.` : "",
        w.skipped.length ? `${w.skipped.map((s) => s.folder).join(", ")}: ${w.skipped[0]!.why}` : "",
        r.skipped.length ? `${r.skipped.length} couldn't be read from GitHub.` : "",
        left ? `${left} file${left === 1 ? "" : "s"} (pictures, binaries, anything large) stayed on GitHub.` : "",
      ].filter(Boolean);
      if (!w.added.length) throw new Error(parts.join(" ") || "Nothing came in.");
      onDone(parts.join(" "), w.added.length === 1 ? w.added[0]!.folder : null);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  const toggle = (p: string) => setPicked((s) => (s.has(p) ? (s.delete(p), new Set(s)) : new Set(s).add(p)));
  const open = found?.skills.filter((s) => !have.has(folderOf(s.path))) ?? [];
  const needle = q.trim().toLowerCase();
  const listed = found?.skills.filter((s) => !needle || `${s.name} ${s.description}`.toLowerCase().includes(needle)) ?? [];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="mdir-sheet msv-dlg skl-sheet sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Import skills from GitHub</DialogTitle>
          <DialogDescription>A public repository, or a folder in one. Each skill comes in whole: its SKILL.md and the scripts and references beside it.</DialogDescription>
        </DialogHeader>
        <form
          className="skl-url"
          onSubmit={(e) => {
            e.preventDefault();
            void look();
          }}
        >
          <input className="msv-mono" value={url} autoFocus placeholder="github.com/anthropics/skills" autoComplete="off" spellCheck={false} aria-label="GitHub repository" onChange={(e) => (setUrl(e.target.value), setFound(null))} />
          <Button type="submit" variant="outline" size="sm" disabled={!url.trim() || busy}>
            {busy && !found ? "Looking…" : "Find skills"}
          </Button>
        </form>
        {!found && !busy && (
          <p className="skl-try">
            Try{" "}
            {["anthropics/skills", "vercel-labs/agent-skills"].map((r, i) => (
              <span key={r}>
                {i > 0 && " or "}
                <button type="button" className="link-btn" onClick={() => (setUrl(r), void look(r))}>
                  {r}
                </button>
              </span>
            ))}
            .
          </p>
        )}
        {found && (
          <div className="skl-found">
            <div className="skl-found-head">
              <span>
                {found.skills.length} skill{found.skills.length === 1 ? "" : "s"} in {found.repo}
                {found.more > 0 ? ` (and ${found.more} more not listed)` : ""}
              </span>
              {open.length > 1 && (
                <button type="button" className="link-btn" onClick={() => setPicked(picked.size === Math.min(open.length, 25) ? new Set() : new Set(open.slice(0, 25).map((s) => s.path)))}>
                  {picked.size === Math.min(open.length, 25) ? "Clear" : open.length > 25 ? "First 25" : "All"}
                </button>
              )}
            </div>
            {found.skills.length > 8 && (
              <label className="mdir-search skl-found-search">
                <Icon name="search" size={13} />
                <input type="search" placeholder={`Search ${found.skills.length} skills`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the repository's skills" />
              </label>
            )}
            <ul className="skl-found-list">
              {listed.map((s) => {
                const got = have.has(folderOf(s.path));
                return (
                  <li key={s.path}>
                    <label className={got ? "is-have" : undefined}>
                      <input type="checkbox" disabled={got || (!picked.has(s.path) && picked.size >= 25)} checked={got || picked.has(s.path)} onChange={() => toggle(s.path)} />
                      <span className="skl-found-text">
                        <b>{s.name}</b>
                        {got ? <em>Already in your skills</em> : s.description && <span>{s.description}</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
              {!listed.length && <li className="mdir-empty">No skill here matches “{q.trim()}”.</li>}
            </ul>
          </div>
        )}
        {err && (
          <p className="msv-error" role="alert">
            {err}
          </p>
        )}
        <p className="msv-trust">Only bring in skills from people you trust: agents follow their instructions and may run their scripts.</p>
        <div className="msv-dlg-foot">
          <span />
          <span className="msv-acts">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" size="sm" disabled={!picked.size || busy} onClick={() => void bring()}>
              {busy && found ? "Bringing them in…" : picked.size > 1 ? `Import ${picked.size} skills` : "Import"}
            </Button>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
