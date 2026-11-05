import { seesByName } from "../own-vision.js";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { isOwnModel } from "../own-model-id.js";
import { api } from "./api.js";
import { EngineMark, ModelHostMark, VendorMark } from "./BrandMarks.js";
import { machineError } from "./GitHubConnect.js";
import { Icon } from "./icons.js";
import { NoMachine, hostApi, useMachine } from "./local.js";
import { groupOwn } from "./own-groups.js";
import { loadOwnModels, useOwnModels, type OwnChoice } from "./ownModelStore.js";
import type { Identity } from "./storage.js";
import { Check, MenuButton, useConfirm, type MenuItem } from "./ui.js";
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
/** `keys`: where the provider hands out keys, for the form's "Get a key". `key`: "optional" where some servers take none. */
const PRESETS: { id: string; name: string; baseUrl: string; key: boolean | "optional"; hint: string; keys?: string }[] = [
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
  // A server of your own may take no key, as LM Studio's doesn't (audit e2e, Arun 2026-11-04: a keyless one couldn't be added).
  { id: "custom", name: "Another server", baseUrl: "", key: "optional", hint: "Anything that speaks the OpenAI chat API" },
];
const presetOf = (id?: string) => PRESETS.find((p) => p.id === id);
const LOGO: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google", deepseek: "DeepSeek" };
const LOCAL_IDS = new Set(["ollama", "lmstudio"]);
/** Their own marks, not letters (audit REST-25). */
const HOST_MARKS = new Set(["groq", "mistral", "together", "ollama", "lmstudio"]);

/**
 * A provider's mark: its logo where the app has one, else its initial; each in the same small tile, so a list of them reads as
 * one column rather than logos mixed with letter badges (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
 */
function ProviderMark({ id, size = 15 }: { id?: string; size?: number }) {
  const p = presetOf(id);
  const inner = Math.round(size * 0.75);
  return (
    <span className="own-mono" style={{ width: size + 3, height: size + 3 }} aria-hidden>
      {id && LOGO[id] ? <VendorMark vendor={LOGO[id]} size={inner} /> : id && HOST_MARKS.has(id) ? <ModelHostMark id={id} size={inner} /> : id === "xai" ? <EngineMark tool="grok" size={inner} /> : id === "custom" || !p ? <Icon name="globe" size={inner} /> : p.name[0]}
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
type Draft = {
  id?: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  name: string;
  hasKey?: boolean;
  savedUrl?: string;
  vision?: boolean;
  sees?: boolean;
  /** More models from a server already in use: its list straight away, ticked to add (issue #17's follow-up). */
  more?: boolean;
  /** A saved model there whose key the server's list and the new models use. */
  keyFrom?: string;
};
/** More from the server a saved model is on, with that model's key. */
const moreFrom = (m: { id: string; provider?: string; baseUrl: string; hasKey: boolean }): Draft => ({ provider: m.provider ?? "custom", baseUrl: m.baseUrl, apiKey: "", model: "", name: "", hasKey: m.hasKey, savedUrl: m.baseUrl, more: true, keyFrom: m.id });
type Local = { provider: string; name: string; baseUrl: string; models: string[] };

export function OwnModelsSection({ identity, workspace }: { identity: Identity; workspace: WorkspaceUsage | null }) {
  const { state: machine } = useMachine(identity);
  const linked = machine.mode === "local" || machine.mode === "linked";
  const models = useOwnModels(machine.mode === "none" ? undefined : identity);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [local, setLocal] = useState<Local[]>([]);
  /** What a test said, for the model as it was tested: changed since (edited, moved, another model), it is gone (audit REST-7). */
  const [notes, setNotes] = useState<Record<string, { text: string; bad?: boolean; of: string }>>({});
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

  const testedAs = (m: OwnChoice) => `${m.baseUrl}|${m.model}|${m.hasKey}`;
  const test = async (m: OwnChoice) => {
    const of = testedAs(m);
    setNotes((n) => ({ ...n, [m.id]: { text: "Asking it…", of } }));
    try {
      const r = await hostApi<{ ms: number; reply: string }>(identity, "/api/runner/models.own.test", { method: "POST", body: JSON.stringify({ id: m.id }) });
      setNotes((n) => ({ ...n, [m.id]: { text: `Answered in ${(r.ms / 1000).toFixed(1)}s${r.reply ? `: “${r.reply}”` : ""}`, of } }));
    } catch (e) {
      setNotes((n) => ({ ...n, [m.id]: { text: machineError(e), bad: true, of } }));
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
  const form = (d: Draft) => <ModelForm key={`${d.id ?? ""}|${d.more ? d.baseUrl : ""}`} identity={identity} draft={d} saved={models} onChange={setDraft} onDone={async () => (setNotes((n) => Object.fromEntries(Object.entries(n).filter(([id]) => id !== d.id))), setDraft(null), await loadOwnModels(identity, true))} />;
  const unadded = local.flatMap((s) => (models.some((m) => m.baseUrl === s.baseUrl) ? [] : [s]));

  return (
    <section className="settings-section own-models">
      <div className="set-card">
        <div className="set-row own-intro">
          <div className="set-text">
            <div className="set-label">Use your own key, or a model on this computer</div>
            <div className="muted small">
              Friday Code runs on it: once you have one, pick Friday Code in the message box when you start a session, as that session's agent. A session's other agents are your coding tools. Keys are kept on this computer and sent only to the model's own server.
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

        {/* A new one is added above the list; one changed, or more from a server, opens where it is in it. */}
        {draft && !draft.id && !draft.more && form(draft)}

        {groupOwn(models).map((g) => {
          // Named after its provider where it has one (a preset, like LM Studio); another server goes by its address.
          const named = g.provider && g.provider !== "custom" ? presetOf(g.provider)?.name : undefined;
          const key = [g.local ? "on this computer" : "", g.keyed === "all" ? "key saved here" : g.keyed === "some" ? "some without a key" : g.local ? "" : "no key"].filter(Boolean).join(" · ");
          return (
            <div key={g.baseUrl} className="own-group" role="group" aria-label={`${named ?? g.host}, ${g.models.length} model${g.models.length === 1 ? "" : "s"}`}>
              <div className="set-row own-group-head">
                <span className="own-group-mark" aria-hidden="true">
                  <ProviderMark id={g.provider} size={16} />
                </span>
                <div className="set-text">
                  <div className="set-label">{named ?? g.host}</div>
                  <div className="muted small own-sub">
                    {named && (
                      <>
                        <code>{g.host}</code> ·{" "}
                      </>
                    )}
                    {g.models.length} model{g.models.length === 1 ? "" : "s"}
                    {key && ` · ${key}`}
                  </div>
                </div>
                {!(draft?.more && draft.baseUrl === g.baseUrl) && (
                  <button type="button" className="btn ghost small" onClick={() => setDraft(moreFrom(g.models.find((m) => m.hasKey) ?? g.models[0]!))}>
                    <Icon name="plus" size={13} /> More from {named ?? g.host}
                  </button>
                )}
              </div>
              {draft?.more && draft.baseUrl === g.baseUrl && form(draft)}
              {g.models.map((m) => (
                <div key={m.id}>
                  <div className="set-row own-row">
                    <div className="set-text">
                      <div className="set-label own-name">
                        {/* One line, cut with an ellipsis, the whole name on hover (audit REST-8). */}
                        <span className="own-name-text" title={m.name}>
                          {m.name}
                        </span>
                        {current === m.choice && <span className="chip-mini ok">Default</span>}
                      </div>
                      {m.name !== m.model && (
                        <div className="muted small own-sub">
                          <code>{m.model}</code>
                        </div>
                      )}
                    </div>
                    {/* In a slot of its own, one line beside the marks: the row keeps its height, the whole of it on hover. */}
                    {notes[m.id]?.of === testedAs(m) && draft?.id !== m.id && (
                      <span className={`small own-note ${notes[m.id]!.bad ? "error" : "muted"}`} title={notes[m.id]!.text} role="status">
                        {notes[m.id]!.text}
                      </span>
                    )}
                    {/* Three marks close together, not words (Arun, 2026-11-04: "use svg icons for these… closer together"). */}
                    <div className="own-acts">
                      <button type="button" className="icon-btn" aria-label={`Test ${m.name}`} title="Test: ask it for a short reply" onClick={() => void test(m)}>
                        <Icon name="play" size={14} />
                      </button>
                      <button type="button" className={`icon-btn${draft?.id === m.id ? " on" : ""}`} aria-label={`Edit ${m.name}`} aria-pressed={draft?.id === m.id} title="Edit" onClick={() => setDraft(draft?.id === m.id ? null : { id: m.id, provider: m.provider ?? "custom", baseUrl: m.baseUrl, apiKey: "", model: m.model, name: m.name, hasKey: m.hasKey, savedUrl: m.baseUrl, ...(m.vision !== undefined ? { vision: m.vision } : {}), sees: m.sees })}>
                        <Icon name="pencil" size={14} />
                      </button>
                      <button type="button" className="icon-btn own-act-remove" aria-label={`Remove ${m.name}`} title="Remove" onClick={() => remove(m)}>
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  </div>
                  {draft?.id === m.id && form(draft)}
                </div>
              ))}
            </div>
          );
        })}

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

function ModelForm({ identity, draft, saved, onChange, onDone }: { identity: Identity; draft: Draft; saved: OwnChoice[]; onChange: (d: Draft | null) => void; onDone: () => Promise<void> }) {
  const [found, setFound] = useState<string[]>([]);
  // Several ticked from the list and added at once, instead of one per pass of the form (issue #17). Null: one, as before.
  const [many, setMany] = useState<Set<string> | null>(null);
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
  const needsKey = preset.key === true && !draft.apiKey.trim() && !keySaved;

  // What `claude setup-token` prints signs in to Claude Code only; said here at once, since Anthropic's own refusal is a bare 400.
  const signInToken = /^sk-ant-oat/i.test(draft.apiKey.trim()) ? "That's a Claude Code sign-in token, not an API key: it only works inside Claude Code. Create an API key at console.anthropic.com/settings/keys and paste that." : "";
  /** The address and key the models shown were listed with: another key or address lists them again. */
  const listedFor = useRef<string | null>(null);
  const list = async (quiet = false) => {
    if (signInToken) return setError(signInToken);
    setBusy("list");
    if (!quiet) setError("");
    listedFor.current = `${draft.baseUrl.trim()}|${draft.apiKey.trim()}`;
    try {
      const from = draft.id ?? draft.keyFrom;
      const r = await hostApi<{ models: string[] }>(identity, "/api/runner/models.own.discover", { method: "POST", body: JSON.stringify({ baseUrl: draft.baseUrl, apiKey: draft.apiKey, ...(from && !moved ? { id: from } : {}) }) });
      setFound(r.models);
      if (draft.more) setMany((m) => m ?? new Set());
      else if (!draft.model && r.models[0]) set({ model: r.models[0] });
      if (!r.models.length && !quiet) setError("That server didn't list any models. Type the model's name instead.");
    } catch (e) {
      // What was listed with another key or address no longer stands: not kept, as if it still did (2026-11-04 retest).
      setFound([]);
      // Asked by itself as a key was pasted: a refused key is said at once; anything else waits for a press of List models.
      const why = machineError(e);
      if (!quiet || draft.more || /accept the key/i.test(why)) setError(why);
    }
    setBusy("");
  };
  // A key pasted, or a server on this computer picked: its models are asked for at once, so they are picked rather than typed.
  useEffect(() => {
    // Listed already with this address and key; or with none yet, when nothing was ever listed. A key changed after the models
    // were listed lists them again, rather than keeping the old list with no word (2026-11-04 retest).
    if (!draft.baseUrl.trim() || (found.length ? listedFor.current === `${draft.baseUrl.trim()}|${draft.apiKey.trim()}` || listedFor.current === null : false)) return;
    // Whole keys only: asked of a key still being typed, part of it would go round for nothing.
    // Another server with no key: asked at once only on this computer, where a keyless one is likely; one elsewhere waits for its key.
    const keyless = preset.key === "optional" && !draft.apiKey.trim() && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(draft.baseUrl.trim());
    if (preset.key && !keyless && draft.apiKey.trim().length < 30 && !keySaved) return;
    const t = setTimeout(() => void list(true), draft.more ? 0 : 900);
    return () => clearTimeout(t);
  }, [draft.apiKey, draft.baseUrl, draft.provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const addMany = async (picked: string[]) => {
    if (signInToken) return setError(signInToken);
    setBusy("save");
    setError("");
    try {
      await hostApi(identity, "/api/runner/models.own.addMany", { method: "POST", body: JSON.stringify({ provider: draft.provider, baseUrl: draft.baseUrl, models: picked, ...(draft.apiKey ? { apiKey: draft.apiKey } : draft.keyFrom && !moved ? { id: draft.keyFrom } : {}) }) });
      await onDone();
    } catch (e) {
      setError(machineError(e));
      setBusy("");
    }
  };
  const save = async () => {
    if (signInToken) return setError(signInToken);
    // The same model from the same server once: added twice, it was two rows of one model (2026-11-04 retest).
    if (!draft.id && have.has(draft.model.trim())) return setError(`${draft.model.trim()} from ${host} is already in your models.`);
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
  // Already saved for this address: shown, but not ticked again. The list keeps at most MAX_OWN, and says so before the press.
  const clean = draft.baseUrl.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  const have = new Set(saved.filter((m) => m.baseUrl === clean).map((m) => m.model));
  const fresh = many ? found.filter((m) => many.has(m) && !have.has(m)) : [];
  const room = Math.max(0, MAX_OWN - saved.length);
  const over = fresh.length - room;
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
      <div className="own-form-head">{draft.more ? `More from ${host}` : draft.id ? `Change ${draft.name || draft.model}` : "Add a model"}</div>
      <div className="own-form-grid">
        {/* One line: asking, or what went wrong with Try again beside it (audit REST-15). */}
        {draft.more && !many && (busy === "list" || !error ? (
          <p className="wide own-more-wait">
            <span className="spinner" aria-hidden /> Asking {host} for its models…
          </p>
        ) : (
          <div className="wide own-more-failed" role="alert">
            <span className="error small">{error}</span>
            <button type="button" className="btn small" onClick={() => void list()}>
              Try again
            </button>
          </div>
        ))}
        {!draft.more && (
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
        )}
        {!many && !draft.more && (
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
          {found.length > 1 && !draft.id && (
            <span className="own-hint">
              <button type="button" className="link-btn" onClick={() => (setError(""), setMany(new Set()))}>
                Add several at once
              </button>
            </span>
          )}
          {/* Editing one, the others on its server a press away, with its key (issue #17's follow-up). */}
          {found.length > 1 && draft.id && !moved && (
            <span className="own-hint">
              <button type="button" className="link-btn" onClick={() => (setError(""), onChange(moreFrom({ id: draft.id!, provider: draft.provider, baseUrl: draft.savedUrl ?? draft.baseUrl, hasKey: !!draft.hasKey })))}>
                Add others from this server
              </button>
            </span>
          )}
        </label>
        )}
        {addressOpen && !draft.more && (
          <label className="wide">
            <span>Address</span>
            <input className="set-input" value={draft.baseUrl} placeholder="https://api.example.com/v1" spellCheck={false} onChange={(e) => set({ baseUrl: e.target.value })} />
            <span className="own-hint">Where its OpenAI-compatible API lives, ending before /chat/completions.</span>
          </label>
        )}
        {preset.key && !(draft.more && keySaved && !error) && (
          <label className="wide">
            <span>
              API key{preset.key === "optional" && <> <span className="own-optional">optional</span></>}
            </span>
            <span className="own-key">
              <input
                className="set-input"
                type="password"
                autoComplete="off"
                value={draft.apiKey}
                placeholder={keySaved ? "Saved on this computer · leave empty to keep it" : moved && draft.hasKey ? "Enter the key again for the new address" : preset.key === "optional" ? "Only if the server asks for one" : "Paste your key"}
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
        {many ? (
          <ManyPicker found={found} picked={many} onPick={(f) => setMany((m) => f(m ?? new Set()))} have={have} />
        ) : draft.more ? null : (
          <>
        <label className="wide">
          <span>
            Name <span className="own-optional">optional</span>
          </span>
          <input className="set-input" value={draft.name} placeholder={draft.model || "What it's called in Friday"} onChange={(e) => set({ name: e.target.value })} />
        </label>
        {/* Pictures attached to a message go to it only when it can read them: a picture sent to one that can't fails the step. */}
        <label className="wide own-vision">
          <Check checked={draft.vision ?? draft.sees ?? seesByName(draft.model)} onChange={(on) => set({ vision: on })} />
          <span>
            Can see images <span className="own-optional">{draft.vision === undefined ? "guessed from its name" : "set by you"}</span>
          </span>
        </label>
          </>
        )}
      </div>
      {error && !(draft.more && !many) && <p className="error small">{error}</p>}
      <div className="own-form-actions">
        {/* About a key: only where one is typed, never on a form with no key field (audit e2e, Arun 2026-11-04). */}
        {preset.key && (!draft.more || !keySaved) && (
          <span className="muted small">
            <Icon name="shield" size={12} /> Kept on this computer and sent only to the model's server.
          </span>
        )}
        {many ? (
          <>
            {over > 0 && <span className="error small own-many-over">{room ? `${fresh.length} new, room for ${room} more: untick ${over}` : `${MAX_OWN} saved, the most Friday keeps`}</span>}
            <button type="button" className="btn ghost small" onClick={() => (setError(""), draft.more ? onChange(null) : setMany(null))}>
              Cancel
            </button>
            <button type="button" className="btn primary small" disabled={busy !== "" || !fresh.length || over > 0 || needsKey} title={needsKey ? "Paste your key first" : !fresh.length ? "Tick the models to add" : undefined} onClick={() => void addMany(fresh)}>
              {busy === "save" ? "Adding…" : fresh.length > 1 ? `Add ${fresh.length} models` : "Add model"}
            </button>
          </>
        ) : draft.more ? (
          <button type="button" className="btn ghost small" onClick={() => onChange(null)}>
            Cancel
          </button>
        ) : (
          <>
        <button type="button" className="btn ghost small" onClick={() => onChange(null)}>
          Cancel
        </button>
        <button type="button" className="btn primary small" disabled={busy !== "" || !draft.baseUrl.trim() || !draft.model.trim() || needsKey} title={needsKey ? "Paste your key first" : !draft.model.trim() ? "Pick or type a model" : undefined} onClick={() => void save()}>
          {busy === "save" ? "Saving…" : draft.id ? "Save" : "Add model"}
        </button>
          </>
        )}
      </div>
    </div>
  );
}

/** The most models kept on a computer (runner/own-models.ts MAX_OWN_MODELS). */
const MAX_OWN = 40;

/**
 * A server's models to tick, for adding several at once (issue #17): filtered by name, with Select all and Select none acting on
 * the ones the filter leaves, how many are ticked, and the ticked ones alone. One already saved for this address is listed, not
 * offered again.
 */
function ManyPicker({ found, picked, onPick, have }: { found: string[]; picked: Set<string>; /** From what's ticked as it stands: ticks in quick succession each count. */ onPick: (f: (prev: Set<string>) => Set<string>) => void; have: Set<string> }) {
  const [filter, setFilter] = useState("");
  const [only, setOnly] = useState(false);
  const words = filter.trim().toLowerCase();
  const shown = found.filter((m) => (!words || m.toLowerCase().includes(words)) && (!only || picked.has(m)));
  const open = shown.filter((m) => !have.has(m));
  const ticked = open.filter((m) => picked.has(m));
  const set = (ms: string[], on: boolean) =>
    onPick((prev) => {
      const next = new Set(prev);
      for (const m of ms) if (on) next.add(m);
      else next.delete(m);
      return next;
    });
  const count = found.filter((m) => picked.has(m) && !have.has(m)).length;
  return (
    <div className="wide own-many">
      <div className="own-many-top">
        <input className="set-input" value={filter} placeholder={`Filter ${found.length} models`} aria-label="Filter models" spellCheck={false} autoFocus onChange={(e) => setFilter(e.target.value)} />
        <span className="own-many-count" aria-live="polite">
          <b>{count}</b> of {found.length} selected
        </span>
      </div>
      <div className="own-many-bar">
        <button type="button" className="link-btn" disabled={!open.length || ticked.length === open.length} onClick={() => set(open, true)}>
          {words && !only ? `Select these ${open.length}` : "Select all"}
        </button>
        <button type="button" className="link-btn" disabled={!ticked.length} onClick={() => set(open, false)}>
          {words && !only ? "Select none of these" : "Select none"}
        </button>
        <label className="own-many-only">
          <Check checked={only} onChange={setOnly} />
          Selected only
        </label>
      </div>
      <div className="own-many-list" role="group" aria-label="Models">
        {shown.map((m) =>
          have.has(m) ? (
            <div key={m} className="own-many-row saved">
              <Check checked disabled onChange={() => {}} label={`${m}, already added`} />
              <code>{m}</code>
              <span className="own-many-tag">Added</span>
            </div>
          ) : (
            <label key={m} className="own-many-row">
              <Check checked={picked.has(m)} onChange={(on) => set([m], on)} />
              <code>{m}</code>
              {seesByName(m) && <span className="own-many-tag">Sees images</span>}
            </label>
          ),
        )}
        {!shown.length && <p className="own-many-empty">{only ? "Nothing selected yet." : `No model has “${filter.trim()}” in its name.`}</p>}
      </div>
    </div>
  );
}
