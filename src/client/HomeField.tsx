import { memo, useEffect, useState } from "react";
import { FlickeringGrid } from "@/components/ui/flickering-grid";
import { reduceMotion } from "./prefs.js";

/**
 * A quiet field of small squares behind the new-session page, fading out towards the edges.
 *
 * It takes its colour from the theme on <html> and keeps following it, and it holds still for
 * anyone who turned motion down, in their settings or in the system.
 */
// Memoised: it takes nothing, and the page around it draws again on every keystroke in the message box.
export const HomeField = memo(function HomeField() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const [still, setStill] = useState(() => reduceMotion() || matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const root = document.documentElement;
    const read = () => {
      setDark(root.classList.contains("dark"));
      setStill(root.classList.contains("reduce-motion") || matchMedia("(prefers-reduced-motion: reduce)").matches);
    };
    const mo = new MutationObserver(read);
    mo.observe(root, { attributes: true, attributeFilter: ["class"] });
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    mq.addEventListener("change", read);
    return () => {
      mo.disconnect();
      mq.removeEventListener("change", read);
    };
  }, []);
  return (
    <div className="home-field" aria-hidden>
      <FlickeringGrid className="h-full w-full" squareSize={4} gridGap={7} flickerChance={still ? 0 : 0.08} color={dark ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)"} maxOpacity={dark ? 0.2 : 0.14} />
    </div>
  );
});
