import { z } from "zod";
import { askSchema, reportSchema } from "../../shared/schema";
import { SITUATIONS, type Situation, type SituationId } from "./situations";

/** The model writes its five answers between these lines, so the run can find them among other plugins' messages. */
export const ANSWER_START = "<<<TAVERN-VOICE-CHECK";
export const ANSWER_END = "TAVERN-VOICE-CHECK>>>";

export type RuleFailure = { rule: "missing" | "shape" | "missing-fact" | "voice-not-allowed" | "exclamation" | "emoji" | "shouting" | "style-word" | "speaker" | "too-long" | "tone"; field: string; quote: string };
export type SituationResult = { id: SituationId; pass: boolean; failures: RuleFailure[] };
export type RulesResult = { parsed: boolean; pass: boolean; situations: SituationResult[] };
export type Voice = { name: string; style: string; quirks: readonly string[] };

// The same inputs the real tools take (src/server/tools/index.ts), so an answer a tool would refuse fails here too.
const reportInput = reportSchema.pick({ status: true, outcome: true, headline: true, evidence: true, artifacts: true })
  .extend({ confidence: reportSchema.shape.confidence.default(null), voice: reportSchema.shape.voice.default(null) });
const askInput = askSchema.pick({ question: true, why: true, kind: true, options: true, meanwhile: true, holds: true }).extend({ options: askSchema.shape.options.min(2) });
const wrapInput = z.object({ boardQuestId: z.string().min(1), outcome: z.string().min(1).max(4000), left: z.string().max(4000), skipped: z.array(z.object({ waypointId: z.string().min(1), reason: z.string().min(1).max(500) })).max(24).default([]) });
export const TOOL_INPUT = { tavern_report: reportInput, tavern_ask: askInput, tavern_wrap: wrapInput } as const;

// Words too common to mark a voice, whatever the style says.
const COMMON = new Set("that this with have from they will would your their there what when which about into than then them these those some very just like more most also only over such been were does make made each much many well even back here where while being other always never often plain short calm".split(" "));
const words = (s: string) => s.toLowerCase().match(/\p{L}{4,}/gu) ?? [];

/** The value or values at a dotted path: "options.label" is every option's label. */
function at(value: unknown, path: string): string[] {
  const [head, ...rest] = path.split(".");
  const v = value && typeof value === "object" ? (value as Record<string, unknown>)[head!] : undefined;
  if (Array.isArray(v)) return v.flatMap((item) => rest.length ? at(item, rest.join(".")) : typeof item === "string" ? [item] : []);
  if (rest.length) return at(v, rest.join("."));
  return typeof v === "string" ? [v] : [];
}
const refLength = (s: Situation, field: string) => Math.max(0, ...at(s.reference, field).map((t) => t.length));

function judgeOne(s: Situation, raw: unknown, voice: Voice): RuleFailure[] {
  if (raw === undefined || raw === null) return [{ rule: "missing", field: s.id, quote: "" }];
  const parsed = TOOL_INPUT[s.tool].safeParse(raw);
  if (!parsed.success) return [{ rule: "shape", field: parsed.error.issues[0]?.path.join(".") || s.id, quote: parsed.error.issues[0]?.message ?? "" }];
  const answer = parsed.data as Record<string, unknown>;
  const out: RuleFailure[] = [];
  for (const fact of s.facts) {
    const found = fact.in.some((field) => at(answer, field).some((t) => t.toLowerCase().includes(fact.text.toLowerCase())));
    if (!found) out.push({ rule: "missing-fact", field: fact.in[0]!, quote: fact.text });
  }
  if (!s.voice && "voice" in answer && typeof answer.voice === "string" && answer.voice.trim()) out.push({ rule: "voice-not-allowed", field: "voice", quote: answer.voice });
  const brief = s.brief.toLowerCase();
  const bangWords = [...new Set(s.brief.match(/[^\s`'"()]*![^\s`'"()]*/g) ?? [])].filter((w) => /\w/.test(w));
  const styleWords = [...new Set(words(`${voice.style} ${voice.quirks.join(" ")}`))].filter((w) => !COMMON.has(w) && !brief.includes(w));
  const speaker = new RegExp(`(^|[.!?]\\s+)${voice.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(:|thinks|says|reckons|believes|feels|is (?:glad|sad|happy|sorry))`, "i");
  for (const field of s.plain) for (const text of at(answer, field)) {
    const ceiling = Math.max(80, Math.ceil(refLength(s, field) * 1.5));
    if (text.length > ceiling) out.push({ rule: "too-long", field, quote: `${text.length} of ${ceiling} characters` });
    // An exclamation mark that belongs to a word the brief gives (npm's "ERR!") is a fact, not a voice; blank those words out first.
    const own = bangWords.reduce((t, w) => t.split(w).join(" ".repeat(w.length)), text), bang = own.indexOf("!");
    if (bang >= 0) out.push({ rule: "exclamation", field, quote: text.slice(Math.max(0, bang - 30), bang + 1) });
    const emoji = text.match(/\p{Extended_Pictographic}/u);
    if (emoji) out.push({ rule: "emoji", field, quote: emoji[0] });
    const shout = (text.match(/\b[A-Z]{3,}\b/g) ?? []).find((w) => !s.brief.includes(w));
    if (shout) out.push({ rule: "shouting", field, quote: shout });
    const leak = styleWords.find((w) => new RegExp(`\\b${w}`, "iu").test(text));
    if (leak) out.push({ rule: "style-word", field, quote: leak });
    const said = text.match(speaker);
    if (said) out.push({ rule: "speaker", field, quote: said[0].trim() });
  }
  return out;
}

/** The fields of an answer that must read plain, with their text: what the tone judge reads, and where its quotes must be found. */
export function plainFields(s: Situation, answer: unknown): Record<string, string[]> {
  return Object.fromEntries(s.plain.map((field) => [field, at(answer, field)]));
}

/** Judge the five answers by rule. A situation passes with no failures; the run passes when every situation does. */
export function judgeRules(answers: unknown, voice: Voice): RulesResult {
  const parsed = !!answers && typeof answers === "object" && !Array.isArray(answers);
  const situations = SITUATIONS.map((s) => { const failures = parsed ? judgeOne(s, (answers as Record<string, unknown>)[s.id], voice) : [{ rule: "missing" as const, field: s.id, quote: "" }]; return { id: s.id, pass: failures.length === 0, failures }; });
  return { parsed, pass: parsed && situations.every((s) => s.pass), situations };
}

/**
 * The first marked answer in the agent's messages after Tavern's prompt. Other plugins can add turns to a hidden thread (the
 * live probe saw cortex inject its memory message and the model answer it too), so the last message is never trusted.
 */
export function readAnswer(agentMessages: readonly string[]): unknown {
  for (const text of agentMessages) {
    const start = text.indexOf(ANSWER_START), end = text.indexOf(ANSWER_END, start + ANSWER_START.length);
    if (start < 0 || end < 0) continue;
    try { return JSON.parse(text.slice(start + ANSWER_START.length, end)); } catch { return null; }
  }
  return null;
}
