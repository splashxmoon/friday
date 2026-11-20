import type { IdeOpName, IdeOps } from "../../ide-contract.js";
import { hostApi } from "../local.js";
import type { Identity } from "../storage.js";

/** One call to this computer's runner for Code (src/ide-contract.ts), typed by op name. */
export function ide<K extends IdeOpName>(identity: Identity, op: K, params: IdeOps[K][0]): Promise<IdeOps[K][1]> {
  return hostApi<IdeOps[K][1]>(identity, `/api/runner/ide.${op}`, { method: "POST", body: JSON.stringify(params) });
}

/** The parameters of an op without its root, which the view fills in once for every call. */
export type Without<P> = P extends { root: string } ? Omit<P, "root"> : never;

/** What a failed call says, in a sentence. */
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)) || "Something went wrong.";

/** `ide()` with the identity and root already filled in: what the panels are handed. */
export type IdeCall = <K extends IdeOpName>(op: K, params: Without<IdeOps[K][0]>) => Promise<IdeOps[K][1]>;
