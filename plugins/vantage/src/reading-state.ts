import { z } from "zod";

export const threadIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const part = z.union([
  z.literal("uncommitted"),
  z.literal("committed"),
  z.custom<`commit:${string}`>((value) => typeof value === "string" && /^commit:[0-9a-f]{7,64}$/.test(value)),
  z.literal("recorded"),
]);
const path = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => !value.includes("\0"));
const file = z.object({ file: path, part }).strict();
export const readingSchema = z
  .object({
    scope: z.union([part, z.literal("all")]),
    file: path.optional(),
    part: part.optional(),
    anchor: file
      .extend({ offset: z.number().int().min(-100_000).max(100_000) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => (value.file === undefined) === (value.part === undefined));
export type Reading = z.infer<typeof readingSchema>;
export type ReadingPart = z.infer<typeof part>;

export const subjectSchema = z
  .object({
    threadId: z.string().regex(threadIdPattern),
    source: z.enum(["checkout", "branch", "recorded", "unavailable"]),
    worktreeKey: z
      .string()
      .min(1)
      .max(400)
      .refine((value) => !value.includes("\0"))
      .optional(),
  })
  .strict();
export type Subject = z.infer<typeof subjectSchema>;
const arrivalSchema = z.union([z.string().regex(/^[0-9a-f]{32}$/), z.literal("resume")]);
export type Handoff = Subject & Reading & { arrival?: string };
export function newHandoff(handoff: Omit<Handoff, "arrival">): Handoff {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return { ...handoff, arrival: [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
}

export function parseHandoff(value: unknown): Handoff | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { threadId, source, worktreeKey, arrival, ...reading } = value as Record<string, unknown>;
  const subject = subjectSchema.safeParse({ threadId, source, ...(worktreeKey === undefined ? {} : { worktreeKey }) });
  const parsed = readingSchema.safeParse(reading);
  if (!subject.success || !parsed.success) return null;
  if ((source === "checkout" || source === "branch") !== (worktreeKey !== undefined)) return null;
  const id = arrivalSchema.optional().safeParse(arrival);
  if (!id.success) return null;
  return { ...subject.data, ...parsed.data, ...(id.data === undefined ? {} : { arrival: id.data }) };
}

export const readingKey = (surface: string, subject: Subject): string =>
  JSON.stringify([surface, subject.threadId, subject.source, subject.worktreeKey ?? null]);
export const readingOf = ({ scope, file, part, anchor }: Reading): Reading => ({
  scope,
  ...(file === undefined ? {} : { file, part }),
  ...(anchor === undefined ? {} : { anchor }),
});
