import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// Settings › Other agents (MCP) is gone from the open-source app (Arun, 2026-11-14: "get rid of this too"). What it set up, Friday's
// MCP server for the coding tools on this computer (outside-mcp.ts), still answers anyone who added it; the copy mark stays here.

/** Copy, as a mark beside what it copies: the same in Your computers' command and link. */
export function CopyMark({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
      <Tooltip open={copied || undefined}>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="size-7 shrink-0"
            aria-label={copied ? `${label} copied` : `Copy ${label}`}
            onClick={() => void navigator.clipboard.writeText(text).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{copied ? "Copied" : "Copy"}</TooltipContent>
      </Tooltip>
  );
}
