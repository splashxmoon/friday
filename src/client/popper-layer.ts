/**
 * Where Radix's placed cards (hover cards, tooltips, popovers, selects, dropdowns: components/ui) are drawn: a layer on the page
 * that undoes Settings › Interface size's zoom (prefs.ts), with each card zoomed back inside it (style.css .popper-layer).
 *
 * Radix places a card from what the browser measures, in the window's pixels, and moves it in the page's, which the zoom
 * scales: at "Larger" the sidebar's Usage card ran off the bottom of the window (Arun, 2026-10-28: "TEST EVERYTHING… EVERY
 * INTERACTION, EVERY VISUAL"). Unzoomed, the two are the same pixels again. aria-live keeps the layer from being hidden from
 * a screen reader while a dialog is open (Radix hides everything else on the page then, but never a live region).
 */
let layer: HTMLElement | null = null;

export function popperLayer(): HTMLElement | undefined {
  if (typeof document === "undefined") return undefined;
  if (!layer || !layer.isConnected) {
    layer = document.createElement("div");
    layer.className = "popper-layer";
    layer.setAttribute("aria-live", "off");
    document.body.append(layer);
  }
  return layer;
}
