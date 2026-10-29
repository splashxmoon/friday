import { seesByName } from "../own-vision.js";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { isOwnModel } from "../own-model-id.js";
import { api } from "./api.js";
import { EngineMark, VendorMark } from "./BrandMarks.js";
import { machineError } from "./GitHubConnect.js";
import { Icon } from "./icons.js";
import { NoMachine, hostApi, useMachine } from "./local.js";
import { loadOwnModels, useOwnModels, type OwnChoice } from "./ownModelStore.js";
import type { Identity } from "./storage.js";
import { MenuButton, useConfirm, type MenuItem } from "./ui.js";
import type { WorkspaceUsage } from "./workspace-types.js";

/**
 * Settings › Your models: bring your own key, or a model running on this computer, for Friday's agent.
 *
 * Every plan. On Solo it is what gives Friday's agent a model at all; on Team it is any model you like on your own bill,
 * never counted against the workspace's allowance. Keys stay on this computer (runner/own-models.ts): Friday's agent
 * reaches the model through it, which is also why a model running on this computer works. In the open-source edition it is
 * what Friday Code runs on, beside your coding tools.
 */

/** Where people get models, with the address each one's OpenAI-compatible API lives at. */
/** `keys`: where the provider hands out keys, for the form's "Get a key". */
const PRESETS: { id: string; name: string; baseUrl: string; key: boolean; hint: string; keys?: string }[] = [
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", key: true, hint: "gpt-6.1-sol, gpt-6-luna", keys: "https://platform.openai.com/api-keys" },
  { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", key: true, hint: "claude-sonnet-5-5, claude-opus-5-5", keys: "https://console.anthropic.com/settings/keys" },
  { id: "google", name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", key: true, hint: "gemini-3.8-flash", keys: "https://aistudio.google.com/apikey" },
  { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", key: true, hint: "Fast open models", keys: "https://console.groq.com/keys" },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", key: true, hint: "deepseek-chat, deepseek-reasoner", keys: "https://platform.deepseek.com/api_keys" },
  { id: "mistral", name: "Mistral", baseUrl: "https://api.mistral.ai/v1", key: true, hint: "mistral-large-latest, codestral-latest", keys: "https://console.mistral.ai/api-keys" },
  { id: "xai", name: "xAI", baseUrl: "https://api.x.ai/v1", key: true, hint: "Grok models: List models shows them", keys: "https://console.x.ai" },
  { id: "together", name: "Together", baseUrl: "https://api.together.xyz/v1", key: true, hint: "Open models, hosted", keys: "https://api.together.ai/settings/api-keys" },
  { id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", key: false, hint: "Models you pulled with ollama pull" },
  { id: "lmstudio", name: "LM Studio", baseUrl: "http://localhost:1234/v1", key: false, hint: "Models loaded in LM Studio's server" },
  { id: "custom", name: "Another server", baseUrl: "", key: true, hint: "Anything that speaks the OpenAI chat API" },
];
const presetOf = (id?: string) => PRESETS.find((p) => p.id === id);
const LOGO: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google", deepseek: "DeepSeek" };
const LOCAL_IDS = new Set(["ollama", "lmstudio"]);

/**
 * A provider's mark: its logo where the app has one, else its initial; each in the same small tile, so a list of them reads as
 * one column rather than logos mixed with letter badges (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
 */
function ProviderMark({ id, size = 15 }: { id?: string; size?: number }) {
  const p = presetOf(id);
  const inner = Math.round(size * 0.75);
  return (
    <span className="own-mono" style={{ width: size + 3, height: size + 3 }} aria-hidden>
      {id && LOGO[id] ? <VendorMark vendor={LOGO[id]} size={inner} /> : id === "xai" ? <EngineMark tool="grok" size={inner} /> : id === "custom" || !p ? <Icon name="globe" size={inner} /> : p.name[0]}
    </span>
  );
}

/** What to show in an empty Model box: a model's name the provider has, where its line names some, never its description. */
export function modelExample(hint: string): string {
  const first = hint.split(",")[0]!.trim();
  return /^[\w.:/-]+$/.test(first) && /[-\d]/.test(first) ? first : "The model's name, or List models";
}

/** One of the app's menus dressed as a field: what is chosen, its mark, and a caret. Its menu is as wide as it is (it was 300px
 * under a 417px field) (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"). */
function Field({ label, mark, text, items, width = 300, placeholder }: { label: string; mark?: ReactNode; text: string; items: () => MenuItem[]; width?: number; placeholder?: boolean }) {
  const box = useRef<HTMLSpanElement>(null);
  const [w, setW] = useState(width);
  useLayoutEffect(() => {
    const el = box.current?.firstElementChild as HTMLElement | null;
    if (!el || typeof ResizeObserver === "undefined") return;
    const fit = () => setW(Math.max(width, Math.round(el.getBoundingClientRect().width)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);
  return (
    <span ref={box} className="own-select-wrap">
      <MenuButton label={label} className="own-select" width={w} maxHeight={440} items={items}>
        {mark && <span className="own-select-mark">{mark}</span>}
        <span className={`own-select-text ${placeholder ? "muted" : ""}`}>{text}</span>
        <Icon name="chevronDown" size={13} className="own-select-caret" />
      </MenuButton>
    </span>
  );
}

/** `savedUrl`: the address a model being changed was saved with, which its saved key belongs to. */
/** `vision`: set by the person; unset, it is guessed from the model's name on the computer (seesImages), and `sees` says the guess. */
type Draft = { id?: string; provider: string; baseUrl: string; apiKey: string; model: string; name: string; hasKey?: boolean; savedUrl?: string; vision?: boolean; sees?: boolean };
type Local = { provider: string; name: string; baseUrl: string; models: string[] };

export function OwnModelsSection({ identity, workspace }: { identity: Identity; workspace: WorkspaceUsage | null }) {
  const { state: machine } = useMachine(identity);
  const linked = machine.mode === "local" || machine.mode === "linked";
  const models = useOwnModels(machine.mode === "none" ? undefined : identity);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [local, setLocal] = useState<Local[]>([]);
  const [notes, setNotes] = useState<Record<string, { text: string; bad?: boolean }>>({});
  const [error, setError] = useState("");
  const [ask, confirmUI] = useConfirm();
  const solo = true;

  useEffect(() => {
    if (!linked) return;
    void loadOwnModels(identity, true);
    hostApi<{ servers: Local[] }>(identity, "/api/runner/models.own.detect").then((r) => setLocal(r.servers), () => {});
  }, [linked, identity.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Only when there is no computer at all: a slow check of one already shown keeps the page (and a half-filled form) as it is.
  if (machine.mode === "none" && !models.length && !draft) {
    return (
      <section className="settings-section">
        <p className="muted">Your own models are kept on your computer, with their keys, and Friday's agent reaches them through it.</p>
        <NoMachine />
      </section>
    );
  }

  const test = async (m: OwnChoice) => {
    setNotes((n) => ({ ...n, [m.id]: { text: "Asking it…" } }));
    try {
      const r = await hostApi<{ ms: number; reply: string }>(identity, "/api/runner/models.own.test", { method: "POST", body: JSON.stringify({ id: m.id }) });
      setNotes((n) => ({ ...n, [m.id]: { text: `Answered in ${(r.ms / 1000).toFixed(1)}s${r.reply ? `: “${r.reply}”` : ""}` } }));
    } catch (e) {
      setNotes((n) => ({ ...n, [m.id]: { text: machineError(e), bad: true } }));
    }
  };
  const remove = (m: OwnChoice) =>
    ask({
      title: `Remove ${m.name}?`,
      body: `It comes off this computer${m.hasKey ? ", with its key" : ""}. Sessions using it stop until you pick another model.`,
      action: "Remove",
      onConfirm: async () => {
        await hostApi(identity, "/api/runner/models.own.remove", { method: "POST", body: JSON.stringify({ id: m.id }) });
        if (workspace?.defaults?.model === m.choice) await setDefault("");
        await loadOwnModels(identity, true);
      },
    });
  // What Friday's agent starts new sessions on here, and what Friday's helpers use on Solo. Only in your own workspace: on a
  // team the default is everyone's, and your key is yours, so there each person picks their own model in the session.
  const canDefault = false; // Picked in the composer each time: there are no workspace defaults here.
  const setDefault = async (model: string) => {
    setError("");
    try {
      await api(identity, "/api/workspace", { method: "PATCH", body: JSON.stringify({ defaults: { model } }) });
      window.dispatchEvent(new Event("friday:workspace"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const current = workspace?.defaults?.model ?? "";
  const unadded = local.flatMap((s) => (models.some((m) => m.baseUrl === s.baseUrl) ? [] : [s]));

  return (
    <section className="settings-section own-models">
      <div className="set-card">
        <div className="set-row own-intro">
          <div className="set-text">
            <div className="set-label">Use your own key, or a model on this computer</div>
            <div className="muted small">
              Friday Code runs on it: pick Friday Code beside your coding tools when you start a session. Keys are kept on this computer and sent only to the model's own server.
            </div>
          </div>
          {!draft && (
            <button type="button" className="btn primary small" onClick={() => setDraft({ provider: "openai", baseUrl: PRESETS[0]!.baseUrl, apiKey: "", model: "", name: "" })}>
              <Icon name="plus" size={13} /> Add a model
            </button>
          )}
        </div>

        {unadded.map((s) => (
          <div key={s.baseUrl} className="set-row own-found">
            <div className="set-text">
              <div className="set-label">{s.name} is running on this computer</div>
              <div className="muted small">{s.models.length ? `${s.models.length} model${s.models.length === 1 ? "" : "s"}: ${s.models.slice(0, 4).join(", ")}${s.models.length > 4 ? "…" : ""}` : "No models pulled yet."}</div>
            </div>
            <button type="button" className="btn ghost small" disabled={!s.models.length} onClick={() => setDraft({ provider: s.provider, baseUrl: s.baseUrl, apiKey: "", model: s.models[0] ?? "", name: "" })}>
              Use it
            </button>
          </div>
        ))}

        {draft && <ModelForm identity={identity} draft={draft} onChange={setDraft} onDone={async () => (setDraft(null), await loadOwnModels(identity, true))} />}

        {models.map((m) => (
          <div key={m.id} className="set-row own-row">
            <div className="set-text">
              <div className="set-label">
                {m.name}
                {current === m.choice && <span className="chip-mini ok">Default</span>}
              </div>
              <div className="muted small own-sub">
                <code>{m.model}</code> · {m.local ? "on this computer" : (presetOf(m.provider)?.name ?? new URL(m.baseUrl).host)}
                {m.hasKey ? " · key saved here" : ""}
              </div>
              {notes[m.id] && <div className={`small ${notes[m.id]!.bad ? "error" : "muted"}`}>{notes[m.id]!.text}</div>}
            </div>
            <div className="set-inline">
              <button type="button" className="btn ghost small" onClick={() => void test(m)}>
                Test
              </button>
              <button type="button" className="btn ghost small" onClick={() => setDraft({ id: m.id, provider: m.provider ?? "custom", baseUrl: m.baseUrl, apiKey: "", model: m.model, name: m.name, hasKey: m.hasKey, savedUrl: m.baseUrl, ...(m.vision !== undefined ? { vision: m.vision } : {}), sees: m.sees })}>
                Edit
              </button>
              <button type="button" className="icon-btn" aria-label={`Remove ${m.name}`} onClick={() => remove(m)}>
                <Icon name="trash" size={14} />
              </button>
            </div>
          </div>
        ))}

        {models.length > 0 && canDefault && (
          <div className="set-row">
            <div className="set-text">
              <div className="set-label">Friday's agent starts on</div>
              <div className="muted small">{solo ? "New sessions with Friday Code, and Friday's helpers, use this model." : "What new sessions start on here. You can still pick another model in each session."}</div>
            </div>
            {(() => {
              const chosen = models.find((m) => m.choice === current);
              return (
                <Field
                  label="Friday's agent starts on"
                  width={280}
                  mark={chosen ? <ProviderMark id={chosen.provider} /> : undefined}
                  text={chosen?.name ?? (solo ? "Choose one of your models" : "Friday's model")}
                  placeholder={!chosen && solo}
                  items={() => [
                    !solo && { label: "Friday's model", sub: "The workspace's own, on its allowance", checked: !isOwnModel(current), onSelect: () => void setDefault("") },
                    { heading: "Your models" },
                    ...models.map((m) => ({ label: m.name, mark: <ProviderMark id={m.provider} />, sub: `${m.model} · ${m.local ? "on this computer" : "your key"}`, checked: m.choice === current, onSelect: () => void setDefault(m.choice) })),
                  ]}
                />
              );
            })()}
          </div>
        )}
        {error && <p className="error small">{error}</p>}
      </div>
      {confirmUI}
    </section>
  );
}

function ModelForm({ identity, draft, onChange, onDone }: { identity: Identity; draft: Draft; onChange: (d: Draft | null) => void; onDone: () => Promise<void> }) {
  const [found, setFound] = useState<string[]>([]);
  // A long list of models narrowed by typing, in the list itself (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
  const [filter, setFilter] = useState("");
  // The filter takes the focus once as the list opens (the menu itself puts it on the model ticked, a moment before).
  const filterFocused = useRef(false);
  const [busy, setBusy] = useState<"" | "list" | "save">("");
  const [error, setError] = useState("");
  // The address is the preset's until somebody needs another: shown as a line, opened to a field on request.
  const [editAddress, setEditAddress] = useState(false);
  const preset = presetOf(draft.provider) ?? PRESETS[PRESETS.length - 1]!;
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const addressOpen = editAddress || preset.id === "custom" || !preset.baseUrl;
  // A saved key goes only to the address it was saved for (own-models.ts): one moved elsewhere has to be given again.
  const moved = !!draft.savedUrl && draft.baseUrl.trim().replace(/\/+$/, "") !== draft.savedUrl.replace(/\/+$/, "");
  const keySaved = !!draft.hasKey && !moved;
  const needsKey = preset.key && !draft.apiKey.trim() && !keySaved;

  // What `claude setup-token` prints signs in to Claude Code only; said here at once, since Anthropic's own refusal is a bare 400.
  const signInToken = /^sk-ant-oat/i.test(draft.apiKey.trim()) ? "That's a Claude Code sign-in token, not an API key: it only works inside Claude Code. Create an API key at console.anthropic.com/settings/keys and paste that." : "";
  const list = async (quiet = false) => {
    if (signInToken) return setError(signInToken);
    setBusy("list");
    if (!quiet) setError("");
    try {
      const r = await hostApi<{ models: string[] }>(identity, "/api/runner/models.own.discover", { method: "POST", body: JSON.stringify({ baseUrl: draft.baseUrl, apiKey: draft.apiKey, ...(draft.id && !moved ? { id: draft.id } : {}) }) });
      setFound(r.models);
      if (!draft.model && r.models[0]) set({ model: r.models[0] });
      if (!r.models.length && !quiet) setError("That server didn't list any models. Type the model's name instead.");
    } catch (e) {
      // Asked by itself as a key was pasted: a refused key is said at once; anything else waits for a press of List models.
      const why = machineError(e);
      if (!quiet || /accept the key/i.test(why)) setError(why);
    }
    setBusy("");
  };
  // A key pasted, or a server on this computer picked: its models are asked for at once, so they are picked rather than typed.
  useEffect(() => {
    if (found.length || !draft.baseUrl.trim()) return;
    // Whole keys only: asked of a key still being typed, part of it would go round for nothing.
    if (preset.key && draft.apiKey.trim().length < 30) return;
    const t = setTimeout(() => void list(true), 900);
    return () => clearTimeout(t);
  }, [draft.apiKey, draft.baseUrl, draft.provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (signInToken) return setError(signInToken);
    setBusy("save");
    setError("");
    try {
      await hostApi(identity, "/api/runner/models.own.save", {
        method: "POST",
        body: JSON.stringify({ ...(draft.id ? { id: draft.id } : {}), provider: draft.provider, baseUrl: draft.baseUrl, model: draft.model, name: draft.name, ...(draft.apiKey ? { apiKey: draft.apiKey } : {}), ...(draft.vision !== undefined ? { vision: draft.vision } : {}) }),
      });
      await onDone();
    } catch (e) {
      setError(machineError(e));
      setBusy("");
    }
  };
  const host = (() => {
    try {
      const u = new URL(draft.baseUrl);
      return `${u.host}${u.pathname.replace(/\/+$/, "")}`;
    } catch {
      return draft.baseUrl;
    }
  })();

  return (
    <div className="own-form">
      <div className="own-form-head">{draft.id ? `Change ${draft.name || draft.model}` : "Add a model"}</div>
      <div className="own-form-grid">
        <div className="own-field">
          <span>Provider</span>
          <Field
            label="Provider"
            mark={<ProviderMark id={preset.id} />}
            text={preset.name}
            items={() => {
              const row = (p: (typeof PRESETS)[number]): MenuItem => ({
                label: p.name,
                mark: <ProviderMark id={p.id} />,
                sub: p.hint,
                checked: p.id === draft.provider,
                onSelect: () => {
                  setFound([]);
                  setEditAddress(false);
                  // Another server starts with no address, not the provider's it was on (it kept OpenAI's) (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
                  set({ provider: p.id, baseUrl: p.id === "custom" ? (draft.provider === "custom" ? draft.baseUrl : "") : p.baseUrl, model: "" });
                },
              });
              return [
                { heading: "Online, with your key" },
                ...PRESETS.filter((p) => !LOCAL_IDS.has(p.id) && p.id !== "custom").map(row),
                { heading: "On this computer" },
                ...PRESETS.filter((p) => LOCAL_IDS.has(p.id)).map(row),
                { heading: "Other" },
                row(PRESETS.find((p) => p.id === "custom")!),
              ];
            }}
          />
          {!addressOpen && (
            <span className="own-hint">
              Sends to <code>{host}</code> ·{" "}
              <button type="button" className="link-btn" onClick={() => setEditAddress(true)}>
                Change
              </button>
            </span>
          )}
        </div>
        <label>
          <span>Model</span>
          <span className="own-model-pick">
            <input className="set-input" value={draft.model} placeholder={modelExample(preset.hint)} spellCheck={false} onChange={(e) => set({ model: e.target.value })} />
            {found.length ? (
              <MenuButton
                label="Pick a model"
                className="btn ghost small own-pick-btn"
                end
                width={300}
                maxHeight={420}
                onOpenChange={(o) => !o && (setFilter(""), (filterFocused.current = false))}
                items={() => {
                  const shown = filter.trim() ? found.filter((m) => m.toLowerCase().includes(filter.trim().toLowerCase())) : found;
                  return [
                    found.length > 10 && {
                      node: (
                        <input
                          className="set-input own-pick-filter"
                          ref={(el) => {
                            if (!el || filterFocused.current) return;
                            filterFocused.current = true;
                            setTimeout(() => el.focus({ preventScroll: true }), 0);
                          }}
                          value={filter}
                          placeholder={`Filter ${found.length} models`}
                          aria-label="Filter models"
                          spellCheck={false}
                          onChange={(e) => setFilter(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "ArrowDown") (e.preventDefault(), e.currentTarget.closest(".menu")?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus());
                          }}
                        />
                      ),
                      height: 46,
                    },
                    // In their order, the one in use ticked (the menu opens on it).
                    ...shown.map((m) => ({ label: m, checked: m === draft.model, onSelect: () => set({ model: m }) })),
                    !shown.length && { heading: `No model has “${filter.trim()}” in its name` },
                  ];
                }}
              >
                {found.length} models <Icon name="chevronDown" size={12} />
              </MenuButton>
            ) : (
              <button type="button" className="btn ghost small own-pick-btn" disabled={busy !== "" || !draft.baseUrl || needsKey} title={needsKey ? "Paste your key first" : undefined} onClick={() => void list()}>
                {busy === "list" ? "Asking…" : "List models"}
              </button>
            )}
          </span>
        </label>
        {addressOpen && (
          <label className="wide">
            <span>Address</span>
            <input className="set-input" value={draft.baseUrl} placeholder="https://api.example.com/v1" spellCheck={false} onChange={(e) => set({ baseUrl: e.target.value })} />
            <span className="own-hint">Where its OpenAI-compatible API lives, ending before /chat/completions.</span>
          </label>
        )}
        {preset.key && (
          <label className="wide">
            <span>API key</span>
            <span className="own-key">
              <input
                className="set-input"
                type="password"
                autoComplete="off"
                value={draft.apiKey}
                placeholder={keySaved ? "Saved on this computer · leave empty to keep it" : moved && draft.hasKey ? "Enter the key again for the new address" : "Paste your key"}
                onChange={(e) => set({ apiKey: e.target.value })}
              />
              {preset.keys && (
                <a className="btn ghost small" href={preset.keys} target="_blank" rel="noreferrer">
                  Get a key <Icon name="external" size={12} />
                </a>
              )}
            </span>
          </label>
        )}
        <label className="wide">
          <span>
            Name <span className="own-optional">optional</span>
          </span>
          <input className="set-input" value={draft.name} placeholder={draft.model || "What it's called in Friday"} onChange={(e) => set({ name: e.target.value })} />
        </label>
        {/* Pictures attached to a message go to it only when it can read them: a picture sent to one that can't fails the step. */}
        <label className="wide own-vision">
          <input type="checkbox" checked={draft.vision ?? draft.sees ?? seesByName(draft.model)} onChange={(e) => set({ vision: e.target.checked })} />
          <span>
            Can see images <span className="own-optional">{draft.vision === undefined ? "guessed from its name" : "set by you"}</span>
          </span>
        </label>
      </div>
      {error && <p className="error small">{error}</p>}
      <div className="own-form-actions">
        <span className="muted small">
          <Icon name="shield" size={12} /> Kept on this computer. It passes through Friday only on its way here, and is never stored there.
        </span>
        <button type="button" className="btn ghost small" onClick={() => onChange(null)}>
          Cancel
        </button>
        <button type="button" className="btn primary small" disabled={busy !== "" || !draft.baseUrl.trim() || !draft.model.trim() || needsKey} title={needsKey ? "Paste your key first" : !draft.model.trim() ? "Pick or type a model" : undefined} onClick={() => void save()}>
          {busy === "save" ? "Saving…" : draft.id ? "Save" : "Add model"}
        </button>
      </div>
    </div>
  );
}
