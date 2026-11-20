/**
 * The message box in view. Code's chat column is kept, hidden, while Agents shows (and the other way round), so there can be two
 * boxes with this id: the one on screen is the one meant.
 */
export function visibleComposer(): HTMLTextAreaElement | null {
  const all = [...document.querySelectorAll<HTMLTextAreaElement>('textarea[id="composer-input"]')];
  return all.find((el) => el.offsetParent !== null) ?? all[0] ?? null;
}

/** Put words in the message box and leave the cursor at the end, for "Ask for changes". */
export function prefillComposer(text: string) {
  const el = visibleComposer();
  if (!el) return;
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  // Emptied first as React sees it, so the words read as a change even when they are the ones the box last held before it was
  // cleared: otherwise React heard nothing, the box showed them and Send stayed off (2026-10-28 QA: Edit on a queued message).
  el.value = "";
  set?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  el.setSelectionRange(text.length, text.length);
}
