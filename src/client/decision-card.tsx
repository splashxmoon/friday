import { useEffect, useRef, useState } from "react";
import { ArrowUpIcon, CheckIcon, PencilLineIcon } from "lucide-react";
import "./decision-card.css";

/**
 * An agent's question to you, in the chat under its reply (Arun, 2026-11-17: "make the decision card look better in the chat", then
 * "bring back the card, and refine it more to be more simpler and cleaner"): one card, with no name or mark of its own (the reply over
 * it has them) and no Answer button: the question and why it asks, then a row per choice that answers in one press, the one the agent
 * recommends tagged. "Something else" becomes a line to write in, in place. Pressed, it says what you chose while it goes to the agent. The card docked over the box
 * (Activity.tsx AgentQuestion) stays as it is, for when this one is out of view.
 */
/**
 * Answers sent from a card, by the question's id: the reply over it is drawn again as the answer arrives (and again while it waits for
 * an agent that is offline), and the card said its choices again as if nothing had been sent. The docked card reads it too.
 */
const answered = new Map<number, string>();
export const answeredIn = (id: number): string | undefined => answered.get(id);

export function DecisionCard({ id, question, detail, options, recommended, onAnswer, done }: { /** The question's id (its seq), for what was sent from it. */ id: number; question: string; detail?: string; options: string[]; recommended?: string; /** Sends the answer; true once it went. */ onAnswer: (text: string) => Promise<boolean>; /** Already answered (read from the log): what was. */ done?: string }) {
  const [sent, setSent] = useState<{ text: string; state: "sending" | "sent" } | null>(() => ((t) => (t ? { text: t, state: "sent" } : null))(answered.get(id) ?? done));
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => void (writing && field.current?.focus()), [writing]);
  // A new question from the same agent starts fresh.
  useEffect(() => (setSent(((t) => (t ? { text: t, state: "sent" as const } : null))(answered.get(id) ?? done)), setWriting(false), setDraft("")), [id]);
  // Answered from elsewhere (another window, the log read again): said so.
  useEffect(() => void (done && setSent((x) => (x?.state === "sent" ? x : { text: done, state: "sent" }))), [done]);
  const answer = (text: string) => {
    const t = text.trim();
    if (!t || sent) return;
    setSent({ text: t, state: "sending" });
    void onAnswer(t).then((ok) => (ok && answered.set(id, t), setSent(ok ? { text: t, state: "sent" } : null)));
  };
  // The recommended choice first, as the one most likely pressed.
  const shown = recommended && options.includes(recommended) ? [recommended, ...options.filter((o) => o !== recommended)] : options;
  return (
    <div className="dq" role="group" aria-label={`Question: ${question}`}>
      <div className="dq-q">
        <p className="dq-ask">{question}</p>
        {detail && <p className="dq-why">{detail}</p>}
      </div>
      {sent ? (
        <div className="dq-sent" role="status">
          {sent.state === "sent" ? <CheckIcon className="dq-tick" aria-hidden="true" /> : <span className="ring-spin" aria-hidden="true" />}
          <span className="dq-sent-text">{sent.text}</span>
          <span className="dq-sent-word">{sent.state === "sent" ? "Sent" : "Sending…"}</span>
        </div>
      ) : (
        <div className="dq-list">
          {shown.map((o, i) => (
            <button key={o} type="button" className={`dq-opt${o === recommended ? " is-rec" : ""}`} onClick={() => answer(o)}>
              <kbd aria-hidden="true">{String.fromCharCode(65 + i)}</kbd>
              <span className="dq-opt-text">{o}</span>
              {o === recommended && <span className="dq-rec">Recommended</span>}
            </button>
          ))}
          {writing ? (
            <form
              className="dq-write"
              onSubmit={(e) => {
                e.preventDefault();
                answer(draft);
              }}
            >
              <PencilLineIcon className="dq-pen" aria-hidden="true" />
              <input ref={field} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setWriting(false), setDraft(""))} onBlur={() => !draft.trim() && setWriting(false)} placeholder="Your answer" aria-label="Your answer" />
              <button type="submit" className="dq-send" disabled={!draft.trim()} aria-label="Send the answer">
                <ArrowUpIcon aria-hidden="true" />
              </button>
            </form>
          ) : (
            <button type="button" className="dq-opt is-other" onClick={() => setWriting(true)}>
              <PencilLineIcon className="dq-pen" aria-hidden="true" />
              <span className="dq-opt-text">{options.length ? "Something else" : "Answer"}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
