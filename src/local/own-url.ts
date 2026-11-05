/**
 * Whether an address is the local Friday's own page (desktop.ts): its exact origin, never a prefix of it. "Starts with
 * http://127.0.0.1:4321" is also true of http://127.0.0.1:4321@evil.example (evil.example, signed in as "127.0.0.1") and of
 * another server at http://127.0.0.1:43210, and either would then keep the window and its bridge to this computer.
 */
export function isOwnUrl(target: string, appUrl: string): boolean {
  try {
    return new URL(target).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}
