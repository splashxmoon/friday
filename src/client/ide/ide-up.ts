/**
 * Whether the IDE's workspace is mounted (not the install card, the loading blank or "can't run here"): what the actions that need it
 * wait on. On its own so the first screen can ask it without loading the IDE palette's runner (palette-run.ts, test/client-bundle).
 */
let ideUp = false;
export const ideIsUp = (): boolean => ideUp;
export const setIdeUp = (up: boolean): void => {
  ideUp = up;
};
