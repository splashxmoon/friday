import type { SVGProps } from "react";

/**
 * The cards' own marks that the rest of the app doesn't use (GenUI.tsx), drawn here from lucide's shapes (ISC): imported from
 * lucide, even one by one, they went into every chat's first load, since lucide's index there reaches every icon.
 */
type Shape = [string, Record<string, string>][];
const icon = (shape: Shape) =>
  function Mark(p: SVGProps<SVGSVGElement>) {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...p}>
        {shape.map(([tag, a], i) => {
          const T = tag as "path";
          return <T key={i} {...a} />;
        })}
      </svg>
    );
  };

export const AtSignIcon = icon([["circle", { cx: "12", cy: "12", r: "4" }], ["path", { d: "M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" }]]);
export const CalendarClockIcon = icon([["path", { d: "M16 14v2.2l1.6 1" }], ["path", { d: "M16 2v3" }], ["path", { d: "M21 7.338V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h2.338" }], ["path", { d: "M3 9h5.859" }], ["path", { d: "M8 2v3" }], ["circle", { cx: "16", cy: "16", r: "6" }]]);
export const Columns2Icon = icon([["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }], ["path", { d: "M12 3v18" }]]);
export const FlaskConicalIcon = icon([["path", { d: "M6.453 15h11.094" }], ["path", { d: "M8.5 2h7" }]]);
export const ImagesIcon = icon([["path", { d: "m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16" }], ["path", { d: "M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2" }], ["circle", { cx: "13", cy: "7", r: "1", fill: "currentColor" }], ["rect", { x: "8", y: "2", width: "14", height: "14", rx: "2" }]]);
export const ScaleIcon = icon([["path", { d: "M12 3v18" }], ["path", { d: "m19 8 3 8a5 5 0 0 1-6 0zV7" }], ["path", { d: "M3 7h1a17 17 0 0 0 8-2 17 17 0 0 0 8 2h1" }], ["path", { d: "m5 8 3 8a5 5 0 0 1-6 0zV7" }], ["path", { d: "M7 21h10" }]]);
export const TableIcon = icon([["path", { d: "M12 3v18" }], ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }], ["path", { d: "M3 9h18" }], ["path", { d: "M3 15h18" }]]);
export const TextCursorInputIcon = icon([["path", { d: "M12 20h-1a2 2 0 0 1-2-2 2 2 0 0 1-2 2H6" }], ["path", { d: "M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7" }], ["path", { d: "M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1" }], ["path", { d: "M6 4h1a2 2 0 0 1 2 2 2 2 0 0 1 2-2h1" }], ["path", { d: "M9 6v12" }]]);
export const TrendingDownIcon = icon([["path", { d: "M16 17h6v-6" }], ["path", { d: "m22 17-8.5-8.5-5 5L2 7" }]]);
export const TrendingUpIcon = icon([["path", { d: "M16 7h6v6" }], ["path", { d: "m22 7-8.5 8.5-5-5L2 17" }]]);
export const VideoIcon = icon([["rect", { x: "2", y: "6", width: "14", height: "12", rx: "2" }]]);
