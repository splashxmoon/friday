/** Open Settings, on a particular tab. The sidebar owns the dialog; this is how anything else reaches it. */
export function openSettings(tab?: string): void {
  window.dispatchEvent(new CustomEvent("friday:settings", { detail: { tab } }));
}
