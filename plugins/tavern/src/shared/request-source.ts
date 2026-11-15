import { z } from "zod";

const id = z.string().min(1).max(120);
const count = z.number().int().nonnegative();
export const requestSourcesSchema = z.object({
  version: z.literal(1), id, keeperThreadId: id, boardQuestId: id.nullable(), openingMissing: z.boolean(),
  sources: z.array(z.object({
    routeId: id, sourceMessageId: id.nullable(), messageAt: count,
    chars: count.nullable(), sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  }).strict()),
}).strict();
export type RequestSources = z.infer<typeof requestSourcesSchema>;
export const requestSourceReadSchema = z.object({
  manifestId: id, sourceIndex: count.default(0), offset: count.default(0),
}).strict();
