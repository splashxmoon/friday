import { useState } from "react";
import { RouteIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionHeader, surface } from "@/components/dass";
import { cn } from "@/lib/utils";
import { KIND_WORDS } from "../strengths.js";
import { api } from "./api.js";
import { rereadRouting, useRouting, type Routing } from "./RouteWhy.js";
import type { Identity } from "./storage.js";

/**
 * What routing learned (route-learning.ts learnedView), said so a person can check it: for each repo and kind of task where two
 * options have each run a few times, how the better one compares. Each can be reset, and everything at once; routing then goes
 * back to the benchmarks and what the workspace as a whole has shown, and learns again from the next runs.
 */
export function RoutingLearned({ identity }: { identity: Identity }) {
  const routing = useRouting(identity);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const runs = routing.records.length;

  const reset = async (scope: string) => {
    setBusy(scope);
    setError("");
    try {
      rereadRouting(await api<Routing>(identity, "/api/routing/reset", { method: "POST", body: JSON.stringify({ scope }) }));
    } catch (e) {
      setError((e as Error).message || "Couldn't reset that. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label="What routing learned">
      <SectionHeader
        title="What routing learned"
        count={routing.view.length || undefined}
        description={`From how runs here ended: whether they finished and passed their checks, what they cost and how long they took.${runs ? ` ${runs} run${runs === 1 ? "" : "s"} so far.` : ""}`}
        action={
          routing.view.length > 1 ? (
            <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void reset("*")}>
              {busy === "*" ? "Resetting…" : "Reset all"}
            </Button>
          ) : undefined
        }
      />
      {error && (
        <p role="alert" className="mt-0 mb-2 text-[13px] text-[var(--red)]">
          {error}
        </p>
      )}
      {!routing.view.length ? (
        <EmptyState small icon={<RouteIcon />} title={runs ? "Nothing to say yet" : "No runs yet"} className="py-8">
          {runs
            ? "Once two agents have each done a few runs of the same kind of task in a repo, what one does better shows here."
            : "Each finished run is counted. What routing learns from them shows here."}
        </EmptyState>
      ) : (
        <ul className={cn(surface, "rl-list")}>
          {routing.view.map((item) => (
            <li key={item.scope} className="rl-row">
              <div className="rl-text">
                <p className="rl-says">{item.text}</p>
                <p className="rl-from">
                  {item.kind ? KIND_WORDS[item.kind] : "other tasks"} · from {item.runs} run{item.runs === 1 ? "" : "s"}
                </p>
              </div>
              <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void reset(item.scope)} aria-label={`Reset: ${item.text}`}>
                {busy === item.scope ? "Resetting…" : "Reset"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
