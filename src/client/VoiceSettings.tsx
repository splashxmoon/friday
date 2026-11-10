import { useEffect, useState } from "react";
import { Choice, SettingsGroup, SettingsRow as Row } from "@/components/dass";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { hostApi } from "./local.js";
import { groupOwn } from "./own-groups.js";
import type { OwnModelView } from "../runner/own-models.js";
import type { Identity } from "./storage.js";
import { modelStatus, type ModelStatus } from "./voice.js";
import { platformOf, talkLabel } from "./voice-keys.js";
import { setVoicePrefs, useVoicePrefs } from "./voice-prefs.js";
import { isSpeechModel, LANGUAGES, mb } from "./voice-text.js";

/**
 * Settings › General › Voice (voice-S, Arun 2026-11-09): where speech is made into words, how talking starts, the language, and
 * whether it is sent when you stop. With the app's own controls, as the rest of Settings has them.
 */

type Speech = { id: string; model: string; label: string };

/** The speech models on the servers saved in Your models: each server asked once for its list, its Whisper and transcribe models kept. */
function useSpeechModels(identity: Identity, on: boolean): { list: Speech[] | null; error: string } {
  const [list, setList] = useState<Speech[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!on) return;
    let live = true;
    void (async () => {
      try {
        const { models } = await hostApi<{ models: OwnModelView[] }>(identity, "/api/runner/models.own.list");
        const found: Speech[] = [];
        for (const g of groupOwn(models)) {
          // The server's key is the one a model saved there carries: asked through that model, as List models does.
          const via = g.models.find((m) => m.hasKey) ?? g.models[0]!;
          const r = await hostApi<{ models: string[] }>(identity, "/api/runner/models.own.discover", { method: "POST", body: JSON.stringify({ id: via.id }) }).catch(() => ({ models: [] as string[] }));
          for (const m of r.models.filter(isSpeechModel)) found.push({ id: via.id, model: m, label: `${g.host.replace(/\/v1$/, "")} · ${m}` });
        }
        if (live) setList(found);
      } catch (e) {
        if (live) (setList([]), setError((e as Error).message));
      }
    })();
    return () => void (live = false);
  }, [identity, on]);
  return { list, error };
}

export function VoiceSection({ identity }: { identity: Identity }) {
  const prefs = useVoicePrefs();
  const [model, setModel] = useState<ModelStatus | null>(null);
  useEffect(() => void modelStatus().then(setModel, () => {}), []);
  const speech = useSpeechModels(identity, prefs.engine === "key");
  const keys = talkLabel(platformOf(navigator.platform));
  const picked = prefs.own && prefs.ownModel ? `${prefs.own}|${prefs.ownModel}` : "";
  const size = model ? ` ${mb(model.bytes)}` : "";
  const options: [VoicePick, string, string][] = [
    ["here", "On this computer", model?.ready ? `Private and works offline. Downloaded (${size.trim()}).` : `Private and works offline. A one-time${size} download.`],
    ["key", "With your own key", "Faster, through a speech model on a key you saved in Your models."],
  ];
  return (
    <section className="flex flex-col gap-5">
      <SettingsGroup>
        <Row label="Turn your voice into text" hint="Where your speech is made into words">
          <div className="voice-picks" role="radiogroup" aria-label="Turn your voice into text">
            {options.map(([v, name, sub]) => (
              <button key={v} type="button" role="radio" aria-checked={prefs.engine === v} className="voice-pick" data-on={prefs.engine === v || undefined} onClick={() => setVoicePrefs({ engine: v })}>
                <span className="voice-pick-name">{name}</span>
                <span className="voice-pick-sub">{sub}</span>
              </button>
            ))}
          </div>
        </Row>
        {prefs.engine === "key" && (
          <Row
            label="Speech model"
            hint={
              speech.list && !speech.list.length
                ? speech.error || "None of the servers in Your models lists a speech model. Add one there: OpenAI's gpt-4o-mini-transcribe, or Groq's whisper-large-v3-turbo."
                : "The recording goes to this server, with its key, and nowhere else"
            }
          >
            <Select
              value={picked}
              disabled={!speech.list?.length}
              onValueChange={(v) => {
                const [own, ...rest] = v.split("|");
                setVoicePrefs({ own: own ?? "", ownModel: rest.join("|") });
              }}
            >
              <SelectTrigger size="sm" aria-label="Speech model" className="voice-select h-8 text-[13px]">
                <SelectValue placeholder={speech.list === null ? "Reading your servers…" : speech.list.length ? "Pick one" : "None found"} />
              </SelectTrigger>
              <SelectContent>
                {(speech.list ?? []).map((s) => (
                  <SelectItem key={`${s.id}|${s.model}`} value={`${s.id}|${s.model}`}>
                    {s.label}
                  </SelectItem>
                ))}
                {/* Picked before and not listed now (the server is down): still shown as picked. */}
                {picked && speech.list && !speech.list.some((s) => `${s.id}|${s.model}` === picked) && <SelectItem value={picked}>{prefs.ownModel}</SelectItem>}
              </SelectContent>
            </Select>
          </Row>
        )}
        <Row label="Start talking" hint="The mic in the box always works too">
          <Choice
            label="Start talking"
            value={prefs.start}
            onChange={(v) => setVoicePrefs({ start: v })}
            options={[
              ["hold", `Hold ${keys}`],
              ["tap", `Tap ${keys}`],
            ]}
          />
        </Row>
        <Row label="Language" hint="What you speak">
          <Select value={prefs.language} onValueChange={(v) => setVoicePrefs({ language: v })}>
            <SelectTrigger size="sm" aria-label="Language" className="voice-select h-8 text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map(([code, name]) => (
                <SelectItem key={code} value={code}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <Row label="Send when you stop" hint={prefs.send ? "On: three words or more are sent as you stop; fewer wait in the box" : "Off: the words wait in the box for you to read first"}>
          <Switch aria-label="Send when you stop" checked={prefs.send} onCheckedChange={(v) => setVoicePrefs({ send: v })} />
        </Row>
      </SettingsGroup>
    </section>
  );
}

type VoicePick = "here" | "key";
