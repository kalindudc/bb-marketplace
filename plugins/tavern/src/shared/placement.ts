import { z } from "zod";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const id = z.string().min(1).max(200);
const epoch = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(16_384);
const hostPath = z.string().min(1).max(32_768).refine(value => !value.includes("\0"));
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const gitOidSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const objectFormatSchema = z.enum(["sha1", "sha256"]);
export const slotKindSchema = z.enum(["maker", "checker"]);
export const workspaceKindSchema = z.enum(["linked-worktree", "dedicated-machine"]);
export const activePhaseSchema = z.enum([
  "reserved", "provisioning", "bootstrapping", "binding", "carrying", "ready",
  "running", "preserving", "releasing",
]);
export const blockStageSchema = z.enum([
  "match", "validate", "allocate", "provision", "bootstrap", "bind", "carry", "observe",
  "preserve", "stop", "release",
]);

function isJson(value: unknown): value is Json {
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > 64) return false;
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || ancestors.has(item)) return false;
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
    ancestors.add(item);
    const valid = (Array.isArray(item) ? Array.from(item) : Object.values(item))
      .every(child => visit(child, depth + 1));
    ancestors.delete(item);
    return valid;
  };
  return visit(value, 0);
}

const targetJson: z.ZodType<Json, Json> = z.any().refine(isJson, "Use finite, acyclic wire JSON.");

export const endpointSchema = z.object({
  hostId: id, environmentId: id.nullable(), root: hostPath,
}).strict();

export const journalTargetSchema = z.object({
  boardQuestId: id, waypointId: id, makerThreadId: id, journalEntryId: id,
  entryFingerprint: sha256Schema, reviewAssignmentId: id,
}).strict();

function checkObjectFormat(
  format: "sha1" | "sha256", values: Record<string, string | null>, ctx: z.RefinementCtx,
): void {
  const length = format === "sha1" ? 40 : 64;
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value.length !== length) {
      ctx.addIssue({ code: "custom", path: [key], message: `Object id must use ${format}.` });
    }
  }
}

function safeFetchUrl(value: string): boolean {
  if (value !== value.trim() || value.startsWith("-") || /[\0\r\n]/.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return ["http:", "https:", "ssh:", "git:", "file:"].includes(url.protocol) &&
        (url.protocol === "ssh:" || !url.username) && !url.password && !/[?#]/.test(value);
    } catch { return false; }
  }
  if (/^(?:[./]|[a-z]:[\\/])/i.test(value) || !value.includes(":")) return true;
  return /^((?:[^@/:\s]+@)?(?:\[[a-f0-9:]+\]|[a-z0-9._-]+)):([^\s?#]+)$/i.test(value);
}
const fetchRefSchema = z.string().min(1).max(1024).refine(value =>
  value.startsWith("refs/") && !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.includes("..") && !value.includes("@{") &&
  value.split("/").every(part => part !== "" && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock")),
  "Use the actual full fetch/tracking ref.");
export const sourceFetchSchema = z.object({
  via: z.enum(["upstream", "remote-head"]), remoteName: id.refine(value => !/[\0\r\n]/.test(value)),
  remoteUrl: z.string().min(1).max(1024).refine(safeFetchUrl, "Use credential-free native fetch provenance; SSH transport usernames are retained."),
  trackingRef: fetchRefSchema, fetchRef: fetchRefSchema,
}).strict();
export type SourceFetch = z.infer<typeof sourceFetchSchema>;

export const sourceSnapshotSchema = z.object({
  id, purpose: z.enum(["initial", "submission", "wip"]), keeperThreadId: id, projectId: id,
  sourceThreadId: id.nullable(), makerThreadId: id.nullable(), makerSubmissionId: id.nullable(),
  journalTarget: journalTargetSchema.nullable(), objectFormat: objectFormatSchema,
  ownerId: sha256Schema.optional(),
  journalTargets: z.array(journalTargetSchema).min(1).max(200).optional(),
  includesUncommitted: z.boolean().optional(), userHead: gitOidSchema.optional(), uncommittedOrigin: endpointSchema.optional(),
  modifiedPaths: z.number().int().min(0).max(50_000).optional(), untrackedPaths: z.number().int().min(0).max(50_000).optional(),
  base: gitOidSchema, sourceHead: gitOidSchema, tree: gitOidSchema, fetch: sourceFetchSchema.optional(),
  source: endpointSchema, home: endpointSchema, homeCommit: gitOidSchema.nullable(),
  homeRef: z.string().max(1024).regex(/^refs\/(?:heads\/)?tavern\/.+/), createdAt: epoch,
}).strict().superRefine((snapshot, ctx) => {
  checkObjectFormat(snapshot.objectFormat, {
    base: snapshot.base, sourceHead: snapshot.sourceHead, tree: snapshot.tree, homeCommit: snapshot.homeCommit, userHead: snapshot.userHead ?? null,
  }, ctx);
  if (snapshot.purpose === "initial") {
    if (snapshot.makerThreadId !== null || snapshot.makerSubmissionId !== null || snapshot.journalTarget !== null) {
      ctx.addIssue({ code: "custom", path: ["purpose"], message: "An initial source has no maker submission or review target." });
    }
    return;
  }
  if (!snapshot.makerThreadId || snapshot.sourceThreadId !== snapshot.makerThreadId) {
    ctx.addIssue({ code: "custom", path: ["makerThreadId"], message: "Capture work from its actual maker thread." });
  }
  if (snapshot.purpose === "submission" && (!snapshot.makerSubmissionId || !snapshot.journalTarget)) {
    ctx.addIssue({ code: "custom", path: ["makerSubmissionId"], message: "A submission needs its actual submission and journal identity." });
  }
  if (snapshot.journalTarget && snapshot.journalTarget.makerThreadId !== snapshot.makerThreadId) {
    ctx.addIssue({ code: "custom", path: ["journalTarget"], message: "Journal target belongs to another maker." });
  }
});

export const preservationSchema = z.object({
  source: z.enum(["not-needed", "pending", "saved", "unpreserved", "lost", "unknown"]),
  artifacts: z.enum(["not-declared", "pending", "saved", "unpreserved", "lost", "unknown"]),
  snapshotId: id.nullable(), artifactManifestId: id.nullable(), liveOwnerThreadId: id.nullable(),
  stopConfirmed: z.boolean(), reason: text.nullable(),
}).strict();

export const executionPostureSchema = z.object({
  aggregate: z.enum(["local-pre-exec", "local-detection-only", "remote-detection-only"]),
  guard: z.enum(["unavailable", "prepared", "armed", "failed"]),
  toolGate: z.enum(["pi-observed", "not-established"]),
  filesystem: z.enum(["macos-sandbox", "none", "not-established"]),
  network: z.enum(["macos-check-deny", "not-enforced", "not-established"]),
  checker: z.enum(["not-a-checker", "contained", "pre-exec-no-containment", "detection-only-no-containment"]),
  watcher: z.enum(["active", "degraded"]), ruleConsentId: id.nullable(), warnings: z.array(text).max(100),
}).strict();

export const sourceTransferReceiptSchema = z.object({
  id, generation, snapshotId: id, direction: z.literal("bring-home"),
  sourceEndpointId: id, homeEndpointId: id, verifyEndpointId: id,
  sourceSdk: endpointSchema, homeSdk: endpointSchema,
  phase: z.enum(["exporting", "uploading", "applying", "verified"]),
  manifest: z.object({ json: z.string().min(1).max(8 * 1024 * 1024), digest: sha256Schema }).strict().nullable(),
  uploads: z.array(id).max(50_000), homeCommit: gitOidSchema.nullable(),
}).strict().superRefine((receipt, ctx) => {
  if (receipt.phase !== "exporting" && receipt.manifest === null)
    ctx.addIssue({ code: "custom", path: ["manifest"], message: "Transport needs a durable exported manifest before uploading." });
  if ((receipt.phase === "verified") !== (receipt.homeCommit !== null))
    ctx.addIssue({ code: "custom", path: ["homeCommit"], message: "Only a verified transfer has a home commit." });
  if (new Set(receipt.uploads).size !== receipt.uploads.length)
    ctx.addIssue({ code: "custom", path: ["uploads"], message: "Upload handles must be unique." });
});
export type SourceTransferReceipt = z.infer<typeof sourceTransferReceiptSchema>;

export const carryReceiptSchema = z.object({
  id, generation, snapshotId: id, homeEndpointId: id, memberEndpointId: id,
  homeSdk: endpointSchema, memberSdk: endpointSchema, branch: z.string().min(1).max(1000),
  holdToken: z.string().min(1).max(100), replacesTree: gitOidSchema.nullable(),
  phase: z.enum(["holding", "exporting", "carrying", "verified"]),
  manifest: z.object({ json: z.string().min(1).max(8 * 1024 * 1024), digest: sha256Schema }).strict().nullable(),
  head: gitOidSchema.nullable(),
}).strict().superRefine((receipt, ctx) => {
  if (["carrying", "verified"].includes(receipt.phase) && receipt.manifest === null)
    ctx.addIssue({ code: "custom", path: ["manifest"], message: "Carry needs its durable immutable manifest." });
  if ((receipt.phase === "verified") !== (receipt.head !== null))
    ctx.addIssue({ code: "custom", path: ["head"], message: "Only a verified carry has an observed member commit." });
});
export type CarryReceipt = z.infer<typeof carryReceiptSchema>;

export const placementRecordSchema = z.object({
  id, generation, desiredState: z.enum(["running", "released"]), hireToken: id,
  keeperThreadId: id, memberThreadId: id.nullable(), projectId: id, questId: id.nullable(),
  classId: id, slot: slotKindSchema,
  rule: z.object({
    id, settingsRevision: epoch, definitionDigest: sha256Schema,
    acceptedConsent: z.object({
      guardInstall: z.boolean(), remoteDetectionOnly: z.boolean(), linuxUncontainedChecks: z.boolean(),
    }).strict(),
  }).strict().nullable(),
  matchEvidence: z.array(z.object({ field: id, value: text, pattern: text }).strict()).max(600),
  target: targetJson, allocationKey: id, ownsNewMachine: z.boolean(), workspaceKind: workspaceKindSchema.nullable(),
  hostId: id.nullable(), environmentId: id.nullable(), root: hostPath.nullable(),
  sourceSnapshotId: id.nullable(), submissionSnapshotId: id.nullable().default(null),
  reviewTarget: z.object({
    makerThreadId: id, makerSubmissionId: id, snapshotId: id,
    expectedTree: gitOidSchema, journal: journalTargetSchema,
  }).strict().nullable(),
  phase: z.enum([...activePhaseSchema.options, "released", "blocked"]),
  resumePhase: activePhaseSchema.nullable(),
  blocked: z.object({ stage: blockStageSchema, code: id, message: text, retryable: z.boolean() }).strict().nullable(),
  preservation: preservationSchema, posture: executionPostureSchema,
  transfers: z.array(sourceTransferReceiptSchema).max(1000).optional(),
  carries: z.array(carryReceiptSchema).max(1000).optional(),
  desiredScopeRevision: generation, acknowledgedScopeRevision: generation.nullable(),
  createdAt: epoch, updatedAt: epoch,
}).strict().superRefine((record, ctx) => {
  if (new Set(record.transfers?.map(transfer => transfer.id)).size !== (record.transfers?.length ?? 0))
    ctx.addIssue({ code: "custom", path: ["transfers"], message: "Transfer identities must be unique." });
  if (new Set(record.carries?.map(receipt => receipt.id)).size !== (record.carries?.length ?? 0))
    ctx.addIssue({ code: "custom", path: ["carries"], message: "Carry operation identities must be unique." });
  const blocked = record.phase === "blocked";
  if (blocked !== (record.blocked !== null) || blocked !== (record.resumePhase !== null)) {
    ctx.addIssue({ code: "custom", path: ["blocked"], message: "A blocked placement needs its stage and resume phase; other phases have neither." });
  }
  if (record.phase === "released" && record.desiredState !== "released") {
    ctx.addIssue({ code: "custom", path: ["desiredState"], message: "Released placements cannot request running." });
  }
  if (record.desiredState === "released" && (
    !["preserving", "releasing", "blocked", "released"].includes(record.phase) ||
    (record.resumePhase !== null && !["preserving", "releasing"].includes(record.resumePhase))
  )) {
    ctx.addIssue({ code: "custom", path: ["phase"], message: "A cancelled placement can only preserve or release; it cannot become ready again." });
  }
  if (record.acknowledgedScopeRevision !== null && record.acknowledgedScopeRevision > record.desiredScopeRevision) {
    ctx.addIssue({ code: "custom", path: ["acknowledgedScopeRevision"], message: "Cannot acknowledge a future scope revision." });
  }
  if (record.reviewTarget && record.reviewTarget.makerThreadId !== record.reviewTarget.journal.makerThreadId) {
    ctx.addIssue({ code: "custom", path: ["reviewTarget"], message: "Review target belongs to another maker." });
  }
});

export const transferRecordSchema = z.object({
  id, placementId: id, placementGeneration: generation,
  direction: z.enum(["bring-home", "carry-out", "artifacts"]), snapshotId: id,
  artifactManifestId: id.nullable(), objectFormat: objectFormatSchema,
  from: endpointSchema, to: endpointSchema, expectedTree: gitOidSchema,
  phase: z.enum(["exporting", "uploading", "applying", "verified", "aborted", "blocked"]),
  uploads: z.array(id).max(50_000), lastError: text.nullable(),
}).strict().superRefine((transfer, ctx) => {
  checkObjectFormat(transfer.objectFormat, { expectedTree: transfer.expectedTree }, ctx);
});

const relativePath = z.string().min(1).max(16_384).refine(value =>
  !/[\\\0:]/.test(value) && value.split("/").every(part =>
    part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git"),
  "Use a repository-relative path without traversal or .git components.",
);

export const artifactFileSchema = z.object({
  id, sourceEndpointId: id, relativePath,
  size: z.number().int().min(0).max(100 * 1024 * 1024), sha256: sha256Schema,
}).strict();

export const artifactManifestSchema = z.object({
  id, placementId: id, placementGeneration: generation, snapshotId: id,
  files: z.array(artifactFileSchema).max(50_000),
  saved: z.array(z.object({ artifactId: id, storageKey: z.string().min(1).max(4096), sha256: sha256Schema }).strict()).max(50_000),
  notPreserved: z.array(text).max(50_000),
}).strict().superRefine((manifest, ctx) => {
  const files = new Map(manifest.files.map(file => [file.id, file]));
  if (files.size !== manifest.files.length) ctx.addIssue({ code: "custom", path: ["files"], message: "Artifact ids must be unique." });
  const saved = new Set<string>();
  for (const [index, receipt] of manifest.saved.entries()) {
    if (saved.has(receipt.artifactId) || files.get(receipt.artifactId)?.sha256 !== receipt.sha256) {
      ctx.addIssue({ code: "custom", path: ["saved", index], message: "A receipt must name one declared artifact with its exact hash." });
    }
    saved.add(receipt.artifactId);
  }
});

export const reviewEvidenceSchema = z.object({
  placementId: id, placementGeneration: generation, snapshotId: id, makerSubmissionId: id,
  journal: journalTargetSchema, expectedTree: gitOidSchema, observedTree: gitOidSchema,
  objectFormat: objectFormatSchema, checkerThreadId: id, checkerEndpoint: endpointSchema,
  cleanTracked: z.boolean(), verdict: z.enum(["verified", "rejected", "inconclusive"]), checkedAt: epoch,
}).strict().superRefine((review, ctx) => {
  checkObjectFormat(review.objectFormat, { expectedTree: review.expectedTree, observedTree: review.observedTree }, ctx);
  if (review.verdict === "verified" && (!review.cleanTracked || review.expectedTree !== review.observedTree)) {
    ctx.addIssue({ code: "custom", path: ["verdict"], message: "Verification requires the exact clean submitted tree." });
  }
});

export type GitOid = z.infer<typeof gitOidSchema>;
export type Sha256 = z.infer<typeof sha256Schema>;
export type ObjectFormat = z.infer<typeof objectFormatSchema>;
export type SlotKind = z.infer<typeof slotKindSchema>;
export type WorkspaceKind = z.infer<typeof workspaceKindSchema>;
export type ActivePhase = z.infer<typeof activePhaseSchema>;
export type BlockStage = z.infer<typeof blockStageSchema>;
export type Endpoint = z.infer<typeof endpointSchema>;
export type JournalTarget = z.infer<typeof journalTargetSchema>;
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;
export type Preservation = z.infer<typeof preservationSchema>;
export type ExecutionPosture = z.infer<typeof executionPostureSchema>;
export type PlacementRecord = z.infer<typeof placementRecordSchema>;
export type TransferRecord = z.infer<typeof transferRecordSchema>;
export type ArtifactFile = z.infer<typeof artifactFileSchema>;
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
export type ReviewEvidence = z.infer<typeof reviewEvidenceSchema>;
