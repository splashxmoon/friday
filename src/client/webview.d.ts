import type { DetailedHTMLProps, HTMLAttributes } from "react";

/**
 * Electron's <webview>: a page in its own process, which is how the Browser
 * tab shows a site the app didn't write. React doesn't know the tag, and the
 * browser build never renders one — the desktop app is the only caller.
 */
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { src?: string; partition?: string; allowpopups?: string };
    }
  }
}
