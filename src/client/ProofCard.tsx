/**
 * Proof of work, as people check it (Arun, 2026-10-31: check a teammate's results at a glance instead of reading logs): a finished
 * task's checks, what it changed, a picture of the page it touched, and the teammate's own review of what it did, checked and is
 * unsure of (team-proof.ts). One line that says how it stands, opening to the whole proof; on the board's cards, the room's
 * results shelf, a teammate's Results and the brief. Work handed in without a review says so.
 */
import { useState } from "react";
import { ChevronRightIcon, CircleCheckIcon, CircleDashedIcon, CircleXIcon, FileDiffIcon, ImageIcon, TriangleAlertIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Proof } from "../team-proof.js";
import { fileUrl } from "./api.js";
import { useTeamNow, type Team } from "./Teammates.js";
import "./proof.css";

/** The picture's address: a file of the session it was taken in, read with that session's invite (the Crew room's or a room's). */
export function pictureOf(t: Team | null, p: Proof): string | null {
  const page = p.page;
  if (!page?.file || !page.sid) return null;
  const invite = t?.sid === page.sid ? t.invite : t?.rooms?.find((r) => r.sid === page.sid)?.invite;
  return invite ? fileUrl(page.sid, invite, page.file) : null;
}

const fileCount = (p: Proof) => p.changed.files.length + p.changed.more;
const shortUrl = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/$/, "");

/** How its checks stand: failed beats passed beats none. */
function checksOf(p: Proof): "ok" | "bad" | "none" {
  const ran = p.checks.filter((c) => !c.skipped);
  return ran.some((c) => !c.ok) ? "bad" : ran.length ? "ok" : "none";
}

/** The proof in one quiet row: its checks, its files, its picture, and its review when it has none. */
export function ProofFacts({ proof }: { proof: Proof }) {
  const c = checksOf(proof);
  const n = fileCount(proof);
  return (
    <span className="pf-facts">
      <span className="pf-fact" data-tone={c}>
        {c === "ok" ? <CircleCheckIcon /> : c === "bad" ? <CircleXIcon /> : <CircleDashedIcon />}
        {c === "ok" ? "Checks pass" : c === "bad" ? "Checks failed" : "No checks"}
      </span>
      {/* Passed with tests failing that already failed before the task began (baseline.ts): said, not hidden. */}
      {(() => {
        const pre = proof.checks.reduce((n, x) => n + (x.pre ?? 0), 0);
        return pre > 0 ? (
          <span className="pf-fact" title="These tests were already failing at the commit the teammate's copy started from, so they don't count against the task.">
            {pre} failing from before
          </span>
        ) : null;
      })()}
      {n > 0 && (
        <span className="pf-fact">
          <FileDiffIcon />
          {n} file{n === 1 ? "" : "s"}
          <span className="pf-num">
            +{proof.changed.add} −{proof.changed.del}
          </span>
        </span>
      )}
      {proof.page?.file && (
        <span className="pf-fact">
          <ImageIcon />
          Picture
        </span>
      )}
      {!proof.review && (
        <span className="pf-fact" data-tone="missing">
          No self-review
        </span>
      )}
    </span>
  );
}

/** The whole proof: the teammate's review first, then the checks, what changed, the page, and what to look out for. */
export function ProofDetail({ proof }: { proof: Proof }) {
  const t = useTeamNow();
  const picture = pictureOf(t, proof);
  const n = fileCount(proof);
  return (
    <div className="pf-detail">
      {proof.review ? (
        <dl className="pf-review">
          <dt>Did</dt>
          <dd>{proof.review.done}</dd>
          <dt>Checked</dt>
          <dd>{proof.review.checked}</dd>
          <dt>Unsure</dt>
          <dd>{proof.review.unsure}</dd>
        </dl>
      ) : (
        <p className="pf-missing">
          {proof.name || "It"} handed this in without a self-review: nothing said about what was checked or what is still uncertain.
        </p>
      )}
      <section className="pf-sec" aria-label="Checks">
        <h5>Checks</h5>
        {proof.checks.length ? (
          <ul className="pf-checks">
            {proof.checks.map((c) => (
              <li key={`${c.by}:${c.command}`} data-tone={c.skipped ? "none" : c.ok ? "ok" : "bad"}>
                {c.skipped ? <CircleDashedIcon /> : c.ok ? <CircleCheckIcon /> : <CircleXIcon />}
                <code title={c.command}>{c.command}</code>
                <span className="pf-by">{c.skipped ? "couldn't run" : c.by === "friday" ? "run by Friday" : "run by them"}</span>
                {c.output && <pre className="pf-out">{c.output}</pre>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="pf-none">No tests or checks ran.</p>
        )}
      </section>
      <section className="pf-sec" aria-label="What changed">
        <h5>
          Changed
          {n > 0 && (
            <span className="pf-num">
              {n} file{n === 1 ? "" : "s"} · +{proof.changed.add} −{proof.changed.del}
            </span>
          )}
        </h5>
        {n ? (
          <ul className="pf-files">
            {proof.changed.files.slice(0, 8).map((f) => (
              <li key={f.path} title={f.path}>
                <code>{f.path}</code>
                <span className="pf-num">{f.status === "added" ? "new" : f.status === "deleted" ? "deleted" : `+${f.add} −${f.del}`}</span>
              </li>
            ))}
            {n > 8 && <li className="pf-more">and {n - 8} more</li>}
          </ul>
        ) : (
          <p className="pf-none">No files changed.</p>
        )}
      </section>
      {proof.page && (
        <section className="pf-sec" aria-label="The page">
          <h5>
            Page<span className="pf-num">{shortUrl(proof.page.url)}</span>
          </h5>
          {picture ? (
            <a className="pf-shot" href={picture} target="_blank" rel="noreferrer" title="Open the picture">
              <img src={picture} alt={`The page at ${shortUrl(proof.page.url)}, as ${proof.name || "the teammate"} left it`} loading="lazy" width={proof.page.width} height={proof.page.height} />
            </a>
          ) : proof.page.file ? (
            // Taken in a room this person can't open (another member's own Crew room): it stays there.
            <p className="pf-none">Its picture is kept where the work was done, which you can't open.</p>
          ) : (
            <p className="pf-none">No picture: it is taken only where Friday's desktop app runs the teammate.</p>
          )}
        </section>
      )}
      {proof.flags.length > 0 && (
        <ul className="pf-flags" aria-label="Look out">
          {proof.flags.map((f) => (
            <li key={f.text} data-level={f.level}>
              <TriangleAlertIcon />
              {f.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Its facts as a row that opens to the whole proof in place: the shelf, Results and the brief. */
export function ProofToggle({ proof }: { proof: Proof }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pf-toggle" data-open={open ? "true" : undefined}>
      <button type="button" className="pf-row" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ProofFacts proof={proof} />
        <ChevronRightIcon className="pf-chev" aria-hidden="true" />
      </button>
      {open && <ProofDetail proof={proof} />}
    </div>
  );
}

/** Its facts as a button that opens the whole proof beside it: a board card, which has no room to open in place. */
export function ProofButton({ proof }: { proof: Proof }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="pf-row pf-row-btn" aria-label={`Proof for "${proof.title}"`}>
          <ProofFacts proof={proof} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="tm-pop pf-pop">
        <div className="tm-pop-head">
          <b>Proof</b>
          <span>{proof.name}</span>
        </div>
        <ProofDetail proof={proof} />
      </PopoverContent>
    </Popover>
  );
}
