import { z } from "zod";

export const CHARACTER_PRESENTATION_PROBLEM_PREFIX = "Character presentation: ";

export const characterAuthorshipSchema = z.object({
  characterId: z.string(),
  source: z.enum(["shipped", "global", "project"]),
  changedAt: z.number().int().nullable(),
});
export type CharacterAuthorship = z.infer<typeof characterAuthorshipSchema>;

export const characterReportVoiceSchema = z.object({
  reportId: z.string(), line: z.string().max(140), at: z.number().int().nonnegative(),
  threadId: z.string().nullable(), questId: z.string().nullable(),
});
export const characterReportVoicesSchema = z.object({
  characterId: z.string(), voices: z.array(characterReportVoiceSchema).max(3),
});
export type CharacterReportVoices = z.infer<typeof characterReportVoicesSchema>;
