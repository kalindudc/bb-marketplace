import { z } from "zod";

export const VOICE_CHECK_SITUATIONS = ["blocker", "ask", "failed", "report", "wrap"] as const;
export const VOICE_CHECK_PER_HOUR = 10;
export const voiceCheckTag = (characterId: string) => `tavern:voice-check:${characterId}`;

/** The draft a check runs. Only name and style reach an agent; quirks feed the rule that looks for the style's own words. */
export const voiceDraftSchema = z.object({ name: z.string().min(1).max(40), style: z.string().max(200), quirks: z.array(z.string().max(200)).max(5) }).strict();
export type VoiceDraft = z.infer<typeof voiceDraftSchema>;

export const voiceFailureSchema = z.object({
  /** A rule's name, or "tone" when the judge model failed it. */
  rule: z.string(),
  field: z.string(),
  quote: z.string(),
});
export const voiceSituationSchema = z.object({
  id: z.enum(VOICE_CHECK_SITUATIONS),
  title: z.string(),
  pass: z.boolean(),
  failures: z.array(voiceFailureSchema),
  /** The answer as the model wrote it (JSON text), so a failed row can open it in place; null when it gave none. */
  answer: z.string().nullable(),
});
// `name` is the model as bb's picker names it ("Claude Opus 5.5"); absent on checks from before it was recorded.
const model = z.object({ providerId: z.string(), model: z.string().nullable(), name: z.string().nullable().optional() });

export const voiceCheckSchema = z.object({
  id: z.string(),
  characterId: z.string(),
  /** What the check ran, to tell a result for an earlier draft: name and style are the fields an agent sees. */
  draft: z.object({ name: z.string(), style: z.string() }),
  state: z.enum(["running", "passed", "failed", "couldnt-run", "cancelled"]),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  writer: model.nullable(),
  /** The model that judged tone; null with tone "not-judged" means the result rests on rules only. */
  judge: model.nullable(),
  tone: z.enum(["judged", "not-judged"]).nullable(),
  /** Which judge was chosen and why, or why tone wasn't judged. Absent on checks from before it was recorded. */
  judgeNote: z.string().nullable().optional(),
  situations: z.array(voiceSituationSchema),
  /** Why a check couldn't run, in words for the editor. */
  reason: z.string().nullable(),
  /** Whose failure a couldn't-run was: Tavern's own (a bug; nothing wrong with the voice) or the model's (the provider refused, a timeout). */
  fault: z.enum(["tavern", "model"]).nullable().optional(),
  /** The raw error behind a couldn't-run, kept one fold away. */
  detail: z.string().nullable().optional(),
  /** What the run cost: Burn's recorded dollars when Burn is installed, and the tokens the threads reported. */
  cost: z.object({ usd: z.number().nullable(), tokens: z.number().int().nullable() }).nullable(),
});
export type VoiceCheck = z.infer<typeof voiceCheckSchema>;

/**
 * Whether a check was charged, which is what the hourly limit counts: it guards the user's money, so any run that may have cost
 * something counts, whoever caused a failure. Only a run known to have cost nothing (no turn ran, or no tokens were reported) is free.
 */
export function voiceCheckCharged(r: Pick<VoiceCheck, "state" | "cost">) {
  if (r.state === "running") return true;
  return r.cost !== null && ((r.cost.usd ?? 0) > 0 || (r.cost.tokens ?? 0) > 0);
}

export const voiceCheckViewSchema = z.object({
  /** Newest first, at most 20. */
  history: z.array(voiceCheckSchema),
  /** A check running anywhere in Tavern: one runs at a time. */
  running: voiceCheckSchema.nullable(),
  cap: z.object({ used: z.number().int(), max: z.number().int(), nextAt: z.number().nullable() }),
});
export type VoiceCheckView = z.infer<typeof voiceCheckViewSchema>;

const characterId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const voiceCheckContract = {
  voiceCheck: { input: z.object({ characterId }).strict(), output: voiceCheckViewSchema, tags: ({ characterId }: { characterId: string }) => [voiceCheckTag(characterId)] },
  // Client-only: the server refuses any caller that isn't the person in the app.
  voiceCheckStart: { input: z.object({ characterId, draft: voiceDraftSchema }).strict(), output: voiceCheckViewSchema },
  voiceCheckCancel: { input: z.object({ characterId, runId: z.string().min(1).max(100) }).strict(), output: voiceCheckViewSchema },
};
