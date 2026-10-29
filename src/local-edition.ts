/**
 * Whether this process is the open-source edition (local/start.ts sets FRIDAY_EDITION=local), where Work and Crew run, or a
 * build with FRIDAY_MINE set. Never the hosted server, nor a product runner on someone's computer: a Work flag or a teammate
 * from any other server starts nothing (no auto mode, no browser, no network).
 */
export const localEdition = (): boolean => process.env.FRIDAY_EDITION === "local" || process.env.FRIDAY_MINE === "1";
