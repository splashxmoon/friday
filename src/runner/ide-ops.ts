import type { IdeOpName, IdeOps } from "../ide-contract.js";
import { IDE_FS } from "./ide.js";
import { IDE_GIT } from "./ide-git.js";

/**
 * Code, the built-in IDE's ops on this computer (src/ide-contract.ts): the files and search half (ide.ts) and the git half
 * (ide-git.ts), dispatched by name from local-api.ts as `ide.<name>`.
 */
type Handler<K extends IdeOpName> = (params: IdeOps[K][0]) => Promise<IdeOps[K][1]>;
export type IdeHandlers = { [K in IdeOpName]?: Handler<K> };

const ALL: IdeHandlers = { ...IDE_FS, ...IDE_GIT };

export const IDE_OP_NAMES = Object.keys(ALL).map((k) => `ide.${k}`);

export async function ideOp(method: string, params: Record<string, unknown>): Promise<unknown> {
  const name = method.slice("ide.".length) as IdeOpName;
  const h = ALL[name] as ((p: unknown) => Promise<unknown>) | undefined;
  if (!h) throw new Error(`Unknown IDE op: ${method}`);
  return h(params);
}
