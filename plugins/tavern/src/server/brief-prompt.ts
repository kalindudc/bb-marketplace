import { limitMessage } from "../shared/limits";
import type { Brief } from "../shared/schema";

const prose = ["outcome", "doneWhen", "outOfScope"] as const;
const bytes = (text: string) => Buffer.byteLength(text);

function shortenProse(text: string, max: number) {
  if (bytes(JSON.stringify(text)) - 2 <= max) return text;
  const prefix: string[] = [];
  let remaining = max - bytes("…");
  for (const character of text) {
    const size = bytes(JSON.stringify(character)) - 2;
    if (size > remaining) break;
    prefix.push(character);
    remaining -= size;
  }
  return prefix.join("") + "…";
}

export function briefForPrompt(saved: Brief, max: number) {
  const brief: Brief = { ...saved, context: [], questions: [] };
  let room = max - bytes(JSON.stringify(brief));
  if (room < 0) {
    for (const key of prose) brief[key] = "";
    const share = Math.floor((max - bytes(JSON.stringify(brief))) / prose.length);
    for (const key of prose) brief[key] = shortenProse(saved[key], share);
    room = max - bytes(JSON.stringify(brief));
  }
  for (const key of ["questions", "context"] as const) {
    for (const line of saved[key]) {
      const size = bytes(JSON.stringify(line)) + (brief[key].length ? 1 : 0);
      if (size > room) break;
      brief[key].push(line);
      room -= size;
    }
  }
  const shortened = prose.some(key => saved[key] !== brief[key]) ||
    brief.questions.length !== saved.questions.length || brief.context.length !== saved.context.length;
  const notice = shortened
    ? `Brief shortened for the prompt. ${limitMessage("limits.intake.briefPromptBytes", max)} Read the saved brief with tavern_status section=brief and follow the offsets.`
    : null;
  return { brief, notice };
}
