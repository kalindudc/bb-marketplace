import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { nativeScopeVariablesSchema } from "./scope/host-env";
import { artifactFileSchema, endpointSchema, gitOidSchema, objectFormatSchema, sha256Schema, workspaceKindSchema } from "./shared/placement";

export const CHUNK_BYTES = 4 * 1024 * 1024;
export const BLOB_MAX_BYTES = 100 * 1024 * 1024;
const id = z.string().min(1).max(200).refine(value => !/[\0\r\n]/.test(value));
const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const size = z.number().int().min(0).max(BLOB_MAX_BYTES);
const offset = z.number().int().min(0).max(BLOB_MAX_BYTES);
const chunk = z.string().max(Math.ceil(CHUNK_BYTES / 3) * 4);
const text = z.string().max(16_384);
const path = z.string().min(1).max(32_768).refine(value => !value.includes("\0"));
export const repoPathSchema = z.string().min(1).max(4096).refine(value =>
  !/[\\\0:]/.test(value) && value.split("/").every(part => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git"),
  "Use a repository-relative path without traversal or Git metadata.");
export const gitRefSchema = z.string().min(1).max(1024).refine(value =>
  value.startsWith("refs/") && !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.includes("..") && !value.includes("@{") &&
  value.split("/").every(part => part !== "" && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock")),
  "Use a full Git ref.");
const remote = z.string().min(1).max(1024).refine(value => !value.startsWith("-") && !/[\0\r\n]/.test(value));
const baseBranch = z.string().min(1).max(1024).refine(value => !value.startsWith("-") && !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.includes("..")).refine(value => !value.startsWith("refs/") || gitRefSchema.safeParse(value).success, "Use a valid full Git fetch ref.");
const fileMode = z.enum(["100644", "100755", "120000"]);
const author = z.object({ name: z.string().max(500), email: z.string().max(500), date: z.string().regex(/^\d{1,12} [+-]\d{4}$/) }).strict();
const networkTimeoutMs = z.number().int().min(1000).max(15 * 60_000);
const unavailable = z.object({ outcome: z.literal("unavailable"), code: id, message: text, retryable: z.boolean() }).strict();
export const sourceBaseSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok"), via: z.enum(["upstream", "remote-head"]), base: gitOidSchema, remoteName: id, remoteUrl: remote, trackingRef: gitRefSchema, fetchRef: gitRefSchema }).strict(),
  unavailable,
]);
export type SourceBase = z.infer<typeof sourceBaseSchema>;
export const authoritySchema = z.object({ placementId: id, generation, endpointId: id, operationId: id }).strict();
export const transferAuthoritySchema = authoritySchema.extend({ transferId: id }).strict();
export const endpointRegistrationSchema = z.object({
  placementId: id, generation, endpointId: id, endpoint: endpointSchema,
  ownerThreadId: id.nullable(), access: z.enum(["source-read", "member-write", "home-import", "artifact-read", "artifact-store"]),
  workspaceKind: workspaceKindSchema.nullable(), objectFormat: objectFormatSchema.nullable(), allowedRefs: z.array(gitRefSchema).max(4),
}).strict();
export const transferRegistrationSchema = transferAuthoritySchema.extend({
  snapshotId: id, direction: z.enum(["bring-home", "carry-out", "artifacts"]), objectFormat: objectFormatSchema,
  base: gitOidSchema, head: gitOidSchema, tree: gitOidSchema,
  fromEndpointId: id, toEndpointId: id,
  allowedRefs: z.array(gitRefSchema).max(4), uploads: z.array(id).max(50_000), artifacts: z.array(artifactFileSchema).max(50_000),
}).strict().superRefine((value, ctx) => {
  const length = value.objectFormat === "sha1" ? 40 : 64;
  for (const key of ["base", "head", "tree"] as const) if (value[key].length !== length)
    ctx.addIssue({ code: "custom", path: [key], message: `Object id must use ${value.objectFormat}.` });
  for (const key of ["allowedRefs", "uploads"] as const) if (new Set(value[key]).size !== value[key].length)
    ctx.addIssue({ code: "custom", path: [key], message: "Values must be unique." });
  if (new Set(value.artifacts.map(file => file.id)).size !== value.artifacts.length)
    ctx.addIssue({ code: "custom", path: ["artifacts"], message: "Artifact ids must be unique." });
});
const scopeCall = z.object({
  kind: z.enum(["tool", "bash", "write", "read"]), toolName: id, input: z.record(z.string(), z.unknown()), cwd: path,
  resolvedPaths: z.record(z.string(), z.string()).optional(), pushTargets: z.record(z.string(), z.array(z.string())).optional(),
  pushHeads: z.record(z.string(), z.string()).optional(), gitRoots: z.record(z.string(), z.string()).optional(),
  directories: z.array(path).optional(), ownedDraftPrs: z.array(z.string()).optional(),
}).strict();
export const scopeDecisionSchema = z.discriminatedUnion("allow", [
  z.object({ allow: z.literal(true), check: z.boolean().optional() }).strict(),
  z.object({ allow: z.literal(false), ruleId: id, reason: text }).strict(),
]);
const empty = z.object({}).strict();
const retryable = { experimental_retryable: true } as const;

export const hostContract = defineRpcContract({
  registerEndpoint: {
    input: endpointRegistrationSchema,
    output: z.object({ registered: z.literal(true), generation }).strict(),
  },
  registerEndpoints: {
    input: z.object({ placementId: id, generation, operationId: id, endpoints: z.array(endpointRegistrationSchema).min(1).max(32) }).strict().superRefine((batch, ctx) => {
      if (new Set(batch.endpoints.map(endpoint => endpoint.endpointId)).size !== batch.endpoints.length)
        ctx.addIssue({ code: "custom", path: ["endpoints"], message: "A batch must contain distinct endpoint IDs." });
      if (batch.endpoints.some(endpoint => endpoint.placementId !== batch.placementId || endpoint.generation !== batch.generation))
        ctx.addIssue({ code: "custom", path: ["endpoints"], message: "Every endpoint must belong to this batch's placement and generation." });
    }),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("registered"), generation, endpointIds: z.array(id).min(1).max(32) }).strict(),
      z.object({ outcome: z.literal("waiting"), generation, active: z.number().int().min(0).max(32), required: z.number().int().min(1).max(32), limit: z.literal(32) }).strict().describe("Waiting for a transfer slot in this placement and generation, not on the whole host. Active counts its nonreleased grants; required counts only new endpoint IDs. The batch registered nothing."),
    ]),
  },
  releaseEndpoint: { input: authoritySchema, output: z.object({ released: z.boolean() }).strict() },
  releaseSnapshotRef: { input: transferAuthoritySchema, output: z.object({ released: z.boolean() }).strict() },
  revokePlacement: {
    input: z.object({ placementId: id, generation, reason: text }).strict(),
    output: z.object({ revoked: z.boolean(), generation }).strict(),
  },
  registerTransfer: {
    input: transferRegistrationSchema,
    output: z.object({ registered: z.literal(true), transferId: id }).strict(),
  },
  inspect: {
    ...retryable, input: authoritySchema,
    output: z.object({
      platform: id, home: path, tmp: z.array(path).max(10), piAgentDir: path.nullable(),
      root: path, artifactDirectory: path.optional(), sourceBase: sourceBaseSchema.optional(), repoRemotes: z.array(z.string().min(1).max(4096).refine(value => !/[\0\r\n]/.test(value))).max(200).optional(), branch: z.string().nullable(), head: gitOidSchema, tree: gitOidSchema,
      objectFormat: objectFormatSchema, linkedWorktree: z.boolean(),
      features: z.object({ porcelain: z.boolean(), exportChanges: z.boolean(), objectImport: z.boolean() }).strict(),
    }).strict().refine(value => value.sourceBase?.outcome !== "ok" || value.sourceBase.base.length === (value.objectFormat === "sha1" ? 40 : 64), "Source base must use the repository object format."),
  },
  prepareGuard: {
    input: authoritySchema.extend({ ruleId: id, allowMarkedInstall: z.boolean() }).strict(),
    output: z.object({ state: z.enum(["prepared", "unavailable", "unmarked", "failed"]), artifactDigest: sha256Schema.nullable(), scopeDirectory: path, warning: text.nullable() }).strict(),
  },
  bindScope: {
    input: authoritySchema.extend({ revision: generation, scopeDigest: sha256Schema, scopeFileJson: z.string().min(1).max(2 * 1024 * 1024) }).strict(),
    output: z.object({ revision: generation, scopeDigest: sha256Schema, scopeFile: path, variables: nativeScopeVariablesSchema }).strict(),
  },
  sessionStatus: {
    ...retryable, input: authoritySchema.extend({ revision: generation, scopeDigest: sha256Schema }).strict(),
    output: z.object({ state: z.enum(["not-observed", "armed", "stale"]), revision: generation.nullable(), scopeDigest: sha256Schema.nullable() }).strict(),
  },
  releaseScope: { input: authoritySchema, output: z.object({ released: z.boolean() }).strict() },
  prepareCall: {
    ...retryable, input: authoritySchema.extend({ scopeRevision: generation, call: scopeCall }).strict(),
    output: z.object({ call: scopeCall, scopeRevision: generation, scopeDigest: sha256Schema, decision: scopeDecisionSchema }).strict(),
  },
  worktreeState: {
    ...retryable, input: authoritySchema.extend({ base: baseBranch, trackedOnly: z.boolean().optional(), baseTree: gitOidSchema.optional() }).strict(),
    output: z.object({ branch: z.string().nullable(), head: gitOidSchema, tree: gitOidSchema, dirty: z.boolean(), changed: z.array(z.string()).max(100_000), unfinishedMerge: z.boolean().optional() }).strict(),
  },
  snapshotWorktree: {
    ...retryable, input: authoritySchema.extend({ base: gitOidSchema }).strict(),
    output: z.union([z.object({ head: gitOidSchema, headTree: gitOidSchema, commit: gitOidSchema, tree: gitOidSchema,
      includesUncommitted: z.boolean(), modifiedPaths: z.number().int().min(0).max(50_000), untrackedPaths: z.number().int().min(0).max(50_000),
    }).strict(), unavailable]),
  },
  commitAll: {
    input: authoritySchema.extend({ message: z.string().min(1).max(500) }).strict(),
    output: z.object({ sha: gitOidSchema, committed: z.boolean() }).strict(),
  },
  exportChanges: {
    ...retryable, input: transferAuthoritySchema,
    output: z.object({ base: gitOidSchema, head: gitOidSchema, tree: gitOidSchema, message: z.string().max(20_000), author,
      changes: z.array(z.object({ status: z.enum(["A", "M", "T", "D"]), path: repoPathSchema, mode: fileMode.optional(), blob: gitOidSchema.optional(), size: size.optional() }).strict()).max(50_000),
    }).strict(),
  },
  readBlob: {
    ...retryable, input: transferAuthoritySchema.extend({ sha: gitOidSchema, offset, length: z.number().int().min(0).max(CHUNK_BYTES) }).strict(),
    output: z.object({ data: chunk }).strict(),
  },
  importChunk: {
    input: transferAuthoritySchema.extend({ upload: id, offset, data: chunk }).strict(), output: z.object({ size }).strict(),
  },
  dropUploads: { input: transferAuthoritySchema.extend({ uploads: z.array(id).max(50_000) }).strict(), output: empty },
  importCommit: {
    input: transferAuthoritySchema.extend({ remote, baseBranch, message: z.string().max(20_000), author,
      entries: z.array(z.union([z.object({ path: repoPathSchema, mode: fileMode, upload: id }).strict(), z.object({ path: repoPathSchema, delete: z.literal(true) }).strict()])).max(50_000),
      refs: z.array(gitRefSchema).max(4), parent: gitOidSchema.optional(), networkTimeoutMs,
    }).strict(),
    output: z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("ok"), sha: gitOidSchema }).strict(), z.object({ outcome: z.literal("mismatch"), tree: gitOidSchema }).strict(), unavailable]),
  },
  carryStart: {
    input: transferAuthoritySchema.extend({ remote, baseBranch, replaces: gitOidSchema.optional(), paths: z.array(repoPathSchema).max(100_000), networkTimeoutMs }).strict(),
    output: z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("ok"), present: z.boolean(), from: gitOidSchema.optional() }).strict(), unavailable]),
  },
  carryWrite: {
    input: transferAuthoritySchema.extend({ path: repoPathSchema, mode: fileMode, offset, data: chunk }).strict(), output: z.object({ size }).strict(),
  },
  carryDelete: { input: transferAuthoritySchema.extend({ paths: z.array(repoPathSchema).max(50_000) }).strict(), output: empty },
  carryFinish: {
    input: transferAuthoritySchema.extend({ message: z.string().max(20_000), author, paths: z.array(repoPathSchema).max(50_000) }).strict(),
    output: z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("ok"), head: gitOidSchema, tree: gitOidSchema }).strict(), z.object({ outcome: z.literal("mismatch"), tree: gitOidSchema }).strict(), z.object({ outcome: z.literal("foreign"), paths: z.array(repoPathSchema).max(100_000) }).strict()]),
  },
  carryAbort: {
    input: transferAuthoritySchema.extend({ restore: gitOidSchema.optional() }).strict(),
    output: z.object({ clean: z.boolean().optional(), kept: z.array(z.string()).max(100_000).optional(), carried: z.array(z.object({ path: repoPathSchema, holds: z.enum(["carry", "before", "absent", "changed"]) }).strict()).max(100_000).optional() }).strict(),
  },
  inspectArtifacts: {
    ...retryable, input: authoritySchema.extend({ relativePaths: z.array(repoPathSchema).max(50_000) }).strict(),
    output: z.object({ files: z.array(artifactFileSchema).max(50_000), notPreserved: z.array(z.object({
      relativePath: repoPathSchema, code: z.enum(["artifact-unavailable", "unsafe-artifact"]), message: text,
    }).strict()).max(50_000).optional() }).strict(),
  },
  readArtifact: { ...retryable, input: transferAuthoritySchema.extend({ artifactId: id, offset, length: z.number().int().min(0).max(CHUNK_BYTES) }).strict(), output: z.object({ data: chunk }).strict() },
  artifactChunk: { input: transferAuthoritySchema.extend({ artifactId: id, offset, data: chunk }).strict(), output: z.object({ size }).strict() },
  finishArtifact: { input: transferAuthoritySchema.extend({ artifactId: id }).strict(), output: z.object({ storageKey: path, sha256: sha256Schema, size }).strict() },
});

export type HostMethod = keyof typeof hostContract;
export type HostInput<M extends HostMethod> = z.input<(typeof hostContract)[M]["input"]>;
export type HostOutput<M extends HostMethod> = z.output<(typeof hostContract)[M]["output"]>;
export type Authority = z.infer<typeof authoritySchema>;
export type TransferAuthority = z.infer<typeof transferAuthoritySchema>;
export type EndpointRegistration = z.infer<typeof endpointRegistrationSchema>;
export type TransferRegistration = z.infer<typeof transferRegistrationSchema>;
