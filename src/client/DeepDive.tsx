import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Dive, DiveAsk, DivePage } from "../deep-dive.js";
import type { FolderInfo } from "../runner/workspace.js";
import { ENGINE_MODEL_INFO, ENGINE_NAMES, type EngineTool } from "../types.js";
import { api } from "./api.js";
import { EngineMark } from "./BrandMarks.js";
import { FileIcon } from "./fileIcons.js";
import { Icon } from "./icons.js";
// The rendered answer straight from its own module, not through lazy-answer: this page is itself loaded on demand, and sharing
// lazy-answer or the Textarea with it split them into chunks of their own that every first load paid for (client-bundle test).
import RichAnswer from "./rich-answer.js";
import { hostApi } from "./local.js";
import type { Identity } from "./storage.js";
import { ConfirmDialog, isTyping, relTime, type Confirmation } from "./ui.js";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ChevronDownIcon } from "lucide-react";
import { PageHeader } from "@/components/dass";
import { EmptyState } from "@/components/dass/EmptyState";
import "./deep-dive.css";

/**
 * Deep Dive (deep-dive.ts): a repo explained, page by page, by the person's own coding tool, with every claim pointing at the
 * lines it is about, and questions about the code answered the same way (Arun, 2026-11-11: "Repo wiki and Q&A: docs, diagrams
 * and answers about a codebase … Deep Dive is what we should call it").
 *
 * Laid out the way people already read a repo wiki (Arun, 2026-11-12: "design it like devins to an extent", after DeepWiki):
 * the pages down the left with the questions under them, the page in the middle opening on the files it was written from, what
 * is on the page down the right, and the question box floating at the foot of the page. Friday's own quiet look throughout,
 * and one thing DeepWiki doesn't do: a citation opens the lines it names right here, read from this computer, in place of the
 * page's outline.
 */

type Detail = { dive: Dive; pages: DivePage[]; asks: DiveAsk[] };
type ToolRow = { tool: EngineTool; name: string; path: string | null; loggedIn: boolean | null; unavailable?: string };
type Code = { file: string; from: number; lines: string[]; total: number; start: number; end: number } | { file: string; error: string };
type Sel = { kind: "page"; id: string } | { kind: "ask"; id: string };

const TOOL_KEY = "friday.deepdive.tool";
const ORDER: EngineTool[] = ["claude", "codex", "cursor", "devin", "opencode"];
const sha = (h: string) => h.slice(0, 7);
/** Who writes it, said before it is written: each tool's small model, as deep-dive.ts DIVE_MODELS picks (not imported: that module is the server's). */
const SMALL: Partial<Record<EngineTool, string>> = { claude: "Haiku", codex: "GPT-6-Luna" };
/** The small models' ids (deep-dive.ts DIVE_MODELS): what a question is answered with until another is picked. */
const SMALL_ID: Partial<Record<EngineTool, string>> = { claude: "haiku", codex: "gpt-6-luna" };
/** The models a question can be answered with: the tool's latest, as its own model menu lists them. */
const askModels = (tool: EngineTool) => (ENGINE_MODEL_INFO[tool] ?? []).filter((m) => m.group === "Latest");
const modelName = (tool: EngineTool, id?: string) => (id ? (ENGINE_MODEL_INFO[tool] ?? []).find((m) => m.id === id)?.label : undefined);
const ASK_MODEL_KEY = "friday.deepdive.askModel";
function askModelFor(tool: EngineTool): string {
  try {
    const kept = (JSON.parse(localStorage.getItem(ASK_MODEL_KEY) ?? "{}") as Record<string, string>)[tool];
    if (kept && askModels(tool).some((m) => m.id === kept)) return kept;
  } catch {
    /* none kept */
  }
  return SMALL_ID[tool] ?? "";
}
function keepAskModel(tool: EngineTool, id: string) {
  try {
    localStorage.setItem(ASK_MODEL_KEY, JSON.stringify({ ...(JSON.parse(localStorage.getItem(ASK_MODEL_KEY) ?? "{}") as object), [tool]: id }));
  } catch {
    /* this visit only */
  }
}
const writerOf = (tool: EngineTool, writer?: string) => `${ENGINE_NAMES[tool]}${writer ? ` (${writer})` : ""}`;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ago = (t: number) => (relTime(t) === "now" ? "just now" : /\d$/.test(relTime(t)) ? relTime(t) : `${relTime(t)} ago`);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
/** The end of the range a citation `file:start-end` gives, wherever the pages or answers write it; the start alone otherwise. */
export function rangeEnd(text: string, file: string, start: number): number {
  const m = new RegExp(`\`${escape(file)}:${start}-(\\d+)\``).exec(text);
  const end = m ? Number(m[1]) : start;
  return end >= start && end - start < 400 ? end : start;
}
/** A folder as a person would say it: the home folder as ~, and a long one by its last few folders. */
export function shortPath(p: string): string {
  const home = p.replace(/^(?:\/Users|\/home)\/[^/]+(?=\/|$)/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, "~");
  if (home.length <= 52) return home;
  const sep = home.includes("\\") && !home.includes("/") ? "\\" : "/";
  return `…${sep}${home.split(sep).slice(-3).join(sep)}`;
}
/** A page's own `## ` headings, for "On this page". */
export const headingsOf = (body: string): string[] =>
  body
    .split(/\r?\n/)
    .flatMap((l) => (/^##\s+\S/.test(l) && !/^###/.test(l) ? [l.replace(/^##\s+/, "").replace(/[*_`]/g, "").trim()] : []));
/** Asks the page to show a file's lines, the way a citation in it does. */
const openFile = (path: string, line = 1) => window.dispatchEvent(new CustomEvent("friday:open-file", { detail: { path, line }, cancelable: true }));

/** What a repo's Deep Dive is doing, in a line. */
function statusLine(d: Dive): string {
  if (d.status === "building") {
    if (d.stage === "survey") return "Looking through the repo…";
    if (d.stage === "outline") return `Planning the pages${d.lines ? ` for ${d.lines.toLocaleString()} lines of code` : ""}…`;
    return `Writing page ${Math.min(d.done + 1, d.total)} of ${d.total}…`;
  }
  if (d.status === "failed") return d.error ?? "It couldn't be written.";
  return [plural(d.total, "page"), d.head && sha(d.head), writerOf(d.tool, d.writer), ago(d.at)].filter(Boolean).join(" · ");
}
const progress = (d: Dive) => (d.status !== "building" ? 1 : d.stage === "pages" && d.total ? Math.max(0.06, d.done / d.total) : d.stage === "outline" ? 0.04 : 0.02);

export function DeepDivePage({ identity }: { identity: Identity }) {
  const [dives, setDives] = useState<Dive[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(() => new URLSearchParams(location.search).get("repo"));
  const load = useCallback(async () => {
    try {
      setDives((await api<{ dives: Dive[] }>(identity, "/api/deepdive")).dives);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [identity]);
  useEffect(() => void load(), [load]);
  // While one is being written, the list keeps its progress current.
  const writing = !open && !!dives?.some((d) => d.status === "building");
  useEffect(() => {
    if (!writing) return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [writing, load]);
  // Which repo is open stays in the address, so a reload or a link lands on it.
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if ((p.get("repo") ?? null) === open) return;
    if (open) p.set("repo", open);
    else p.delete("repo");
    history.replaceState(history.state, "", `${location.pathname}?${p}`);
  }, [open]);
  return (
    <div className={`page conns-page dd-page${open ? " dd-page-repo" : ""} px-6! max-[640px]:px-4!`}>
      <div className="page-inner">
        <PageHeader title="Deep Dive" />
        {open ? (
          <Repo identity={identity} repo={open} onBack={() => (setOpen(null), void load())} />
        ) : (
          <Repos identity={identity} dives={dives} error={error} onOpen={setOpen} onStarted={(key) => (setOpen(key), void load())} />
        )}
      </div>
    </div>
  );
}

/** The repos explained so far, and the folders worked in lately that could be. */
function Repos({ identity, dives, error, onOpen, onStarted }: { identity: Identity; dives: Dive[] | null; error: string; onOpen: (key: string) => void; onStarted: (key: string) => void }) {
  const [folders, setFolders] = useState<FolderInfo[] | null>(null);
  const [tools, setTools] = useState<ToolRow[] | null>(null);
  const [tool, setTool] = useState<EngineTool | "">(() => {
    try {
      return (localStorage.getItem(TOOL_KEY) as EngineTool | null) ?? "";
    } catch {
      return "";
    }
  });
  const [starting, setStarting] = useState("");
  const [startError, setStartError] = useState("");
  useEffect(() => {
    hostApi<{ recent: FolderInfo[] }>(identity, "/api/runner/folders").then((r) => setFolders(r.recent ?? []), () => setFolders([]));
    hostApi<{ tools: ToolRow[] }>(identity, "/api/runner/tools").then((r) => setTools(r.tools ?? []), () => setTools([]));
  }, [identity]);
  // The tools that can write it: installed, signed in (or not known not to be), and able to run here.
  const usable = useMemo(() => (tools ?? []).filter((t) => t.path && t.loggedIn !== false && !t.unavailable).sort((a, b) => (ORDER.indexOf(a.tool) + 99) % 99 - ((ORDER.indexOf(b.tool) + 99) % 99)), [tools]);
  const chosen = usable.find((t) => t.tool === tool)?.tool ?? usable[0]?.tool ?? "";
  const known = new Set((dives ?? []).map((d) => d.folder));
  const fresh = (folders ?? []).filter((f) => f.isRepo && !known.has(f.path));
  const [more, setMore] = useState(false);
  const shown = more ? fresh : fresh.slice(0, 6);
  const start = async (folder: string) => {
    if (!chosen) return;
    setStarting(folder);
    setStartError("");
    try {
      const r = await api<{ dive: Dive }>(identity, "/api/deepdive/build", { method: "POST", body: JSON.stringify({ folder, tool: chosen }) });
      onStarted(r.dive.key);
    } catch (e) {
      setStartError((e as Error).message);
    } finally {
      setStarting("");
    }
  };
  const pick = (t: EngineTool) => {
    setTool(t);
    try {
      localStorage.setItem(TOOL_KEY, t);
    } catch {
      /* remembered for this visit only */
    }
  };
  return (
    <div className={`dd-home${dives && dives.length === 0 ? " dd-home-empty" : ""}`}>
      <div className="dd-home-head">
        <p className="dd-home-title">{dives?.length ? `${plural(dives.length, "repo")} explained` : "Deep Dive"}</p>
        {usable.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="dd-tool" aria-label={`Written by ${chosen ? writerOf(chosen, SMALL[chosen]) : ""}. Change`}>
                <span className="dd-tool-label">Written by</span>
                {chosen && <EngineMark tool={chosen} size={13} />}
                <span>{chosen ? writerOf(chosen, SMALL[chosen]) : ""}</span>
                <ChevronDownIcon aria-hidden="true" className="dd-tool-chev" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[240px]">
              <DropdownMenuLabel className="text-[12px] font-medium text-[var(--text-muted)]">Written by</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={chosen} onValueChange={(v) => pick(v as EngineTool)}>
                {usable.map((t) => (
                  <DropdownMenuRadioItem key={t.tool} value={t.tool}>
                    <EngineMark tool={t.tool} size={14} /> {writerOf(t.tool, SMALL[t.tool])}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {error && <p className="dd-error" role="alert">{error}</p>}
      {dives === null ? (
        <ul className="dd-shelf" aria-hidden="true">
          {[0, 1].map((i) => (
            <li key={i} className="dd-card dd-card-skel">
              <SkeletonLines n={3} className="dd-skel-card" />
            </li>
          ))}
        </ul>
      ) : dives.length > 0 ? (
        <>
          <p className="dd-lede">Pages that explain each repo, every claim pointing at the lines it's about. Open one to read it or ask about the code.</p>
          <ul className="dd-shelf" aria-label="Explained">
            {dives.map((d) => (
              <li key={d.key}>
                <RepoCard d={d} onOpen={() => onOpen(d.key)} />
              </li>
            ))}
          </ul>
        </>
      ) : (
        <Intro />
      )}
      <section className="dd-start" aria-labelledby="dd-start">
        <h2 id="dd-start" className="dd-h2">
          {dives?.length ? "Not explained yet" : "Pick a repo"}
        </h2>
        {startError && <p className="dd-error" role="alert">{startError}</p>}
        {folders === null || tools === null ? (
          <SkeletonLines n={4} className="dd-skel-picks" />
        ) : !usable.length ? (
          <EmptyState small icon={<Icon name="terminal" />} title="No coding tool to write it">
            Deep Dive is written by a coding tool on this computer, like Claude Code or Codex. Install one and sign in, then come back.
          </EmptyState>
        ) : !fresh.length ? (
          <EmptyState small icon={<Icon name="folder" />} title={dives?.length ? "Every recent repo is explained" : "No repos yet"}>
            {dives?.length ? "New repos you work in with Friday show here." : "Start a session in a repo and it shows here, ready to explain."}
          </EmptyState>
        ) : (
          <>
            <ul className="dd-picks">
              {shown.map((f) => (
                <li key={f.path} className="dd-pick dd-folder">
                  <Icon name="folder" size={15} />
                  <span className="dd-pick-name">{f.name}</span>
                  <span className="dd-pick-path" title={f.path}>
                    {shortPath(f.path.slice(0, Math.max(0, f.path.length - f.name.length - 1)) || f.path)}
                  </span>
                  <Button size="sm" variant="ghost" className="dd-pick-go" disabled={!!starting} onClick={() => void start(f.path)} aria-label={`Dive into ${f.name}`}>
                    {starting === f.path ? "Starting…" : "Dive in"}
                    {starting !== f.path && <Icon name="arrowRight" size={13} />}
                  </Button>
                </li>
              ))}
            </ul>
            {fresh.length > 6 && (
              <button type="button" className="dd-side-foot dd-more" onClick={() => setMore(!more)}>
                {more ? "Show fewer" : `Show ${fresh.length - 6} more`}
              </button>
            )}
          </>
        )}
        {chosen && dives && dives.length > 0 && (
          <p className="dd-quiet">
            <EngineMark tool={chosen} size={13} /> {writerOf(chosen, SMALL[chosen])} writes it in plan mode, a small model for a cheap read: it reads your code and changes nothing, on your own plan.
          </p>
        )}
      </section>
    </div>
  );
}

/** One repo: its pages and questions down the side, the one open, what's on it, and the code a citation points at. */
function Repo({ identity, repo, onBack }: { identity: Identity; repo: string; onBack: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  // It opens where you left it, per repo.
  const [sel, setSel] = useState<Sel>(() => ({ kind: "page", id: lastPage(repo) ?? "overview" }));
  const [code, setCode] = useState<Code | null>(null);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const top = useRef<HTMLDivElement>(null);
  /** What the pages and answers say, for a pressed citation's whole range (the chip carries its first line only). */
  const texts = useRef("");
  texts.current = detail ? [...detail.pages.map((p) => p.body), ...detail.asks.map((a) => a.answer)].join("\n") : "";
  const q = encodeURIComponent(repo);
  const load = useCallback(async () => {
    try {
      const d = await api<Detail>(identity, `/api/deepdive/repo?key=${q}`);
      setDetail(d);
      setError("");
      return d;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, [identity, q]);
  useEffect(() => void load(), [load]);
  // While it is being written, or a question is being answered, it is read again every few seconds.
  const busy = !!detail && (detail.dive.status === "building" || detail.asks.some((a) => a.status === "asking"));
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [busy, load]);

  // A citation pressed in a page or an answer (AnswerParts FileChip), or a file in its list: its lines, read from this computer.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ path: string; line?: number }>).detail;
      if (!d?.path) return;
      e.preventDefault();
      const start = d.line ?? 1;
      const end = rangeEnd(texts.current, d.path, start);
      void api<{ file: string; from: number; lines: string[]; total: number }>(identity, `/api/deepdive/code?key=${q}&file=${encodeURIComponent(d.path)}&start=${start}&end=${end}`).then(
        (r) => setCode({ ...r, start, end }),
        (err: Error) => setCode({ file: d.path, error: err.message }),
      );
    };
    addEventListener("friday:open-file", on);
    return () => removeEventListener("friday:open-file", on);
  }, [identity, q]);
  useEffect(() => {
    if (!code) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !isTyping(e.target) && setCode(null);
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [code]);
  const show = (s: Sel) => {
    setSel(s);
    if (s.kind === "page") keepPage(repo, s.id);
    top.current?.querySelector(".dd-grid")?.scrollTo({ top: 0 });
  };
  const showRef = useRef(show);
  showRef.current = show;
  // [ and ] turn the pages, / goes to the question box, as / goes to the search on the other pages.
  const order = detail?.pages.map((p) => p.id).join("\n") ?? "";
  const at = sel.kind === "page" ? sel.id : "";
  useEffect(() => {
    const ids = order ? order.split("\n") : [];
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === "/") {
        e.preventDefault();
        top.current?.querySelector<HTMLTextAreaElement>(".dd-askbar textarea")?.focus();
        return;
      }
      if (e.key !== "[" && e.key !== "]") return;
      const i = Math.max(0, ids.indexOf(at));
      const next = ids[e.key === "]" ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1)];
      if (next && next !== at) {
        e.preventDefault();
        showRef.current({ kind: "page", id: next });
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [order, at]);
  // The page open in the list stays in view there as the pages turn.
  useEffect(() => {
    top.current?.querySelector(".dd-side-item[aria-current]")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (error && !detail)
    return (
      <div className="dd-repo">
        <BackLink onBack={onBack} />
        <p className="dd-error" role="alert">{error}</p>
      </div>
    );
  if (!detail)
    return (
      <div className="dd-loading">
        <span className="dd-spin" aria-hidden="true" /> Loading…
      </div>
    );
  const { dive, pages, asks } = detail;
  const current = sel.kind === "page" ? (pages.find((p) => p.id === sel.id) ?? pages[0] ?? null) : null;
  const ask = sel.kind === "ask" ? (asks.find((a) => a.id === sel.id) ?? null) : null;
  const rebuild = () =>
    setConfirm({
      title: "Write this Deep Dive again?",
      body: `${writerOf(dive.tool, dive.writer)} reads the repo again and rewrites every page, on your own plan. The questions asked so far stay.`,
      action: "Write it again",
      danger: false,
      icon: "refresh",
      onConfirm: () =>
        void api(identity, "/api/deepdive/build", { method: "POST", body: JSON.stringify({ folder: dive.folder, tool: dive.tool, ...(dive.model ? { model: dive.model } : {}) }) }).then(
          () => load(),
          (e: Error) => setError(e.message),
        ),
    });
  // Deleting (Arun, 2026-11-12: "be able to delete questions and stuff too"): a question, all of them, or the whole Deep Dive.
  const drop = (a: DiveAsk) =>
    setConfirm({
      title: "Delete this question?",
      body: `"${a.question.length > 90 ? `${a.question.slice(0, 90)}…` : a.question}" and its answer go. You can ask it again.`,
      action: "Delete",
      onConfirm: () =>
        void api(identity, `/api/deepdive/ask?key=${q}&id=${encodeURIComponent(a.id)}`, { method: "DELETE" }).then(
          () => {
            if (sel.kind === "ask" && sel.id === a.id) show({ kind: "page", id: lastPage(repo) ?? "overview" });
            void load();
          },
          (e: Error) => setError(e.message),
        ),
    });
  const dropAsks = () =>
    setConfirm({
      title: `Delete all ${plural(detail?.asks.length ?? 0, "question")}?`,
      body: "Every question asked about this repo and its answer go. The pages stay.",
      action: "Delete all",
      onConfirm: () =>
        void api(identity, `/api/deepdive/asks?key=${q}`, { method: "DELETE" }).then(
          () => {
            if (sel.kind === "ask") show({ kind: "page", id: lastPage(repo) ?? "overview" });
            void load();
          },
          (e: Error) => setError(e.message),
        ),
    });
  const dropDive = () =>
    setConfirm({
      title: "Delete this Deep Dive?",
      body: `Its pages and questions go${detail?.dive.status === "building" ? ", and its writing stops" : ""}. Your code isn't touched, and you can write it again.`,
      action: "Delete",
      onConfirm: () =>
        void api(identity, `/api/deepdive/repo?key=${q}`, { method: "DELETE" }).then(
          () => onBack(),
          (e: Error) => setError(e.message),
        ),
    });
  const asked = async (question: string, model: string) => {
    const r = await api<{ ask: DiveAsk }>(identity, `/api/deepdive/ask?key=${q}`, { method: "POST", body: JSON.stringify({ question, ...(model && model !== SMALL_ID[dive.tool] ? { model } : {}) }) });
    await load();
    show({ kind: "ask", id: r.ask.id });
  };
  const toc = current?.status === "done" ? headingsOf(current.body) : [];
  return (
    <div className={`dd-repo${code ? " with-code" : ""}${toc.length ? " with-toc" : ""}`} ref={top}>
      {confirm && <ConfirmDialog confirmation={confirm} onClose={() => setConfirm(null)} />}
      <header className="dd-top">
        <BackLink onBack={onBack} />
        <h2 className="dd-top-name" title={dive.folder}>
          {dive.name}
        </h2>
        <span className="dd-top-gap" />
        {dive.status === "building" ? (
          <span className="dd-top-state">
            <span className="dd-spin" aria-hidden="true" /> {statusLine(dive)}
          </span>
        ) : dive.status === "failed" ? (
          <span className="dd-top-state bad">{statusLine(dive)}</span>
        ) : null}
        {dive.status !== "building" && (
          <Button size="sm" variant="outline" onClick={rebuild}>
            <Icon name="refresh" size={14} /> Write again
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="icon-btn dd-more-btn" aria-label="More" title="More">
              <Icon name="more" size={16} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[220px]">
            {asks.length > 0 && (
              <DropdownMenuItem onSelect={dropAsks}>
                <Icon name="x" size={14} /> Delete all questions
              </DropdownMenuItem>
            )}
            <DropdownMenuItem variant="destructive" onSelect={dropDive}>
              <Icon name="trash" size={14} /> Delete this Deep Dive
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {dive.status === "building" && (
        <span className="dd-bar dd-top-bar" role="progressbar" aria-label="Written so far" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress(dive) * 100)}>
          <span style={{ transform: `scaleX(${progress(dive)})` }} />
        </span>
      )}
      {error && <p className="dd-error" role="alert">{error}</p>}
      <div className="dd-grid">
        <nav className="dd-side" aria-label="Deep Dive">
          {dive.status !== "building" && dive.head && (
            <p className="dd-side-meta">
              Written {ago(dive.at)} at <span className="dd-sha">{sha(dive.head)}</span>
              {dive.branch ? ` on ${dive.branch}` : ""}, by <EngineMark tool={dive.tool} size={12} /> {writerOf(dive.tool, dive.writer)}
            </p>
          )}
          <p className="dd-side-label">Pages</p>
          {pages.length === 0 && dive.status === "building" && <SkeletonLines n={7} className="dd-skel-nav" />}
          <ul className="dd-side-list" aria-label="Pages">
            {pages.map((p, i) => (
              <li key={p.id}>
                <button type="button" className="dd-side-item dd-side-page" aria-current={current?.id === p.id ? "page" : undefined} onClick={() => show({ kind: "page", id: p.id })} title={p.title}>
                  <span className="dd-side-n" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="dd-side-name">{navTitle(p.title)}</span>
                  <PageMark p={p} />
                </button>
              </li>
            ))}
          </ul>
          {asks.length > 0 && (
            <>
              <p className="dd-side-label">Questions</p>
              <ul className="dd-side-list" aria-label="Questions">
                {asks.map((a) => (
                  <li key={a.id} className="dd-side-qrow">
                    <button type="button" className="dd-side-item dd-side-q" aria-current={ask?.id === a.id ? "page" : undefined} onClick={() => show({ kind: "ask", id: a.id })} title={a.question}>
                      <span>{a.question}</span>
                      {a.status === "asking" && <span className="dd-spin" aria-label="Being answered" />}
                    </button>
                    <button type="button" className="dd-side-x" aria-label={`Delete the question "${a.question}"`} title="Delete" onClick={() => drop(a)}>
                      <Icon name="x" size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {dive.status === "ready" && dive.uncovered.length > 0 && (
            <button
              type="button"
              className="dd-side-foot"
              onClick={() => {
                show({ kind: "page", id: "overview" });
                requestAnimationFrame(() => document.getElementById("dd-uncovered")?.scrollIntoView({ block: "start", behavior: "smooth" }));
              }}
            >
              {plural(dive.uncovered.length, "folder")} not covered yet
            </button>
          )}
        </nav>
        <div className="dd-main">
          {ask ? (
            <AnswerView a={ask} tool={dive.tool} writer={modelName(dive.tool, ask.model) ?? dive.writer} onDelete={() => drop(ask)} />
          ) : current ? (
            <>
              <PageView key={current.id} p={current} uncovered={current.id === "overview" && dive.status === "ready" ? dive.uncovered : []} />
              <Pager pages={pages} at={current.id} onShow={(id) => show({ kind: "page", id })} />
            </>
          ) : dive.status === "building" ? (
            <Building dive={dive} />
          ) : (
            <div className="dd-loading">
              <span className="dd-spin" aria-hidden="true" /> {statusLine(dive)}
            </div>
          )}
          <AskBar key={dive.tool} name={dive.name} tool={dive.tool} writer={dive.writer} onAsk={asked} />
        </div>
        {code ? <CodeView code={code} onClose={() => setCode(null)} /> : toc.length > 0 && <Outline key={current?.id} headings={toc} />}
      </div>
    </div>
  );
}

/** An explained repo on the shelf: its name, how much there is, and who wrote it at which commit. */
function RepoCard({ d, onOpen }: { d: Dive; onOpen: () => void }) {
  const cut = d.name.lastIndexOf("/");
  const owner = cut > 0 ? d.name.slice(0, cut + 1) : "";
  const name = cut > 0 ? d.name.slice(cut + 1) : d.name;
  return (
    <button type="button" className="dd-card" onClick={onOpen}>
      <span className="dd-card-head">
        <span className="dd-card-icon" aria-hidden="true">
          <Icon name="puzzle" size={15} />
        </span>
        <span className="dd-card-title">
          {owner && <span className="dd-card-owner">{owner}</span>}
          <span className="dd-card-name">{name}</span>
        </span>
        <Icon name="chevronRight" size={14} />
      </span>
      {d.status === "building" ? (
        <span className="dd-card-state">
          <span className="dd-card-meta">{statusLine(d)}</span>
          <span className="dd-bar" role="progressbar" aria-label="Written so far" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress(d) * 100)}>
            <span style={{ transform: `scaleX(${progress(d)})` }} />
          </span>
        </span>
      ) : d.status === "failed" ? (
        <span className="dd-card-meta bad">{statusLine(d)}</span>
      ) : (
        <span className="dd-card-meta">
          {plural(d.total, "page")} · {ago(d.at)}
        </span>
      )}
      <span className="dd-card-foot">
        <span className="dd-card-by">
          <EngineMark tool={d.tool} size={12} /> {writerOf(d.tool, d.writer)}
        </span>
        {d.head && <span className="dd-sha">{sha(d.head)}</span>}
      </span>
    </button>
  );
}

/** Before any repo is explained: a small picture of what Deep Dive makes, and what it costs. */
function Intro() {
  return (
    <div className="dd-intro">
      <div className="dd-intro-art" aria-hidden="true">
        <span className="dd-art-side">
          <span className="on" />
          <span />
          <span />
          <span />
          <span />
        </span>
        <span className="dd-art-page">
          <span className="dd-art-title" />
          <span className="dd-art-line" />
          <span className="dd-art-line short">
            <span className="dd-art-chip">src/server.ts 14–30</span>
          </span>
          <span className="dd-art-line" />
          <span className="dd-art-box">
            <span />
            <i />
            <span />
            <i />
            <span />
          </span>
        </span>
      </div>
      <div className="dd-intro-text">
        <h2 className="dd-intro-title">Explain a repo</h2>
        <p>Get a page for each part of a repo, every claim linked to the lines it's about, with diagrams where they help. Then ask anything about the code.</p>
        <ul className="dd-intro-facts">
          <li>
            <Icon name="check" size={13} /> Reads, never edits
          </li>
          <li>
            <Icon name="check" size={13} /> Small model, your plan
          </li>
          <li>
            <Icon name="check" size={13} /> Ready in minutes
          </li>
        </ul>
      </div>
    </div>
  );
}

/** Grey lines where words are coming, at the words' own size. */
function SkeletonLines({ n, className }: { n: number; className: string }) {
  return (
    <div className={`dd-skel ${className}`} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  );
}

/** A Deep Dive being started: its three steps, which is under way and what it has found, over the page to come. */
function Building({ dive }: { dive: Dive }) {
  const stage = dive.stage ?? "survey";
  const at = stage === "survey" ? 0 : stage === "outline" ? 1 : 2;
  const steps = [
    { name: "Look through the repo", said: at > 0 && dive.lines ? `${dive.lines.toLocaleString()} lines of code${dive.files ? ` in ${plural(dive.files, "file")}` : ""}` : "Its folders, files and notes" },
    { name: "Plan the pages", said: at > 1 ? plural(dive.total, "page") : "One page per part of the system" },
    { name: "Write the pages", said: at === 2 && dive.total ? `${dive.done} of ${dive.total} written` : "Several at once, each checked against the code" },
  ];
  return (
    <div className="dd-building">
      <ol className="dd-steps" aria-label="Writing this Deep Dive">
        {steps.map((s, i) => (
          <li key={s.name} className={i < at ? "done" : i === at ? "on" : ""} aria-current={i === at ? "step" : undefined}>
            <span className="dd-step-mark" aria-hidden="true">
              {i < at ? <Icon name="check" size={12} /> : i === at ? <span className="dd-spin" /> : null}
            </span>
            <span className="dd-step-name">{s.name}</span>
            <span className="dd-step-said">{s.said}</span>
          </li>
        ))}
      </ol>
      <p className="dd-building-note">It keeps writing if you leave this page. Ask a question below meanwhile: it reads the code directly.</p>
      <div className="dd-skel-page" aria-hidden="true">
        <SkeletonLines n={1} className="dd-skel-title" />
        <SkeletonLines n={2} className="dd-skel-purpose" />
        <SkeletonLines n={7} className="dd-skel-prose" />
      </div>
    </div>
  );
}

/** Where each repo was left, so it opens there again. */
function lastPage(repo: string): string | null {
  try {
    return localStorage.getItem(`friday.deepdive.page:${repo}`);
  } catch {
    return null;
  }
}
function keepPage(repo: string, id: string) {
  try {
    localStorage.setItem(`friday.deepdive.page:${repo}`, id);
  } catch {
    /* private window: it opens on the overview */
  }
}

/** A page's name in the list: the name before a colon when the title is a name and a sentence ("Overview: what Friday is"). */
function navTitle(title: string): string {
  const cut = title.indexOf(":");
  return cut > 0 && cut <= 28 ? title.slice(0, cut).trim() : title;
}

/** The pages either side of this one, at its foot, as a book's are. */
function Pager({ pages, at, onShow }: { pages: DivePage[]; at: string; onShow: (id: string) => void }) {
  const i = pages.findIndex((p) => p.id === at);
  const prev = i > 0 ? pages[i - 1] : undefined;
  const next = i >= 0 && i < pages.length - 1 ? pages[i + 1] : undefined;
  if (!prev && !next) return null;
  return (
    <nav className="dd-pager" aria-label="Next and previous pages">
      {prev ? (
        <button type="button" className="dd-pager-btn" onClick={() => onShow(prev.id)} title="Previous page ( [ )">
          <span className="dd-pager-dir">
            <Icon name="arrowLeft" size={12} /> Previous
          </span>
          <span className="dd-pager-name">{navTitle(prev.title)}</span>
        </button>
      ) : (
        <span />
      )}
      {next && (
        <button type="button" className="dd-pager-btn next" onClick={() => onShow(next.id)} title="Next page ( ] )">
          <span className="dd-pager-dir">
            Next <Icon name="arrowRight" size={12} />
          </span>
          <span className="dd-pager-name">{navTitle(next.title)}</span>
        </button>
      )}
    </nav>
  );
}

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className="dd-back icon-btn" onClick={onBack} aria-label="All repos" title="All repos">
      <Icon name="arrowLeft" size={16} />
    </button>
  );
}

function PageMark({ p }: { p: DivePage }) {
  if (p.status === "writing") return <span className="dd-spin" aria-label="Being written" />;
  if (p.status === "waiting") return <span className="dd-mark" aria-label="Waiting" />;
  if (p.status === "failed") return <span className="dd-mark bad" aria-label="Couldn't be written" />;
  if (p.bad.length || p.badDiagrams) return <span className="dd-mark warn" aria-label="Some of it didn't match the code" title="Some of it didn't match the code" />;
  return null;
}

/** Marks what the rendered Markdown can't say by itself: each `## ` heading's place for the outline, and the Sources lines. */
function useProse(text: string) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const mark = () => {
      el.querySelectorAll("h2").forEach((h, i) => (h.id = `dd-h-${i}`));
      el.querySelectorAll("p").forEach((p) => p.classList.toggle("dd-sources", /^\s*Sources?:/.test(p.textContent ?? "")));
    };
    mark();
    const seen = new MutationObserver(mark);
    seen.observe(el, { childList: true, subtree: true });
    return () => seen.disconnect();
  }, [text]);
  return ref;
}

function Warn({ bad, diagrams }: { bad: number; diagrams: number }) {
  if (!bad && !diagrams) return null;
  const said = [bad && `${plural(bad, "citation")} didn't match the code and ${bad === 1 ? "is" : "are"} struck through`, diagrams && `${plural(diagrams, "diagram")} couldn't be drawn`].filter(Boolean).join(", and ");
  return (
    <p className="dd-warn" role="note">
      <span className="dd-mark warn" aria-hidden="true" />
      <span>{said}. Read those parts with care.</span>
    </p>
  );
}

function PageView({ p, uncovered }: { p: DivePage; uncovered: Dive["uncovered"] }) {
  const prose = useProse(p.body);
  return (
    <article className="dd-article" aria-labelledby={`dd-page-${p.id}`}>
      <h1 id={`dd-page-${p.id}`} className="dd-title">
        {p.title}
      </h1>
      {p.purpose && <p className="dd-purpose">{p.purpose}</p>}
      {p.status === "done" ? (
        <>
          <Warn bad={p.bad.length} diagrams={p.badDiagrams} />
          {p.files.length > 0 && (
            <details className="dd-files">
              <summary>
                <Icon name="chevronRight" size={14} />
                Relevant source files <span className="dd-count">{p.files.length}</span>
              </summary>
              <ul>
                {p.files.map((f) => (
                  <li key={f}>
                    <button type="button" className="dd-file" onClick={() => openFile(f)}>
                      <FileIcon path={f} size={14} />
                      <code>{f}</code>
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="dd-prose" ref={prose}>
            <RichAnswer text={p.body} />
          </div>
          {uncovered.length > 0 && (
            <section className="dd-uncovered" aria-labelledby="dd-uncovered">
              <h2 id="dd-uncovered">Not covered yet</h2>
              <p>No page explains these parts of the repo. Writing the Deep Dive again plans its pages afresh.</p>
              <ul>
                {uncovered.map((u) => (
                  <li key={u.path}>
                    <code>{u.path}</code>
                    <span>
                      {plural(u.files, "file")} · {plural(u.lines, "line")}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      ) : p.status === "failed" ? (
        <p className="dd-warn bad" role="note">
          <span className="dd-mark bad" aria-hidden="true" />
          <span>This page couldn't be written: {p.error ?? "no reason given"}. Write the Deep Dive again to try it once more.</span>
        </p>
      ) : (
        <div className="dd-pending">
          <p className="dd-loading">
            <span className="dd-spin" aria-hidden="true" /> {p.status === "writing" ? "Being written now…" : "Waiting its turn…"}
          </p>
          <SkeletonLines n={9} className="dd-skel-prose" />
        </div>
      )}
    </article>
  );
}

function AnswerView({ a, tool, writer, onDelete }: { a: DiveAsk; tool: EngineTool; writer?: string | undefined; onDelete: () => void }) {
  const prose = useProse(a.answer);
  return (
    <article className="dd-article" aria-labelledby={`dd-ask-${a.id}`}>
      <h1 id={`dd-ask-${a.id}`} className="dd-title dd-question">
        {a.question}
      </h1>
      <p className="dd-purpose dd-answer-meta">
        <span>{a.status === "asking" ? `Asked ${ago(a.at)}` : `Answered ${ago(a.at)} by ${writerOf(tool, writer)}`}</span>
        <button type="button" className="dd-answer-del" onClick={onDelete}>
          <Icon name="trash" size={13} /> Delete
        </button>
      </p>
      {a.status === "asking" ? (
        <div className="dd-loading">
          <span className="dd-spin" aria-hidden="true" /> Reading the code…
        </div>
      ) : a.status === "failed" ? (
        <p className="dd-warn bad" role="note">
          <span className="dd-mark bad" aria-hidden="true" />
          <span>It couldn't answer: {a.error ?? "no reason given"}.</span>
        </p>
      ) : (
        <>
          <Warn bad={a.bad.length} diagrams={0} />
          <div className="dd-prose" ref={prose}>
            <RichAnswer text={a.answer} />
          </div>
        </>
      )}
    </article>
  );
}

/** The question box, floating at the foot of the page as the page scrolls under it. */
function AskBar({ name, tool, writer, onAsk }: { name: string; tool: EngineTool; writer?: string | undefined; onAsk: (q: string, model: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const models = askModels(tool);
  const [model, setModel] = useState(() => askModelFor(tool));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const question = text.trim();
    if (!question || sending) return;
    setSending(true);
    setError("");
    try {
      await onAsk(question, model);
      setText("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="dd-askwrap">
    <form className="dd-askbar" onSubmit={(e) => void send(e)}>
      {error && (
        <p className="dd-askbar-error" role="alert">
          {error}
        </p>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
        rows={1}
        placeholder={`Ask about ${name}'s code`}
        aria-keyshortcuts="/"
        aria-label="Ask about the code"
      />
      <div className="dd-askbar-foot">
        {models.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="dd-askbar-model" aria-label={`Answered by ${writerOf(tool, modelName(tool, model) ?? writer)}. Change the model`}>
                <EngineMark tool={tool} size={12} />
                <span>{writerOf(tool, modelName(tool, model) ?? writer)}</span>
                <ChevronDownIcon aria-hidden="true" className="dd-tool-chev" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="w-[290px]">
              <DropdownMenuLabel className="text-[12px] font-medium text-[var(--text-muted)]">Answer with</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={model}
                onValueChange={(v) => {
                  setModel(v);
                  keepAskModel(tool, v);
                }}
              >
                {models.map((m) => (
                  <DropdownMenuRadioItem key={m.id} value={m.id} className="items-start">
                    <span className="dd-model-opt">
                      <span>
                        {m.label}
                        {m.id === SMALL_ID[tool] && <span className="dd-model-tag">Default</span>}
                      </span>
                      <span className="dd-model-blurb">{m.blurb}</span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className="dd-askbar-tool">
            <EngineMark tool={tool} size={12} /> {writerOf(tool, writer)} reads the code to answer
          </span>
        )}
        <button type="submit" className="dd-send" disabled={!text.trim() || sending} aria-label={sending ? "Asking" : "Ask"}>
          {sending ? <span className="dd-spin" aria-hidden="true" /> : <Icon name="arrowUp" size={14} />}
        </button>
      </div>
    </form>
    </div>
  );
}

/** "On this page": the page's sections, the one being read marked as it scrolls. */
function Outline({ headings }: { headings: string[] }) {
  const [on, setOn] = useState(0);
  const box = useRef<HTMLElement>(null);
  /** The section pressed: marked until the reader scrolls by hand, as a short one near the foot never reaches the top. */
  const pinned = useRef<number | null>(null);
  useEffect(() => {
    const scroller = box.current?.closest(".dd-grid");
    if (!scroller) return;
    const read = () => {
      if (pinned.current !== null) return setOn(pinned.current);
      // At the foot the last section is the one being read, though its heading never got to the top (Arun, 2026-11-12: "the On
      // this page thing doesnt highlight for the last section").
      if (scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) return setOn(headings.length - 1);
      let at = 0;
      headings.forEach((_, i) => {
        const h = document.getElementById(`dd-h-${i}`);
        if (h && h.getBoundingClientRect().top < 140) at = i;
      });
      setOn(at);
    };
    const free = () => (pinned.current = null);
    read();
    scroller.addEventListener("scroll", read, { passive: true });
    scroller.addEventListener("wheel", free, { passive: true });
    scroller.addEventListener("touchstart", free, { passive: true });
    addEventListener("keydown", free);
    return () => {
      scroller.removeEventListener("scroll", read);
      scroller.removeEventListener("wheel", free);
      scroller.removeEventListener("touchstart", free);
      removeEventListener("keydown", free);
    };
  }, [headings]);
  return (
    <aside className="dd-toc" aria-label="On this page" ref={box}>
      <p className="dd-side-label">On this page</p>
      <ul>
        {headings.map((h, i) => (
          <li key={`${i}-${h}`}>
            <button
              type="button"
              aria-current={on === i ? "location" : undefined}
              onClick={() => {
                pinned.current = i;
                setOn(i);
                document.getElementById(`dd-h-${i}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
              }}
            >
              {h}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function CodeView({ code, onClose }: { code: Code; onClose: () => void }) {
  const hit = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLPreElement>(null);
  // The cited lines brought into view inside the panel only: scrollIntoView moved the whole page under it too.
  useEffect(() => {
    if (box.current && hit.current) box.current.scrollTop = Math.max(0, hit.current.offsetTop - box.current.clientHeight / 4);
  }, [code]);
  const cut = code.file.lastIndexOf("/");
  return (
    <aside className="dd-code" aria-label={`The code: ${code.file}`}>
      <header className="dd-code-head">
        <FileIcon path={code.file} size={14} />
        <span className="dd-code-file" title={code.file}>
          {cut > 0 && <span className="dd-code-dir">{code.file.slice(0, cut + 1)}</span>}
          {code.file.slice(cut + 1)}
        </span>
        {"start" in code && <span className="dd-code-range">{code.start === code.end ? `line ${code.start}` : `lines ${code.start}–${code.end}`}</span>}
        <button type="button" className="icon-btn tiny" aria-label="Close the code" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </header>
      {"error" in code ? (
        <p className="dd-warn bad" role="note">
          <span className="dd-mark bad" aria-hidden="true" />
          <span>{code.error}</span>
        </p>
      ) : (
        <pre className="dd-code-lines" ref={box}>
          {code.lines.map((l, i) => {
            const n = code.from + i;
            const on = n >= code.start && n <= code.end;
            return (
              <div key={n} ref={n === code.start ? hit : undefined} className={on ? "on" : undefined}>
                <span className="n">{n}</span>
                <span className="t">{l || " "}</span>
              </div>
            );
          })}
        </pre>
      )}
    </aside>
  );
}
