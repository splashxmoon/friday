/**
 * A reply that says what it is about to do and then stops.
 *
 * "Let me look at the evaluation files." is a promise, and ending the turn
 * there breaks it: the person is left to type "continue" at something that
 * already knows what comes next. This recognises that shape — the last thing
 * said is an intention, not an answer — so the run can be told to carry on.
 * It errs towards letting a finished answer through: a wrong guess costs one
 * extra turn, a missed one costs the person's attention.
 */
const NOT_A_PROMISE = /let me know|i'll be (here|happy|glad|around)|i'll leave (it|this)|i will leave|let's (talk|chat|discuss)/i;
const INTENT = /^(?:(?:ok(?:ay)?|now|next|first|then|so|alright|great)[,.]?\s+)*(?:let me|let's|i'll|i will|i'm going to|i am going to|i need to|i should|i can now|going to)\b/i;

export function announcesAction(text: string): boolean {
  const t = text.trim();
  if (!t || t.endsWith("?")) return false;
  const last = t.split(/\n+/).filter(Boolean).at(-1)!.trim();
  // Said and left hanging: a colon with nothing after it promises what never comes.
  if (/:$/.test(last) && !/```/.test(t)) return true;
  const sentence = last.split(/(?<=[.!])\s+/).at(-1) ?? last;
  return !NOT_A_PROMISE.test(sentence) && INTENT.test(sentence.trim());
}
