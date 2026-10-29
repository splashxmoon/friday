/**
 * A tooltip for the folded sidebar's rail (SideRail.tsx): what an icon is, and a line on how it stands, opening to its right
 * (Arun, 2026-10-27: "add the tool tip hover for the side bar when closed too for the teams section and stuff").
 *
 */
import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function RailTip({ label, sub, children }: { label: string; sub?: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={10} className="side-rail-tip">
        <b>{label}</b>
        {sub ? <span>{sub}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}
