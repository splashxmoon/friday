import { setEdition } from "./edition.js";

/**
 * The open-source edition, said before anything else is loaded: local-main.tsx imports this first, so every module evaluated
 * after it (the pages, and anything they work out as they load) already reads `isLocal()` as true.
 */
setEdition("local");
document.documentElement.dataset.edition = "local";
