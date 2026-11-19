import { experimental_useAppPanel, experimental_useRpcMutation, experimental_useRpcQuery, type ExperimentalTabReference, type JsonValue, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { rpcContract, type Room } from "../../shared/contract";
import { CHARGES, HUES, characterDefSchema, type CharacterDef } from "../../shared/schema";
import { Crest, levelsShown, useRegistry } from "../kit";
import { FormSkeleton, PageLoad } from "./skeletons";
import { AwayForm } from "./away";
import { type Registry } from "./common";
import { PageGlyph } from "./glyphs";
import { VoiceCheckBox } from "./voice-check";
import { AvatarRoll } from "./avatar-roll";
import { BubbleFields, readBubbleDraft, type BubbleEdits } from "./bubble-lines";

type NavTab = ExperimentalTabReference & { availability: "action"; context: { kind: "nav-panel"; panelId: string } };
export const CLOSING_TAB: NavTab = { id: "closing-time", context: { kind: "nav-panel", panelId: "tavern" }, availability: "action" };
export const VOICE_TAB: NavTab = { id: "character-voice", context: { kind: "nav-panel", panelId: "tavern" }, availability: "action" };
export const CLASS_EDIT_TAB: NavTab = { id: "class-edit", context: { kind: "nav-panel", panelId: "tavern" }, availability: "action" };
export const REPORTS_TAB: NavTab = { id: "member-reports", context: { kind: "nav-panel", panelId: "tavern" }, availability: "action" };

/** Opens a form in bb's side panel beside the page; false when bb declines, so the caller shows it in place instead. */
export function useOpenPanelTab() {
  const panel = experimental_useAppPanel();
  return (tab: NavTab, params?: JsonValue, title?: string) => panel.openTab({ tab, ...(params === undefined ? {} : { params }), ...(title ? { title } : {}) });
}


/** The closing-time form: drawn in the side panel, or in place on the page when no panel is available (AwayForm, in away.tsx). */
export function ClosingTimeForm({ room }: { room: Room }) {
  const registry = useRegistry();
  return registry.data ? <AwayForm room={room} registry={registry.data} /> : <PageLoad error={registry.error} retry={registry.refetch} skeleton={<FormSkeleton fields={2} />} label="the Closing time sheet" />;
}

export function ClosingTimeTab(_props: PluginNavPanelProps & { params: JsonValue | null }) {
  const room = experimental_useRpcQuery({ contract: rpcContract, method: "room", input: {} });
  return <div className="tavern tv-page tv-paneltab">{room.data ? <ClosingTimeForm room={room.data} /> : <PageLoad error={room.error} retry={room.refetch} skeleton={<FormSkeleton fields={2} />} label="the Closing time sheet" />}</div>;
}

/** The voice editor: presentation fields only, saved to the user's character override. */
export function CharacterVoiceForm({ character, registry }: { character: CharacterDef; registry: Registry }) {
  const [draft, setDraft] = useState(character);
  const [saved, setSaved] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [bubbleEdits, setBubbleEdits] = useState<BubbleEdits>({});
  const [checkedBubbles, setCheckedBubbles] = useState(false);
  const { says, errors } = readBubbleDraft(draft.says, bubbleEdits);
  const save = experimental_useRpcMutation({ contract: rpcContract, method: "saveCharacterVoice" });
  const cls = registry.classes.find((c) => c.id === character.classes[0]);
  const edit = <K extends keyof CharacterDef,>(key: K, value: CharacterDef[K]) => { setDraft((prev) => ({ ...prev, [key]: value })); setSaved(false); setInvalid(null); };
  const persist = async (form: HTMLFormElement) => {
    const first = Object.keys(errors)[0];
    if (first) {
      setCheckedBubbles(true);
      const field = form.elements.namedItem(`says-${first}`);
      if (field instanceof HTMLTextAreaElement) field.focus();
      return;
    }
    const parsed = characterDefSchema.safeParse(draft);
    if (!parsed.success) { setInvalid(parsed.error.issues.map((issue) => issue.message).join(" ")); return; }
    const { name, hue, charge, temper, style, quirks, lines } = parsed.data;
    try {
      const result = await save.mutate({ characterId: character.id, voice: { name, hue, charge, temper, style, quirks, lines, ...(Object.keys(bubbleEdits).length ? { says } : {}) } });
      setDraft(result); setBubbleEdits({}); setCheckedBubbles(false); setSaved(true);
    } catch { /* Server failures leave the edited fields intact. */ }
  };
  return <form className="tv-form" aria-label={`Edit ${character.name}'s voice`} onSubmit={(event) => { event.preventDefault(); void persist(event.currentTarget); }}>
    <header className="tv-form-h">{cls && <Crest cls={cls} character={draft} size={28} />}<h2>{draft.name}'s voice and avatar</h2></header>
    <AvatarRoll character={character} mode={registry.ambientMotion} />
    <p className="m small">Presentation only: short threshold lines, no identity, emotion or expertise claims. Asks, blockers, findings, evidence and numbers stay plain.{levelsShown(registry) && " Agents never see levels."}</p>
    <fieldset disabled={save.isPending} className="tv-fields"><legend className="sr">Character voice</legend>
      <label className="tv-field">Name<input className="tv-inp" maxLength={40} required value={draft.name} onChange={(e) => edit("name", e.target.value)} /></label>
      <label className="tv-field">Temperament<input className="tv-inp" maxLength={40} value={draft.temper} onChange={(e) => edit("temper", e.target.value)} /></label>
      <label className="tv-field">Hue<select className="tv-inp" value={draft.hue} onChange={(e) => edit("hue", e.target.value as CharacterDef["hue"])}>{HUES.map((hue) => <option key={hue}>{hue}</option>)}</select></label>
      <label className="tv-field">Charge<select className="tv-inp" value={draft.charge} onChange={(e) => edit("charge", e.target.value as CharacterDef["charge"])}>{CHARGES.map((charge) => <option key={charge}>{charge}</option>)}</select></label>
      <label className="tv-field wide">Voice style<input className="tv-inp" maxLength={200} value={draft.style} onChange={(e) => edit("style", e.target.value)} /></label>
      <label className="tv-field wide">Quirks (one per line, at most five)<textarea className="tv-inp" aria-label="Quirks (one per line, at most five)" value={draft.quirks.join("\n")} onChange={(e) => edit("quirks", e.target.value ? e.target.value.split("\n") : [])} /></label>
      {(Object.keys(draft.lines) as (keyof CharacterDef["lines"])[]).map((slot) => <label key={slot} className="tv-field wide">{slot} line<textarea className="tv-inp" aria-label={`${slot} line`} value={draft.lines[slot]} maxLength={140} onChange={(e) => edit("lines", { ...draft.lines, [slot]: e.target.value })} /></label>)}
      <BubbleFields saved={draft.says} edits={bubbleEdits} errors={checkedBubbles ? errors : {}} onEdit={(key, text) => {
        setBubbleEdits(previous => ({ ...previous, [key]: text })); setSaved(false); setInvalid(null);
      }} />
    </fieldset>
    <section className="tv-grpbox" aria-label="Voice preview"><div className="lbl">Preview · your draft</div><dl className="tv-preview">{Object.entries(draft.lines).map(([slot, line]) => <div key={slot}><dt>{slot}</dt><dd className="tv-voice">{line}</dd></div>)}</dl></section>
    <VoiceCheckBox characterId={character.id} draft={{ name: draft.name, style: draft.style, quirks: draft.quirks }} voice={registry.voice} />
    <footer className="tv-formf"><button className="btn pri" type="submit" disabled={save.isPending}><span>{save.isPending ? "Saving…" : `Save ${character.name}`}</span></button><button className="btn" type="button" disabled={save.isPending} onClick={() => { setDraft(character); setBubbleEdits({}); setCheckedBubbles(false); setSaved(false); setInvalid(null); }}><span>Discard draft</span></button>{saved && <span role="status" className="tv-saved"><PageGlyph name="done" /><span>Voice saved to your character override.</span></span>}</footer>
    {invalid && <p className="tv-problem" role="alert">{invalid}</p>}
    {save.error && <p className="tv-problem" role="alert">Voice not saved: {save.error.message}</p>}
  </form>;
}

export function CharacterVoiceTab({ params }: PluginNavPanelProps & { params: JsonValue | null }) {
  const registry = useRegistry();
  const id = params && typeof params === "object" && !Array.isArray(params) && typeof params.characterId === "string" ? params.characterId : null;
  const character = registry.data?.characters.find((c) => c.id === id);
  return <div className="tavern tv-page tv-paneltab">{registry.data ? character ? <CharacterVoiceForm key={character.id} character={character} registry={registry.data} /> : <p className="tv-empty" data-empty>Character not found{id ? `: ${id}` : ""}.</p> : <PageLoad error={registry.error} retry={registry.refetch} skeleton={<FormSkeleton fields={4} />} label="the character’s voice" />}</div>;
}
