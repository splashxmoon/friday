import type { MachineTool } from "../types.js";

/**
 * The open-source edition's machine links: there are none. Friday runs on the computer the work is on, so every "is a machine
 * linked for this person?" is no, and each place that asks goes on to this computer's own runner (app.ts, callHost).
 */
export class NoLinks {
  tokenFor(_userId: string): string | null {
    return null;
  }
  connected(_token: string): boolean {
    return false;
  }
  status(_token: string): { connected: boolean; tools?: MachineTool[] } {
    return { connected: false };
  }
  async owner(_token: string): Promise<{ id: string; name: string } | null> {
    return null;
  }
  async machineToken(_userId: string, _id: string): Promise<{ token: string; label: string } | null> {
    return null;
  }
  call<T = unknown>(_token: string, _method: string, _params: Record<string, unknown>, _ms?: number, _onProgress?: (v: unknown) => void): Promise<T> {
    return Promise.reject(new Error("No other computer is linked: Friday runs on this one."));
  }
}
