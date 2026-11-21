import { KNOB_FIELDS } from "../../shared/settings";
import { knobLabel } from "./insights";

const LABELS: Record<string, string> = {
  "tavern.ambientMotion": "Ambient motion", "tavern.repeatSeconds": "Repeat every", "tavern.agentsMayChangeSettings": "Agents may change settings", "tavern.paused": "Pause every Keeper", "tavern.defaultClass": "New threads start as", "tavern.voice": "Speech bubbles", "tavern.widgetRow": "Widget row", "tavern.batchWakeEvents": "Batch wake events", "tavern.levels": "Levels and crest notches", "tavern.characters": "Show characters", "tavern.hearthFlicker": "Hearth flicker while work runs",
  "tavern.lanternLight": "Lantern light", "tavern.lanternStrength": "Strength", "tavern.lanternLightBb": "Light bb's surfaces",
  "tavern.characterQuietUntil": "Character quiet", "tavern.voiceBeforeOff": "Previous speech level",
  "attention.reviewBudget": "Review budget", "attention.notify": "Push to your devices", "attention.quietHours": "Quiet hours",
  "keepers.restMinutes": "Rest before reminder", "keepers.greenlight": "Greenlight", "keepers.decisionTimerMax": "Longest decision timer", "keepers.partyMax": "Party ceiling", "keepers.staleStrikes": "Strikes before release advice", "keepers.restatementBytes": "Keeper restatement limit", "keepers.tickFactChars": "Tick facts limit",
  "scopes.mode": "Scopes", "scopes.sendTools": "Sending and drafting", "journal.journalReminders": "Journal reminders", "journal.journalQuietMinutes": "Quiet before a reminder",
  "data.historyDays": "Keep history", "data.autoArchiveDays": "Send returned quests to the cellar after", "tuning.mode": "Tuning",
};
/** A settings path in words: TOML's snake_case and the RPC's camelCase both map to the label the row uses. */
export function settingLabel(key: string) {
  const camel = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()).replace(/^(?:tuning\.pinned|tuned)\./, "knobs.");
  const [group, field] = camel.split(".");
  const known = (KNOB_FIELDS[group as keyof typeof KNOB_FIELDS] as Record<string, {label:string}> | undefined)?.[field!];
  if (known) return known.label;
  if (camel.startsWith("knobs.")) return knobLabel(camel);
  const cls = camel.match(/^classes\.([^.]+)\.(provider|model|reasoning)$/);
  const words = (word: string) => word.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ");
  const label = LABELS[camel] ?? (cls ? `${cls[1]} ${cls[2]}` : words(camel.split(".").at(-1)!));
  return label.charAt(0).toUpperCase() + label.slice(1);
}
