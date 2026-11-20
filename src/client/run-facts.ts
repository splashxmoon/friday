import { createContext } from "react";
import type { RunSeen } from "./refactor-plan.js";

/**
 * What Friday itself saw of the run an answer belongs to (the files it changed, the tests it saw run), for the parts of an answer
 * that report on the run: a refactor's closing line says Friday's number, not only the agent's (Activity's run card provides it).
 */
export const RunFacts = createContext<RunSeen | null>(null);
