import { z } from "zod";
import { defineContract } from "./define-contract";
import { settingsJsonValueSchema } from "./placement-settings";

const id = z.string().min(1).max(200);
export const placementCatalogSchema = z.object({
  hostId: id,
  environments: z.array(z.object({
    id, displayName: z.string(), description: z.string(),
    machineProviderId: id.nullable(), environmentProviderId: id.nullable(),
    inputs: settingsJsonValueSchema.nullable(), acceptsEmptyInputs: z.boolean(),
  })),
  machines: z.array(z.object({ id, displayName: z.string(), description: z.string(), inputs: settingsJsonValueSchema.nullable(), acceptsEmptyInputs: z.boolean() })),
  hosts: z.array(z.object({ id, name: z.string(), connected: z.boolean() })),
  projects: z.array(z.object({ id, name: z.string(), remotes: z.array(z.string()), path: z.string().nullable() })),
});
export type PlacementCatalogView = z.infer<typeof placementCatalogSchema>;

export const placementPreviewInputSchema = z.object({
  projectId: id.nullable(), keeperThreadId: id.nullable(), keeperPath: z.string().min(1).max(32768).refine(value => !value.includes("\0")).nullable(),
  classId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), questId: id.nullable(),
}).strict();
export type PlacementPreviewInput = z.infer<typeof placementPreviewInputSchema>;

// provider-unverified and discovery-failed are reserved until those pipelines feed the preview.
export const placementWarningCodeSchema = z.enum(["no-keeper", "provider-unverified", "source-unreadable", "identity-unreadable", "discovery-failed"]);
export const placementWarningSchema = z.object({ code: placementWarningCodeSchema, text: z.string() }).strict();
export type PlacementWarning = z.infer<typeof placementWarningSchema>;

const evidence = z.object({ field: z.string(), value: z.string(), pattern: z.string() });
export const placementPreviewSchema = z.object({
  revision: z.number().int(),
  facts: z.object({ projectId: id.nullable(), repoRemotes: z.array(z.string()).nullable(), keeperPath: z.string().nullable(), keeperEnvironmentProvider: id.nullable(), classId: z.string(), questId: id.nullable() }),
  steps: z.array(z.object({ ruleId: id, outcome: z.enum(["off", "miss", "matched", "unreached"]), miss: z.object({ field: z.string(), value: z.string().nullable(), pattern: z.string() }).nullable() })),
  warnings: z.array(z.string()).optional(),
  warningDetails: z.array(placementWarningSchema).optional(),
  verdict: z.discriminatedUnion("state", [
    z.object({ state: z.literal("compatibility"), posture: z.string() }),
    z.object({ state: z.literal("matched"), ruleId: id, matchEvidence: z.array(evidence),
      blocked: z.object({ code: z.string(), message: z.string() }).nullable(), posture: z.string().nullable(), remote: z.boolean().nullable(),
      slot: z.enum(["maker", "checker"]).nullable(), slotsInUse: z.number().int().nullable(), slotCap: z.number().int().nullable(), partyCeiling: z.number().int() }),
    z.object({ state: z.literal("blocked"), code: z.literal("invalid-machine-policy"), problems: z.array(z.object({ path: z.string(), message: z.string() })) }),
  ]),
});
export type PlacementPreview = z.infer<typeof placementPreviewSchema>;

export const placementContract = defineContract({
  placementCatalog: { input: z.object({ projectId: id.optional(), hostId: id.optional() }).strict(), output: placementCatalogSchema, tags: () => ["tavern:settings"] },
  placementPreview: { input: placementPreviewInputSchema, output: placementPreviewSchema, tags: () => ["tavern:settings", "tavern:room"] },
});
