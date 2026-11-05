/** Put words in the message box and leave the cursor at the end, for "Ask for changes". */
export function prefillComposer(text: string) {
  const el = document.getElementById("composer-input") as HTMLTextAreaElement | null;
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
