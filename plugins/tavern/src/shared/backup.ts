import { z } from "zod";
import { defineContract } from "./define-contract";
import { settingsChangeSchema } from "./settings";

export const backupPartSchema = z.enum(["settings", "classes", "characters", "scopes"]);
export type BackupPart = z.infer<typeof backupPartSchema>;
export const backupCountsSchema = z.object({ classes: z.number().int().nonnegative(), characters: z.number().int().nonnegative(), records: z.number().int().nonnegative().nullable() });
export const backupEntrySchema = z.object({ name: z.string(), createdAt: z.number().int().nonnegative(), withData: z.boolean(), projects: z.boolean(), bytes: z.number().int().nonnegative(), tavernVersion: z.string(), counts: backupCountsSchema, problems: z.array(z.string()) });
export type BackupEntry = z.infer<typeof backupEntrySchema>;
export const backupManifestSchema = z.object({
  format: z.literal("tavern-backup/1"), tavernVersion: z.string().min(1), createdAt: z.number().int().nonnegative(),
  schemaVersion: z.number().int().nonnegative(), migrations: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
  machine: z.object({ hostname: z.string(), platform: z.string(), arch: z.string() }).strict(),
  data: z.object({ included: z.boolean(), bytes: z.number().int().nonnegative() }).strict(),
  parts: z.array(backupPartSchema), counts: backupCountsSchema,
  projects: z.array(z.object({ id: z.string(), name: z.string(), path: z.string() }).strict()),
  files: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative(),
    kind: z.enum(["settings", "class", "character", "scopes", "records"]), effective: z.boolean(),
    source: z.enum(["shipped", "global", "project"]), projectId: z.string().nullable(), id: z.string().nullable(),
  }).strict()), problems: z.array(z.string()),
}).strict();
export type BackupManifest = z.infer<typeof backupManifestSchema>;
export const backupBundleSchema = z.object({ manifest: backupManifestSchema, files: z.record(z.string(), z.string()) }).strict();
export type BackupBundle = z.infer<typeof backupBundleSchema>;
export const backupRestoreSchema = z.object({
  skippedForgeProfiles: z.array(z.string()).optional(),
  code: z.enum(["preview", "applied", "stale", "invalid"]), previewHash: z.string(),
  settings: z.object({ changes: z.array(settingsChangeSchema) }),
  files: z.array(z.object({ path: z.string(), kind: z.enum(["class", "character", "scopes"]), action: z.enum(["add", "change", "same"]) })),
  records: z.object({ action: z.enum(["restore", "refused", "none"]), counts: z.record(z.string(), z.number().int().nonnegative()), reason: z.string().nullable() }),
  problems: z.array(z.string()),
});
export type BackupRestore = z.infer<typeof backupRestoreSchema>;
const input = z.object({ withData: z.boolean().default(false), projects: z.boolean().default(false) }).strict();
export const backupContract = defineContract({
  backupList: { tags: () => ["tavern:backups"], input: z.object({}).strict(), output: z.object({ dir: z.string(), keep: z.number().int(), backups: z.array(backupEntrySchema), error: z.string().nullable(), dataBytes: z.number().nonnegative().nullable(), exportLimitBytes: z.number().int().positive() }) },
  backupSave: { input, output: z.object({ code: z.enum(["ok", "error"]), backup: backupEntrySchema.nullable(), pruned: z.array(z.string()), problem: z.string().nullable() }) },
  backupExport: { input: input.extend({ parts: z.array(backupPartSchema).min(1).optional() }).strict(), output: z.discriminatedUnion("code", [
    z.object({ code: z.literal("ok"), filename: z.string(), json: z.string(), counts: backupCountsSchema, bytes: z.number().int(), limit: z.number().int() }),
    z.object({ code: z.literal("too-large"), filename: z.null(), json: z.null(), counts: backupCountsSchema, bytes: z.number().int(), limit: z.number().int() }),
  ]) },
  backupRestore: { input: z.object({ from: z.union([z.object({ name: z.string() }).strict(), z.object({ bundle: z.string() }).strict()]), apply: z.boolean().default(false), previewHash: z.string().optional() }).strict(), output: backupRestoreSchema },
  registryFile: { tags: () => ["tavern:registry"], input: z.object({ kind: z.enum(["class", "character"]), id: z.string().min(1).max(100) }).strict(), output: z.object({ filename: z.string(), source: z.enum(["shipped", "global", "project"]), path: z.string().nullable(), text: z.string() }) },
  registryExportFolder: { input: z.object({ kind: z.enum(["class", "character"]), ids: z.array(z.string().min(1).max(100)).optional() }).strict(), output: z.object({ path: z.string(), files: z.array(z.string()) }) },
});
