import { localClock } from "./clock";
import { CLASS_BODY_LIMIT, classRules, type TavernRole } from "../shared/class-rules";
import { PI_STATE_BEGIN, PI_STATE_END } from "../shared/text";
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
  "\n[Truncated; call tavern_status section=decisions for clipped history; call tavern_status section=errands for in-flight and recent errands; call tavern_status section=placement for where work runs; tavern_status for other sections.]";
export function boundedData(
  text: string,
  limit: number,
  marker = "\n[Truncated; call tavern_status for the rest.]",
) {
  return Buffer.byteLength(text) <= limit
    ? text
    : utf8Limit(text, Math.max(0, limit - Buffer.byteLength(marker))) + marker;
}
export function dataFence(text: string) {
  return "```text\n" + text.replaceAll("```", "`\u200b``") + "\n```";
}
export function ledgerHeading(asOf: number, version: number) {
  return `Ledger as of ${localClock(asOf)}, version ${version}`;
}
export function instructions(
  role: string,
  characterName: string | undefined,
  journal: string,
  data: string,
  kind: TavernRole = "solo",
  framePiState = false,
): string {
  const body = Buffer.byteLength(role) > CLASS_BODY_LIMIT
    ? "The class body exceeds Tavern’s 12000-byte limit. Ask the user to shorten it; do not act on an incomplete role."
    : role;
  const stable = [
    classRules(kind),
    body,
    `Character: ${JSON.stringify(characterName ?? "Unnamed")}.`,
  ].join("\n\n");
  const journalText = utf8Limit(journal, 7000);
  const escapeFrame = (text: string) => text
    .replaceAll(PI_STATE_BEGIN, PI_STATE_BEGIN.replace("[", "[\u200b"))
    .replaceAll(PI_STATE_END, PI_STATE_END.replace("[", "[\u200b"));
  const fixed = framePiState
    ? escapeFrame(stable) + PI_STATE_BEGIN + (journalText ? escapeFrame(journalText) + "\n\n" : "")
    : stable + "\n\n" + journalText + "\n\n";
  const end = framePiState ? PI_STATE_END : "";
  if (framePiState) data = escapeFrame(data);
  const available = Math.max(1000, 32_000 - Buffer.byteLength(fixed + end) - 2);
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
      header +
      dataFence(
        boundedData(
          inner,
          available - Buffer.byteLength(header) - 20,
          LEDGER_OVERFLOW,
        ),
      ) + end
    );
  }
  return fixed + boundedData(data, available, LEDGER_OVERFLOW) + end;
}
