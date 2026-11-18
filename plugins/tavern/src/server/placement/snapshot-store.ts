import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  endpointSchema, gitOidSchema, journalTargetSchema, objectFormatSchema, placementRecordSchema,
  sha256Schema, sourceFetchSchema, sourceSnapshotSchema, sourceTransferReceiptSchema,
  type PlacementRecord, type SourceSnapshot, type SourceTransferReceipt,
} from "../../shared/placement";
import type { Database } from "../ports";

const contentSchema = z.object({
  objectFormat: objectFormatSchema, base: gitOidSchema, sourceHead: gitOidSchema, tree: gitOidSchema,
  fetch: sourceFetchSchema, source: endpointSchema, home: endpointSchema,
}).strict().superRefine((content, ctx) => {
  const length = content.objectFormat === "sha1" ? 40 : 64;
  for (const key of ["base", "sourceHead", "tree"] as const)
    if (content[key].length !== length) ctx.addIssue({ code: "custom", path: [key], message: "Object format does not match the content identity." });
});
type Content = z.infer<typeof contentSchema>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function contentOf(snapshot: Pick<SourceSnapshot, "objectFormat" | "base" | "sourceHead" | "tree" | "fetch" | "source" | "home">): Content {
  return contentSchema.parse({ objectFormat: snapshot.objectFormat, base: snapshot.base, sourceHead: snapshot.sourceHead,
    tree: snapshot.tree, fetch: snapshot.fetch, source: snapshot.source, home: snapshot.home });
}
export function snapshotOwnerId(snapshot: Parameters<typeof contentOf>[0]): string {
  return hash(["tavern-snapshot-owner/1", contentOf(snapshot)]);
}
export function snapshotDescriptorId(snapshot: SourceSnapshot): string {
  return "source-" + hash(["tavern-source-descriptor/1", snapshotOwnerId(snapshot), {
    purpose: snapshot.purpose, keeperThreadId: snapshot.keeperThreadId, projectId: snapshot.projectId,
    sourceThreadId: snapshot.sourceThreadId, makerThreadId: snapshot.makerThreadId, makerSubmissionId: snapshot.makerSubmissionId,
    journalTarget: snapshot.journalTarget === null ? null : journalTargetSchema.parse(snapshot.journalTarget),
  }]);
}
const ownerSchema = z.object({
  id: sha256Schema, generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), content: contentSchema,
  homeRef: z.string(), homeCommit: gitOidSchema.nullable(), phase: z.enum(["retained", "releasing", "released"]),
  operationToken: z.string().min(1).max(100).nullable().optional(),
  homeTransfer: z.object({
    sourceOwnerThreadId: z.string().min(1).max(200), homeOwnerThreadId: z.string().min(1).max(200),
    receipt: sourceTransferReceiptSchema,
  }).strict().optional(),
}).strict().superRefine((owner, ctx) => {
  if (owner.id !== snapshotOwnerId(owner.content) || owner.homeRef !== "refs/tavern/snapshots/" + owner.id)
    ctx.addIssue({ code: "custom", message: "Immutable snapshot owner identity does not match its content address." });
  if (owner.homeCommit !== null && owner.homeCommit.length !== (owner.content.objectFormat === "sha1" ? 40 : 64))
    ctx.addIssue({ code: "custom", path: ["homeCommit"], message: "Pinned home commit has a different object format." });
  const receipt = owner.homeTransfer?.receipt;
  if (receipt && (receipt.snapshotId !== owner.id || receipt.generation !== owner.generation ||
      receipt.id !== "home-" + hash([owner.id, owner.generation]) ||
      receipt.sourceSdk.hostId !== owner.content.source.hostId || receipt.sourceSdk.environmentId !== owner.content.source.environmentId ||
      receipt.homeSdk.hostId !== owner.content.home.hostId || receipt.homeSdk.environmentId !== owner.content.home.environmentId ||
      receipt.phase === "verified" && receipt.homeCommit !== owner.homeCommit))
    ctx.addIssue({ code: "custom", path: ["homeTransfer"], message: "The home transfer does not belong to this immutable snapshot owner." });
});
export type SnapshotOwner = z.infer<typeof ownerSchema>;

function referenceIds(record: PlacementRecord): Set<string> {
  return new Set([
    record.sourceSnapshotId, record.submissionSnapshotId, record.reviewTarget?.snapshotId, record.preservation.snapshotId,
    ...(record.transfers ?? []).map(item => item.snapshotId), ...(record.carries ?? []).map(item => item.snapshotId),
  ].filter((id): id is string => typeof id === "string"));
}

export class SnapshotStore {
  private readonly submissionReads = new Map<string, { token: string; assertHeld(): void }>();
  constructor(private readonly db: Database) {}

  async withSubmissionReadReference<T>(placementId: string, generation: number, snapshotId: string, assertHeld: () => void, work: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([placementId, generation, snapshotId]);
    if (this.submissionReads.has(key)) throw new Error("A submission capture already holds this read reference");
    assertHeld();
    const capture = { token: randomUUID(), assertHeld };
    this.submissionReads.set(key, capture);
    try { return await work(); }
    finally { if (this.submissionReads.get(key)?.token === capture.token) this.submissionReads.delete(key); }
  }

  hasSubmissionReadReference(placementId: string, generation: number, snapshotId: string): boolean {
    const capture = this.submissionReads.get(JSON.stringify([placementId, generation, snapshotId]));
    if (!capture) return false;
    capture.assertHeld();
    return true;
  }

  get(id: string): SnapshotOwner | null {
    const row = this.db.prepare("SELECT data FROM tavern_snapshot_owners WHERE id=?").get(id) as { data: string } | undefined;
    if (!row) return null;
    const owner = ownerSchema.parse(JSON.parse(row.data));
    if (owner.id !== id) throw new Error("Snapshot owner row does not match its private identity");
    return owner;
  }

  retain(snapshot: SourceSnapshot): SnapshotOwner {
    const id = snapshotOwnerId(snapshot);
    return this.db.transaction(() => {
      const existing = this.get(id);
      if (existing) {
        if (existing.phase !== "retained") throw new Error(`Snapshot owner is ${existing.phase}, not retained`);
        return existing;
      }
      const owner = ownerSchema.parse({ id, generation: 1, content: contentOf(snapshot),
        homeRef: "refs/tavern/snapshots/" + id, homeCommit: null, phase: "retained" });
      this.db.prepare("INSERT INTO tavern_snapshot_owners(id,data) VALUES(?,?)").run(id, JSON.stringify(owner));
      return owner;
    }).immediate();
  }

  forDescriptor(snapshot: SourceSnapshot): SnapshotOwner {
    if (!snapshot.ownerId) throw new Error("Legacy source snapshot has no shared owner");
    const owner = this.get(snapshot.ownerId);
    if (!owner || snapshotOwnerId(snapshot) !== owner.id || snapshotDescriptorId(snapshot) !== snapshot.id ||
        snapshot.homeRef !== owner.homeRef || !isDeepStrictEqual(contentOf(snapshot), owner.content))
      throw new Error("Source descriptor does not match its immutable snapshot owner");
    return owner;
  }

  assertReferenceable(record: PlacementRecord): void {
    if (record.phase === "released") return;
    for (const id of referenceIds(record)) {
      const row = this.db.prepare("SELECT data FROM tavern_source_snapshots WHERE id=?").get(id) as { data: string } | undefined;
      if (!row) continue;
      const snapshot = sourceSnapshotSchema.parse(JSON.parse(row.data));
      if (snapshot.ownerId && this.forDescriptor(snapshot).phase !== "retained")
        throw new Error("Cannot reference a snapshot owner that is no longer retained");
    }
  }

  references(id: string): string[] {
    if (!this.get(id)) throw new Error("Unknown snapshot owner");
    const rows = this.db.prepare(`SELECT p.data FROM tavern_placements p
      WHERE json_extract(p.data,'$.phase')<>'released' AND EXISTS (
        SELECT 1 FROM tavern_source_snapshots s WHERE json_extract(s.data,'$.ownerId')=? AND (
          s.id=json_extract(p.data,'$.sourceSnapshotId') OR s.id=json_extract(p.data,'$.submissionSnapshotId') OR
          s.id=json_extract(p.data,'$.reviewTarget.snapshotId') OR
          s.id=json_extract(p.data,'$.preservation.snapshotId') OR
          EXISTS (SELECT 1 FROM json_each(p.data,'$.transfers') t WHERE json_extract(t.value,'$.snapshotId')=s.id) OR
          EXISTS (SELECT 1 FROM json_each(p.data,'$.carries') c WHERE json_extract(c.value,'$.snapshotId')=s.id)
        )) ORDER BY p.id`).all(id) as { data: string }[];
    return rows.map(row => placementRecordSchema.parse(JSON.parse(row.data)).id);
  }

  beginRelease(id: string, generation: number): SnapshotOwner {
    return this.db.transaction(() => {
      const owner = this.get(id);
      if (!owner || owner.generation !== generation) throw new Error("Stale snapshot owner generation");
      if (this.references(id).length !== 0) throw new Error("Snapshot owner still has non-terminal placement references");
      if (owner.operationToken) throw new Error("Snapshot owner still has an active private operation");
      if (owner.phase !== "retained") return owner;
      return this.persist({ ...owner, phase: "releasing" });
    }).immediate();
  }

  claimOperation(id: string, generation: number, token: string): SnapshotOwner {
    return this.db.transaction(() => {
      const owner = this.get(id);
      if (!owner || owner.generation !== generation || owner.phase !== "retained") throw new Error("Stale snapshot owner generation or lifecycle");
      return this.persist({ ...owner, operationToken: token });
    }).immediate();
  }

  assertOperation(id: string, generation: number, token: string): SnapshotOwner {
    const owner = this.get(id);
    if (!owner || owner.generation !== generation || owner.phase !== "retained" || owner.operationToken !== token)
      throw new Error("Stale snapshot owner operation, generation or lifecycle");
    return owner;
  }

  finishOperation(id: string, generation: number, token: string): void {
    this.db.transaction(() => {
      const owner = this.get(id);
      if (owner?.generation === generation && owner.operationToken === token) this.persist({ ...owner, operationToken: null });
    }).immediate();
  }

  setHomeTransfer(id: string, generation: number, token: string, initial: NonNullable<SnapshotOwner["homeTransfer"]>): SourceTransferReceipt {
    return this.db.transaction(() => {
      const owner = this.assertOperation(id, generation, token), existing = owner.homeTransfer;
      if (existing) {
        for (const key of ["id", "generation", "snapshotId", "direction", "sourceEndpointId", "homeEndpointId", "verifyEndpointId", "sourceSdk", "homeSdk"] as const)
          if (!isDeepStrictEqual(existing.receipt[key], initial.receipt[key])) throw new Error("Immutable snapshot transfer endpoint identity changed");
        return existing.receipt;
      }
      return this.persist({ ...owner, homeTransfer: initial }).homeTransfer!.receipt;
    }).immediate();
  }

  updateHomeTransfer(
    id: string, generation: number, token: string,
    change: Partial<Pick<SourceTransferReceipt, "phase" | "manifest" | "uploads">>,
  ): SourceTransferReceipt {
    return this.db.transaction(() => {
      const owner = this.assertOperation(id, generation, token), transfer = owner.homeTransfer;
      if (!transfer) throw new Error("Snapshot owner has no home transfer receipt");
      const receipt = sourceTransferReceiptSchema.parse({ ...transfer.receipt, ...change });
      const phases = ["exporting", "uploading", "applying", "verified"];
      if (phases.indexOf(receipt.phase) < phases.indexOf(transfer.receipt.phase)) throw new Error("The home transfer phase cannot move backwards");
      if (transfer.receipt.manifest !== null && (!isDeepStrictEqual(receipt.manifest, transfer.receipt.manifest) ||
          !isDeepStrictEqual(receipt.uploads, transfer.receipt.uploads))) throw new Error("Immutable snapshot transfer manifest or uploads changed");
      return this.persist({ ...owner, homeTransfer: { ...transfer, receipt } }).homeTransfer!.receipt;
    }).immediate();
  }

  completeHomeTransfer(id: string, generation: number, token: string, homeCommit: string, tree: string, objectFormat: SourceSnapshot["objectFormat"]): void {
    this.db.transaction(() => {
      const owner = this.assertOperation(id, generation, token), transfer = owner.homeTransfer;
      if (!transfer || !["applying", "verified"].includes(transfer.receipt.phase)) throw new Error("Snapshot owner has no applying home transfer");
      if (owner.content.objectFormat !== objectFormat || owner.content.tree !== tree) throw new Error("Imported tree does not match the immutable snapshot owner");
      if (owner.homeCommit !== null && owner.homeCommit !== homeCommit) throw new Error("Immutable pinned home commit");
      this.persist({ ...owner, homeCommit, homeTransfer: { ...transfer, receipt: { ...transfer.receipt, phase: "verified", homeCommit } } });
    }).immediate();
  }

  pin(id: string, homeCommit: string, tree: string, objectFormat: SourceSnapshot["objectFormat"]): SnapshotOwner {
    return this.db.transaction(() => {
      const owner = this.get(id);
      if (!owner || owner.phase !== "retained") throw new Error("Snapshot owner is not retained");
      if (owner.content.objectFormat !== objectFormat) throw new Error("object-format-mismatch");
      if (owner.content.tree !== tree) throw new Error("Imported source tree does not match the immutable snapshot");
      if (owner.homeCommit !== null && owner.homeCommit !== homeCommit) throw new Error("Immutable pinned home commit");
      return this.persist({ ...owner, homeCommit });
    }).immediate();
  }

  private persist(owner: SnapshotOwner): SnapshotOwner {
    const parsed = ownerSchema.parse(owner);
    this.db.prepare("UPDATE tavern_snapshot_owners SET data=? WHERE id=?").run(JSON.stringify(parsed), parsed.id);
    return parsed;
  }
}
