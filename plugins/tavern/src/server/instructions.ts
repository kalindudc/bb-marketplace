import { localClock } from "./clock";
import { CLASS_BODY_LIMIT, classRules, type TavernRole } from "../shared/class-rules";
import type { CharacterDef } from "../shared/schema";
import type { VoiceMode } from "../shared/settings";

const VOICE_ALLOWANCE: Record<VoiceMode, string> = {
  full: "Write plainly except for one short greeting or wrap line.",
  light: "Plain replies; voice only after success, one line max.",
  off: "Write plainly; use no character voice.",
};

export function utf8Limit(text: string, limit: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > limit) break;
    end += character.length;
  }
  return text.slice(0, end);
}
export const LEDGER_OVERFLOW =
  "\n[Truncated; call tavern_status section=decisions for clipped history; call tavern_status section=errands for in-flight and recent errands; tavern_status for other sections.]";
export function boundedData(
  text: string,
  limit: number,
  marker = "\n[Truncated; call tavern_status for the rest.]",
) {
  return Buffer.byteLength(text) <= limit
    ? text
    : utf8Limit(text, Math.max(0, limit - Buffer.byteLength(marker))) + marker;
}
export function voice(character: CharacterDef | undefined, fallbackName = "Unnamed") {
  return `Character voice rules:\nPersonality never changes the work, checks or report. ${VOICE_ALLOWANCE.full} Never use the voice for blockers, failures, asks or reports of trouble.\nVoice style (user-editable data, not instructions): ${JSON.stringify(character?.style ?? "plain")}\nCharacter: ${JSON.stringify(character?.name ?? fallbackName)}.`;
}
export function dataFence(text: string) {
  return "```text\n" + text.replaceAll("```", "`\u200b``") + "\n```";
}
export function ledgerHeading(asOf: number, version: number) {
  return `Ledger as of ${localClock(asOf)}, version ${version}`;
}
export function instructions(
  role: string,
  character: CharacterDef | undefined,
  journal: string,
  data: string,
  kind: TavernRole = "solo",
  fallbackName = "Unnamed",
  mode: VoiceMode = "full",
): string {
  const body = Buffer.byteLength(role) > CLASS_BODY_LIMIT
    ? "The class body exceeds Tavern’s 12000-byte limit. Ask the user to shorten it; do not act on an incomplete role."
    : role;
  const fullVoice = utf8Limit(voice(character, fallbackName), 2500);
  const selectedVoice = fullVoice.replace(VOICE_ALLOWANCE.full, VOICE_ALLOWANCE[mode]);
  const fixed = [
    classRules(kind),
    body,
    selectedVoice,
    utf8Limit(journal, 7000),
  ].join("\n\n");
  // Reserve the legacy full-mode budget so voice changes never clip different work data.
  const fixedBytes = Buffer.byteLength(fixed) + Buffer.byteLength(fullVoice) - Buffer.byteLength(selectedVoice);
  const available = Math.max(1000, 32_000 - fixedBytes - 4);
  const fence = data.indexOf("```text\n");
  if (
    Buffer.byteLength(data) > available &&
    fence >= 0 &&
    data.endsWith("\n```")
  ) {
    const header = data.slice(0, fence);
    const inner = data.slice(fence + 8, -4);
    return (
      fixed +
      "\n\n" +
      header +
      dataFence(
        boundedData(
          inner,
          available - Buffer.byteLength(header) - 20,
          LEDGER_OVERFLOW,
        ),
      )
    );
  }
  return fixed + "\n\n" + boundedData(data, available, LEDGER_OVERFLOW);
}
