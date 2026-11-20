import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons.js";
import { hostApi } from "./local.js";
import { getIdeRoot, IdeChatContext, ideHint, useMode } from "./ide/mode.js";
import { MenuButton } from "./ui.js";
import { mergeStackPart, moveStackPart, stackCounts, type StackPlan } from "../stack-plan.js";
import "./stack-card.css";

/** What the runner says a stack would be (runner/stack-pr.ts Preview), as far as this card draws it. */
interface Preview {
  branch: string;
  base: string;
  names: string[];
  parts: { files: string[] }[];
  skipped: string[];
  left: string[];
  remote: boolean;
  gh: { ok: boolean; why: string };
}
interface Made {
  base: string;
  parts: { branch: string; title: string; url?: string; number?: number; created: boolean; error?: string }[];
  notes: string[];
  /** The stack was only partly made (a push failed after the first): its id. The card then offers "Finish the stack", never a second set. */
  partial?: string;
}

const MADE_KEY = "friday.stack.made";
/** The stacks made from this page, by the proposal and folder they came from: a reload shows the result, not the button again (which would make a second set). */
function madeBefore(key: string): Made | null {
  try {
    const all = JSON.parse(localStorage.getItem(MADE_KEY) ?? "{}") as Record<string, Made>;
    return all[key] ?? null;
  } catch {
    return null;
  }
}
function rememberMade(key: string, made: Made) {
  try {
    const all = JSON.parse(localStorage.getItem(MADE_KEY) ?? "{}") as Record<string, Made>;
    const keys = Object.keys(all).slice(-19);
    localStorage.setItem(MADE_KEY, JSON.stringify({ ...Object.fromEntries(keys.map((k) => [k, all[k]!])), [key]: made }));
  } catch {
    // Not remembered: the card shows the button again after a reload.
  }
}

/** The agent's proposal to split a big change as a card (Arun, 2026-11-19, wave 3: "Stacked PRs: split a big change into a stack of small PRs, each based on the last, kept rebased for you"): the parts in the order they merge, each with its files, which can be moved or merged, then Make the stack. */
export function StackCard({ plan: first }: { plan: StackPlan }) {
  const [plan, setPlan] = useState(first);
  const [open, setOpen] = useState<number | null>(null);
  const [seen, setSeen] = useState<Preview | null>(null);
  const [trouble, setTrouble] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [mode] = useMode();
  const chat = useContext(IdeChatContext);
  const root = chat ? (getIdeRoot() ?? "") : "";
  const sig = JSON.stringify(first);
  const madeKey = useMemo(() => `${root}\n${sig}`, [root, sig]);
  const [made, setMade] = useState<Made | null>(() => (root ? madeBefore(madeKey) : null));
  // The same card, drawn again with a proposal that has changed: start from it.
  const was = useRef(sig);
  useEffect(() => {
    if (was.current === sig) return;
    was.current = sig;
    setPlan(first);
    setOpen(null);
    setMade(root ? madeBefore(madeKey) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // What making it would do, said before the button is pressed: asked again a moment after the parts change.
  const planKey = JSON.stringify(plan);
  useEffect(() => {
    if (!root || !chat || made) return;
    let live = true;
    const t = window.setTimeout(() => {
      hostApi<Preview>(chat.identity, "/api/runner/stack.preview", { method: "POST", body: JSON.stringify({ root, plan }) }).then(
        (p) => live && (setSeen(p), setTrouble(p.remote ? "" : "This repository has no remote called origin to push to.")),
        (e: Error) => live && (setSeen(null), setTrouble(e.message || "Couldn't look at the folder.")),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, root, !!made]);

  const move = (i: number, by: -1 | 1) => setPlan((p) => moveStackPart(p, i, by));
  const merge = (i: number, w: -1 | 1) => {
    setPlan((p) => mergeStackPart(p, i, w));
    setOpen(null);
  };
  const edited = planKey !== JSON.stringify(first);
  const finishing = made?.partial;
  const madeDone = made && !made.partial ? made : null;
  // Finish a stack that was only partly made: Restack pushes the rest and opens the pull requests that are missing.
  const finish = () => {
    if (busy || !chat || !root || !finishing) return;
    setBusy(true);
    setErr("");
    hostApi<{ ok: boolean; base: string; parts: { branch: string; title?: string; url?: string; number?: number }[]; notes: string[]; error?: string; conflict?: unknown }>(chat.identity, "/api/runner/stack.restack", { method: "POST", body: JSON.stringify({ root, id: finishing }) }).then(
      (r) => {
        setBusy(false);
        if (!r.ok) return setErr(r.error || "It stopped on a conflict: open the Stack view.");
        const m: Made = { base: r.base, parts: r.parts.map((x) => ({ branch: x.branch, title: x.title ?? x.branch, ...(x.url ? { url: x.url } : {}), ...(x.number ? { number: x.number } : {}), created: !!x.number })), notes: r.notes };
        rememberMade(madeKey, m);
        setMade(m);
        window.dispatchEvent(new CustomEvent("friday:vsc-command", { detail: "showStack" }));
      },
      (e: Error) => {
        setErr(e.message || "That didn't work.");
        setBusy(false);
      },
    );
  };
  const make = () => {
    if (busy || !chat || !root) return;
    setBusy(true);
    setErr("");
    hostApi<Made>(chat.identity, "/api/runner/stack.make", { method: "POST", body: JSON.stringify({ root, plan }) }).then(
      (m) => {
        rememberMade(madeKey, m);
        setMade(m);
        setBusy(false);
        window.dispatchEvent(new CustomEvent("friday:vsc-command", { detail: "showStack" }));
      },
      (e: Error) => {
        const msg = e.message || "That didn't work.";
        // Some branches are pushed and the stack is kept: from here it is finished, not made again.
        if (/^Pushed \d+ of \d+ parts/.test(msg) && seen?.names[0]) {
          const m: Made = { base: seen.base, parts: [], notes: [], partial: seen.names[0] };
          rememberMade(madeKey, m);
          setMade(m);
        }
        setErr(msg);
        setBusy(false);
      },
    );
  };
  const openFile = (path: string) => window.dispatchEvent(new CustomEvent("friday:open-file", { detail: { path }, cancelable: true }));
  const two = plan.parts.length >= 2;
  const dropped = seen ? plan.parts.length - seen.parts.length : 0;
  const inIde = mode === "code";
  const canMake = !!chat && !!root && two && !trouble && !busy;
  return (
    <div className="stk-card" role="group" aria-label="Stack of pull requests">
      <div className="stk-head">
        <span className="stk-mark" aria-hidden="true"><Icon name="gitPullRequest" size={14} /></span>
        <b>Stack of pull requests</b>
        <span className="stk-counts"><i aria-hidden="true">·</i>{stackCounts(plan)}</span>
      </div>
      <p className="stk-lead">The first part is based on the main branch, each next one on the part before it.</p>
      <ol className="stk-parts" aria-label="Parts, in the order they merge">
        {plan.parts.map((p, i) => (
          <li key={`${i}:${p.title}`} className="stk-part">
            <span className="stk-n" aria-hidden="true">{i + 1}</span>
            <div className="stk-body">
              <div className="stk-title">{p.title}</div>
              {p.why && <div className="stk-why">{p.why}</div>}
              <button type="button" className="stk-files" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
                {p.files.length} file{p.files.length === 1 ? "" : "s"}
                <Icon name="chevronRight" size={11} className="stk-car" />
              </button>
              {open === i && (
                <div className="stk-list" role="group" aria-label={`Files in part ${i + 1}`}>
                  {p.files.map((f) => (
                    <button key={f} type="button" className="stk-file" title={`Open ${f}${ideHint()}`} onClick={() => openFile(f)}>{f}</button>
                  ))}
                </div>
              )}
            </div>
            {!made && (
              <div className="stk-tools">
                <button type="button" className="stk-tool" aria-label={`Move part ${i + 1} up`} title="Earlier: closer to the main branch" disabled={i === 0} onClick={() => move(i, -1)}>
                  <Icon name="arrowUp" size={12} />
                </button>
                <button type="button" className="stk-tool" aria-label={`Move part ${i + 1} down`} title="Later" disabled={i === plan.parts.length - 1} onClick={() => move(i, 1)}>
                  <Icon name="arrowDown" size={12} />
                </button>
                <MenuButton
                  end
                  compact
                  label={`More for part ${i + 1}`}
                  className="stk-tool"
                  items={() => [
                    i > 0 && { label: "Merge into the part above", icon: "gitMerge", onSelect: () => merge(i, -1) },
                    i < plan.parts.length - 1 && { label: "Merge into the part below", icon: "gitMerge", onSelect: () => merge(i, 1) },
                  ]}
                />
              </div>
            )}
          </li>
        ))}
      </ol>
      {madeDone ? (
        <div className="stk-made" role="status">
          <div className="stk-made-head">
            <Icon name="check" size={13} />
            {madeDone.parts.every((p) => p.created) ? `Opened ${madeDone.parts.length} pull requests` : `Pushed ${madeDone.parts.length} branches`}
          </div>
          <ul className="stk-links">
            {madeDone.parts.map((p, i) => (
              <li key={p.branch}>
                <span className="stk-ln">{i + 1}</span>
                {p.url ? (
                  <a href={p.url} target="_blank" rel="noopener noreferrer" title={p.created ? p.url : "Open this pull request on GitHub"}>
                    {p.number ? `#${p.number}` : "Open on GitHub"}
                    <span className="stk-lb">{p.branch}</span>
                  </a>
                ) : (
                  <span>{p.branch}</span>
                )}
              </li>
            ))}
          </ul>
          {madeDone.parts.some((p) => p.error) && <p className="stk-note">{madeDone.parts.find((p) => p.error)!.error}. Each branch is pushed: open its pull request from the link, based on the branch before it.</p>}
          {madeDone.notes.map((n) => (
            <p key={n} className="stk-note">{n}</p>
          ))}
        </div>
      ) : finishing ? (
        <>
          <p className="stk-note stk-warn">Only some of the branches were pushed. The stack is kept: finishing it pushes the rest and opens the pull requests, without making a second set.</p>
          <div className="stk-acts">
            <button type="button" className="stk-btn on" disabled={busy || !chat} onClick={finish}>
              {busy ? "Finishing the stack…" : "Finish the stack"}
            </button>
            {err && <span className="stk-said stk-bad" role="alert">{err}</span>}
          </div>
        </>
      ) : (
        <>
          {!chat ? (
            <p className="stk-note">Open this chat in Code to make the stack: it works on the folder Code has open.</p>
          ) : trouble ? (
            <p className="stk-note stk-warn">{trouble}</p>
          ) : seen ? (
            <div className="stk-plan">
              <p className="stk-note">
                {seen.names.length > 1 ? <>Makes <code>{seen.names[0]}</code> to <code>{seen.names[seen.names.length - 1]}</code>, starting from <code>{seen.base}</code>. </> : null}
                {seen.branch ? <>Your own branch, <code>{seen.branch}</code>, and your files</> : <>Your files</>} stay as they are.
              </p>
              {!seen.gh.ok && <p className="stk-note stk-warn">{seen.gh.why.charAt(0).toUpperCase() + seen.gh.why.slice(1)}. The branches are pushed, and each comes with GitHub's page to open its pull request.</p>}
              {seen.left.length > 0 && <p className="stk-note">{seen.left.length} changed file{seen.left.length === 1 ? " isn't" : "s aren't"} in any part, so {seen.left.length === 1 ? "it goes" : "they go"} in the last one.</p>}
              {dropped > 0 && <p className="stk-note">{dropped} part{dropped === 1 ? " has" : "s have"} no changed files and {dropped === 1 ? "is" : "are"} left out.</p>}
            </div>
          ) : null}
          {!two && <p className="stk-note">A stack needs two parts. Split it further, or open one pull request.</p>}
          <div className="stk-acts">
            {chat && (
              <button type="button" className="stk-btn on" disabled={!canMake} onClick={make} title={canMake ? "Make a branch for each part and open the pull requests" : undefined}>
                {busy ? "Making the stack…" : "Make the stack"}
              </button>
            )}
            {edited && !busy && (
              <button type="button" className="stk-btn plain" onClick={() => (setPlan(first), setOpen(null))}>
                Start over
              </button>
            )}
            {err && <span className="stk-said stk-bad" role="alert">{err}</span>}
          </div>
        </>
      )}
      {madeDone && inIde && (
        <div className="stk-acts">
          <button type="button" className="stk-btn" onClick={() => window.dispatchEvent(new CustomEvent("friday:vsc-command", { detail: "showStack" }))}>
            Open the stack
          </button>
        </div>
      )}
    </div>
  );
}
