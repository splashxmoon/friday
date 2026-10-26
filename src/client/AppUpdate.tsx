import { useEffect, useState } from "react";
import { Icon } from "./icons.js";
import { MenuButton } from "./ui.js";
import { openOutside } from "./openOutside.js";
import type { DesktopUpdate } from "./Workspace.js";

/**
 * Which Friday this is, and the press that makes it the latest one.
 *
 * The window shows a hosted page, so the site can update under someone while
 * the app around it stays whatever they installed months ago. The app checks
 * on its own and asks once when a version is ready — this row is for the rest
 * of the time: the version they are on, and somewhere to look when they want
 * to know rather than be told.
 *
 * It draws nothing outside the desktop app, where there is no app to update.
 */

// Public, unlike the code: installers are what a download page is for.
const RELEASES = "https://github.com/splashxmoon/friday-releases/releases/latest";
const DOWNLOAD = "https://www.tryfridaywork.com/download";

const SAY: Record<DesktopUpdate["stage"], (s: DesktopUpdate) => string> = {
  idle: () => "Friday checks for updates on its own.",
  checking: () => "Looking for a newer version…",
  available: (s) => `Friday ${s.version} is downloading.`,
  downloading: (s) => `Downloading Friday ${s.version ?? ""} — ${s.percent ?? 0}%`,
  ready: (s) => `Friday ${s.version} is ready. Restarting takes a moment.`,
  current: () => "This is the latest version.",
  error: (s) => s.error ?? "Couldn't check for updates. Check your connection and try again.",
  unsupported: () => "Updates apply to an installed copy of Friday.",
};

/** The app's own account of updates, kept current as it talks back. Null outside the desktop app. */
function useAppUpdate() {
  const bridge = typeof window !== "undefined" ? window.fridayDesktop?.update : undefined;
  const [state, setState] = useState<DesktopUpdate | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void bridge.state().then((s) => live && setState(s), () => {});
    // The app talks back on its own schedule: a download that finishes while
    // this is open should say so without anyone pressing anything.
    const off = bridge.onState((s) => live && setState(s));
    return () => {
      live = false;
      off();
    };
  }, [bridge]);
  return { bridge, state, setState };
}

/**
 * A newer Friday, said where it can be seen.
 *
 * The row in Settings is for looking; this is for being told. When a newer
 * version exists a button appears in the rail, which is on screen in every
 * part of the app, with a dot so it reads as news. It opens a small card: which
 * version, how far the download is, and one button to restart into it. It is
 * not there when there is nothing to say, and not at all outside the desktop app.
 */
export function UpdateRailButton() {
  const { bridge, state } = useAppUpdate();
  if (!bridge || !state || !["available", "downloading", "ready"].includes(state.stage)) return null;
  const ready = state.stage === "ready";
  const pct = Math.max(0, Math.min(100, state.percent ?? 0));
  return (
    <MenuButton
      className={`rail-btn rail-update ${ready ? "ready" : ""}`}
      label={ready ? `Friday ${state.version ?? ""} is ready to install` : `Friday ${state.version ?? ""} is downloading`}
      width={284}
      beside
      items={() => [
        {
          height: ready ? 138 : 118,
          node: (
            <div className="upd-card">
              <div className="upd-top">
                <span className="upd-mark">
                  <Icon name="download" size={15} />
                </span>
                <div>
                  <div className="upd-title">{ready ? "Update ready" : "Update on the way"}</div>
                  <div className="upd-sub">
                    Friday {state.version ?? "—"} <span className="muted">· you have {state.current}</span>
                  </div>
                </div>
              </div>
              {ready ? (
                <button type="button" className="btn primary upd-go" onClick={() => void bridge.install()}>
                  Restart to update
                </button>
              ) : (
                <div className="upd-prog" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Downloading the update">
                  <span style={{ width: `${pct}%` }} />
                </div>
              )}
              <button type="button" className="link-btn upd-notes" onClick={() => openOutside(RELEASES)}>
                What's new <Icon name="external" size={11} />
              </button>
            </div>
          ),
        },
      ]}
    >
      <Icon name="download" size={19} />
      <span className="rail-update-dot" aria-hidden />
    </MenuButton>
  );
}

export function AppUpdate() {
  const { bridge, state, setState } = useAppUpdate();
  if (!bridge || !state) return null;

  const busy = state.stage === "checking" || state.stage === "downloading";
  return (
    <div className="settings-danger app-update">
      <div>
        <div className="set-label">Friday {state.current}</div>
        <div className={`small ${state.stage === "error" ? "error" : "muted"}`}>{SAY[state.stage](state)}</div>
      </div>
      {state.stage === "ready" ? (
        <button className="btn primary" type="button" onClick={() => void bridge.install()}>
          Restart to update
        </button>
      ) : state.stage === "error" || state.stage === "unsupported" ? (
        <button className="btn ghost" type="button" onClick={() => openOutside(DOWNLOAD)}>
          <Icon name="external" size={13} /> Downloads
        </button>
      ) : (
        <button className="btn ghost" type="button" disabled={busy} onClick={() => void bridge.check().then(setState)}>
          {busy ? <span className="spinner" /> : null} Check for updates
        </button>
      )}
    </div>
  );
}
