// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  artifactFileSchema, artifactManifestSchema, endpointSchema, executionPostureSchema,
  gitOidSchema, journalTargetSchema, placementRecordSchema, reviewEvidenceSchema,
  sourceSnapshotSchema, transferRecordSchema,
} from "../../src/shared/placement";
import { digest, endpoint, gitSha, placementRecord, sourceSnapshot } from "./placement-fixture";

const journal = {
  boardQuestId: "quest", waypointId: "w1", makerThreadId: "maker", journalEntryId: "00",
  entryFingerprint: digest, reviewAssignmentId: "assignment",
};
const artifact = { id: "artifact", sourceEndpointId: "storage", relativePath: "evidence/result.txt", size: 100, sha256: digest };
const transfer = {
  id: "transfer", placementId: "placement", placementGeneration: 1, direction: "carry-out",
  snapshotId: "snapshot", artifactManifestId: null, objectFormat: "sha1",
  from: endpoint, to: endpoint, expectedTree: gitSha, phase: "exporting", uploads: [], lastError: null,
};
const review = {
  placementId: "placement", placementGeneration: 1, snapshotId: "snapshot", makerSubmissionId: "submission",
  journal, expectedTree: gitSha, observedTree: gitSha, objectFormat: "sha1", checkerThreadId: "checker",
  checkerEndpoint: endpoint, cleanTracked: true, verdict: "verified", checkedAt: 1,
};
const manifest = {
  id: "manifest", placementId: "placement", placementGeneration: 1, snapshotId: "snapshot",
  files: [artifact], saved: [{ artifactId: "artifact", storageKey: "durable/receipt", sha256: digest }], notPreserved: [],
};

describe("machine placement wire schemas", () => {
  it("round-trips every strict record without adding or dropping fields", () => {
    for (const [schema, value] of [
      [endpointSchema, endpoint], [journalTargetSchema, journal],
      [executionPostureSchema, placementRecord().posture], [placementRecordSchema, placementRecord()],
      [sourceSnapshotSchema, sourceSnapshot()], [transferRecordSchema, transfer],
      [artifactFileSchema, artifact], [artifactManifestSchema, manifest], [reviewEvidenceSchema, review],
    ] as const) {
      expect(schema.parse(value)).toEqual(value);
      expect(schema.safeParse({ ...value, unknownAuthority: true }).success).toBe(false);
      for (const io of ["input", "output"] as const) expect(() => z.toJSONSchema(schema, { io })).not.toThrow();
    }
  });

  it("retains opaque target keys including an own __proto__ data key", () => {
    const target = JSON.parse('{"type":"provider","inputs":{"__proto__":{"safe":true},"Mixed_Key":null}}');
    const parsed = placementRecordSchema.parse(placementRecord({ target }));
    expect(JSON.stringify(parsed.target)).toBe(JSON.stringify(target));
    expect(Object.prototype.hasOwnProperty.call((parsed.target as typeof target).inputs, "__proto__")).toBe(true);
  });

  it("rejects non-JSON targets and unsafe integers", () => {
    const cycle: unknown[] = []; cycle.push(cycle);
    for (const target of [undefined, NaN, Infinity, new Date(), new Map(), cycle, { absent: undefined }]) {
      expect(placementRecordSchema.safeParse({ ...placementRecord(), target }).success).toBe(false);
    }
    for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(placementRecordSchema.safeParse(placementRecord({ generation })).success).toBe(false);
    }
  });

  it("accepts initial provenance without inventing a maker submission", () => {
    expect(sourceSnapshotSchema.parse(sourceSnapshot({ sourceThreadId: null })).makerSubmissionId).toBeNull();
    expect(sourceSnapshotSchema.safeParse(sourceSnapshot({ makerSubmissionId: "invented" })).success).toBe(false);
    expect(sourceSnapshotSchema.safeParse(sourceSnapshot({ purpose: "submission" })).success).toBe(false);
    expect(sourceSnapshotSchema.safeParse(sourceSnapshot({
      purpose: "submission", sourceThreadId: "maker", makerThreadId: "maker", makerSubmissionId: "submission", journalTarget: journal,
    })).success).toBe(true);
    expect(sourceSnapshotSchema.safeParse(sourceSnapshot({
      purpose: "submission", sourceThreadId: "stranger", makerThreadId: "maker", makerSubmissionId: "submission", journalTarget: journal,
    })).success).toBe(false);
  });

  it("checks every object id against the declared Git object format", () => {
    expect(gitOidSchema.safeParse("A".repeat(40)).success).toBe(false);
    expect(sourceSnapshotSchema.safeParse(sourceSnapshot({ objectFormat: "sha256" })).success).toBe(false);
    expect(sourceSnapshotSchema.safeParse(sourceSnapshot({
      objectFormat: "sha256", base: digest, sourceHead: digest, tree: digest, homeCommit: digest,
    })).success).toBe(true);
    expect(transferRecordSchema.safeParse({ ...transfer, expectedTree: digest }).success).toBe(false);
    expect(reviewEvidenceSchema.safeParse({ ...review, observedTree: digest }).success).toBe(false);
    expect(sourceSnapshotSchema.safeParse(sourceSnapshot({ homeRef: "refs/heads/main" })).success).toBe(false);
  });

  it("keeps closed blocked stages and an explicit resumable phase", () => {
    const blocked = { stage: "carry" as const, code: "offline", message: "Reconnect the machine", retryable: true };
    expect(placementRecordSchema.safeParse(placementRecord({ phase: "blocked", resumePhase: "carrying", blocked })).success).toBe(true);
    expect(placementRecordSchema.safeParse(placementRecord({ phase: "blocked", blocked })).success).toBe(false);
    expect(placementRecordSchema.safeParse(placementRecord({ blocked })).success).toBe(false);
    expect(placementRecordSchema.safeParse({ ...placementRecord(), phase: "blocked", resumePhase: "carrying", blocked: { ...blocked, stage: "anything" } }).success).toBe(false);
  });

  it("refuses unsafe artifact paths and invalid byte counts", () => {
    for (const relativePath of ["", ".", "../outside", "dir/../outside", "/etc/passwd", "C:/file", "dir\\file", "a//b", ".git/config", "a/.git/index", "a\0b"]) {
      expect(artifactFileSchema.safeParse({ ...artifact, relativePath }).success, relativePath).toBe(false);
    }
    for (const size of [-1, 0.5, 100 * 1024 * 1024 + 1]) {
      expect(artifactFileSchema.safeParse({ ...artifact, size }).success).toBe(false);
    }
  });

  it("never accepts a successful verdict for a dirty or different tree", () => {
    expect(reviewEvidenceSchema.safeParse({ ...review, observedTree: "c".repeat(40) }).success).toBe(false);
    expect(reviewEvidenceSchema.safeParse({ ...review, cleanTracked: false }).success).toBe(false);
    expect(reviewEvidenceSchema.safeParse({ ...review, cleanTracked: false, verdict: "inconclusive" }).success).toBe(true);
    expect(reviewEvidenceSchema.safeParse({ ...review, journal: { ...journal, makerSubmissionId: "spoofed" } }).success).toBe(false);
  });

  it("requires saved artifact receipts to belong to the declared manifest and hash", () => {
    expect(artifactManifestSchema.safeParse({ ...manifest, files: [artifact, artifact] }).success).toBe(false);
    expect(artifactManifestSchema.safeParse({ ...manifest, saved: [{ ...manifest.saved[0], artifactId: "foreign" }] }).success).toBe(false);
    expect(artifactManifestSchema.safeParse({ ...manifest, saved: [{ ...manifest.saved[0], sha256: "c".repeat(64) }] }).success).toBe(false);
  });
});
