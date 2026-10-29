import { z } from "zod";
import { rpcContract as sourcesContract, sourceScopeSchema } from "../contract.ts";
import { defineContract } from "../define-contract.ts";
import { sourceScopeKey, type SourceScope } from "../web/contracts.ts";

export const rpcContract = defineContract({
 ...sourcesContract,
 snapshotMetadata: {
  input: z.object({ scope: sourceScopeSchema, snapshotId: z.string().min(1).max(200) }).strict(),
  output: z.object({
   contentType: z.string(),
   completeness: z.object({
    state: z.enum(["complete", "partial", "unknown"]),
    parts: z.array(z.object({ name: z.string(), state: z.enum(["complete", "partial", "unknown"]), fetched: z.number().int().nonnegative(), expected: z.number().int().nonnegative().optional(), reason: z.string().optional() }).strict()),
   }).strict(),
   warnings: z.array(z.object({ code: z.string(), stage: z.string(), message: z.string() }).strict()),
   title: z.string(), description: z.string(), language: z.string().nullable(),
  }).strict().nullable(),
  tags: (input: { scope: SourceScope }) => [`forage:sources:${sourceScopeKey(input.scope)}`],
 },
});
