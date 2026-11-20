import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Choice, dangerOutline, Note, SettingsGroup, SettingsRow } from "@/components/dass";
import { hostApi } from "../local.js";
import type { Identity } from "../storage.js";
import { openInCode } from "./mode.js";
import { formatBytes, progressOf, type VsStatus } from "./vscode-util.js";

/**
 * Settings › Coding tools › Editor: VS Code, which Code always shows (Friday's own editor is gone, Arun 2026-11-19), how much room
 * it takes on disk (the build, and apart from it the extensions and settings a person adds), and Remove: VS Code alone
 * (their extensions and settings stay, and are said to), or everything. Local edition only.
 */
export function EditorSettings({ identity }: { identity: Identity }) {
  const [status, setStatus] = useState<VsStatus | null>(null);
  const [unknown, setUnknown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [err, setErr] = useState("");
  const call = (op: string, body: object = {}) => hostApi<VsStatus>(identity, `/api/runner/vscode.${op}`, { method: "POST", body: JSON.stringify(body) });

  // One look when the page opens (counting what is on disk), and quick ones while an install runs.
  const installing = !!status?.installing;
  useEffect(() => {
    let stop = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const look = () =>
      call("status", { sizes: true }).then(
        (s) => {
          if (stop) return;
          setStatus(s);
          if (s.installing) t = setTimeout(look, 1000);
        },
        () => !stop && setUnknown(true),
      );
    void look();
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [identity, installing]); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async (all: boolean) => {
    setBusy(true);
    setErr("");
    try {
      setStatus(await call("remove", all ? { all: true } : {}));
      setConfirm(false);
      setRemoved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't remove Friday IDE.");
    } finally {
      setBusy(false);
    }
  };


  const supported = !!status?.supported;
  const have = status?.installed ?? null;
  const kept = status?.dataBytes ? formatBytes(status.dataBytes) : "";
  const build = have && have.bytes > 0 ? formatBytes(have.bytes) : "";
  // Shipped inside Friday's app (Arun, 2026-11-19: "just package it up within friday"): said so, with nothing to remove.
  const hint = have?.bundled
    ? `Included with Friday · version ${have.version}${build ? ` · ${build}` : ""}.${kept ? ` Your extensions and settings take ${kept}.` : ""}`
    : have
    ? confirm
      ? `Frees ${build || "its room"}.${kept ? ` Your Friday IDE settings and extensions (${kept}) are kept, unless you remove everything.` : " Your Friday IDE settings and extensions are kept."}`
      : `Version ${have.version}${build ? ` · ${build}` : ""} in ${have.dir}.${kept ? ` Your extensions and settings take another ${kept}.` : ""}`
    : installing
      ? progressOf(status!.installing!).line
      : removed
        ? "Not installed. Code shows the install card."
        : status?.downloadBytes
          ? `Not installed. ${formatBytes(status.downloadBytes)} to download, about ${formatBytes(status.unpackedBytes ?? 660_000_000)} on disk.`
          : "Not installed.";
  return (
    <SettingsGroup title="Editor">
      {supported && (
        <SettingsRow label="Friday IDE" hint={hint}>
          {have ? (
            confirm ? (
              <>
                <Button variant="outline" size="sm" className={dangerOutline} disabled={busy} onClick={() => void remove(false)}>
                  {busy ? "Removing…" : "Remove Friday IDE"}
                </Button>
                <Button variant="outline" size="sm" className={dangerOutline} disabled={busy} onClick={() => void remove(true)}>
                  Remove everything
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm(false)}>
                  Keep it
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={() => openInCode()}>
                  Open Code
                </Button>
                {!have.bundled && (
                  <Button variant="outline" size="sm" className={dangerOutline} onClick={() => setConfirm(true)}>
                    Remove…
                  </Button>
                )}
              </>
            )
          ) : (
            !installing && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setErr("");
                  setRemoved(false);
                  call("install").then(setStatus, (e) => setErr(e instanceof Error ? e.message : "Couldn't start the download.")).finally(() => setBusy(false));
                }}
              >
                Install VS Code
              </Button>
            )
          )}
          {installing && (
            <Button variant="ghost" size="sm" onClick={() => call("cancel").then(setStatus, () => {})}>
              Cancel
            </Button>
          )}
        </SettingsRow>
      )}
      {(err || status?.error) && !installing && <Note ok={false}>{err || status?.error}</Note>}
      {supported && have && <MarketplaceRows identity={identity} />}
    </SettingsGroup>
  );
}

interface Market { serviceUrl: string; itemUrl: string }
interface MarketState { marketplace: Market; custom: boolean; default: Market }

/**
 * Where VS Code's Extensions view searches (Arun, 2026-11-19: "make sure we are able to load all of the extensions offered", with
 * Devin's two marketplace fields as the model): Open VSX unless another gallery's two addresses are given. Saving stops VS Code,
 * which starts on the new gallery the next time Code opens.
 */
function MarketplaceRows({ identity }: { identity: Identity }) {
  const [state, setState] = useState<MarketState | null>(null);
  const [service, setService] = useState("");
  const [item, setItem] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const call = (body: object = {}) => hostApi<MarketState>(identity, "/api/runner/vscode.marketplace", { method: "POST", body: JSON.stringify(body) });
  const take = (s: MarketState) => {
    setState(s);
    setService(s.marketplace.serviceUrl);
    setItem(s.marketplace.itemUrl);
  };
  useEffect(() => {
    let stop = false;
    call().then((s) => !stop && take(s), () => {});
    return () => {
      stop = true;
    };
  }, [identity]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!state) return null;
  const changed = service.trim() !== state.marketplace.serviceUrl || item.trim() !== state.marketplace.itemUrl;
  const save = async (body: object, done: string) => {
    setBusy(true);
    setNote(null);
    try {
      take(await call(body));
      setNote({ ok: true, text: done });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "Couldn't save the marketplace." });
    } finally {
      setBusy(false);
    }
  };
  const field = (id: string, label: string, hint: string, value: string, set: (v: string) => void, placeholder: string) => (
    <SettingsRow stack label={label} hint={hint} htmlFor={id}>
      <Input id={id} className="h-8 font-mono text-[12.5px] md:text-[12.5px]" value={value} spellCheck={false} autoComplete="off" placeholder={placeholder} onChange={(e) => set(e.target.value)} />
    </SettingsRow>
  );
  return (
    <>
      {field("vsc-gallery", "Extension marketplace", "Where the Extensions view searches. Open VSX unless you set another gallery.", service, setService, state.default.serviceUrl)}
      {field("vsc-gallery-item", "Marketplace item address", "The page each extension links to.", item, setItem, state.default.itemUrl)}
      <div className="flex flex-wrap items-center justify-end gap-2 pb-3.5">
        {note && <Note ok={note.ok} className="mr-auto">{note.text}</Note>}
        {state.custom && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void save({ reset: true }, "Back on Open VSX. the IDE uses it the next time Code opens.")}>
            Use Open VSX
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={busy || !changed || !service.trim() || !item.trim()} onClick={() => void save({ serviceUrl: service.trim(), itemUrl: item.trim() }, "Saved. the IDE uses it the next time Code opens.")}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </>
  );
}
