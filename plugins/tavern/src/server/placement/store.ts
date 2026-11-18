import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  placementRecordSchema, sourceSnapshotSchema,
  type ObjectFormat, type PlacementRecord, type SourceSnapshot,
} from "../../shared/placement";
import type { Database } from "../ports";
import { SnapshotStore, snapshotDescriptorId } from "./snapshot-store";

const limitsSchema = z.object({
  maxMakers: z.number().int().min(1).max(1000),
  maxCheckers: z.number().int().min(1).max(1000),
}).strict();
const pageSize = z.number().int().min(1).max(1000);
const immutableKeys = [
  "id", "generation", "desiredState", "hireToken", "keeperThreadId", "projectId", "questId", "classId", "slot",
  "rule", "matchEvidence", "target", "allocationKey", "ownsNewMachine", "workspaceKind", "reviewTarget", "createdAt",
] as const;

export class StalePlacementError extends Error {
  constructor(message: string) { super(message); this.name = "StalePlacementError"; }
}

export class PlacementStore {
  readonly snapshotOwners: SnapshotStore;

  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {
    this.snapshotOwners = new SnapshotStore(db);
  }

  get(id: string): PlacementRecord | null {
    const row = this.db.prepare("SELECT data FROM tavern_placements WHERE id=?").get(id) as { data: string } | undefined;
    return row ? placementRecordSchema.parse(JSON.parse(row.data)) : null;
  }

  byHireToken(token: string): PlacementRecord | null {
    const row = this.db.prepare("SELECT data FROM tavern_placements WHERE json_extract(data,'$.hireToken')=?").get(token) as { data: string } | undefined;
    return row ? placementRecordSchema.parse(JSON.parse(row.data)) : null;
  }

  byMember(threadId: string): PlacementRecord | null {
    const rows = this.db.prepare("SELECT data FROM tavern_placements WHERE json_extract(data,'$.memberThreadId')=?")
      .all(threadId) as Array<{ data: string }>;
    if (rows.length > 1) throw new Error("Member has multiple private placement assignments");
    return rows.length === 0 ? null : placementRecordSchema.parse(JSON.parse(rows[0]!.data));
  }

  counts(keeperThreadId: string): { makers: number; checkers: number } {
    const rows = this.db.prepare(`SELECT json_extract(data,'$.slot') AS slot, count(*) AS count
      FROM tavern_placements WHERE json_extract(data,'$.keeperThreadId')=?
      AND json_extract(data,'$.rule') IS NOT NULL AND json_extract(data,'$.phase')<>'released'
      GROUP BY json_extract(data,'$.slot')`).all(keeperThreadId) as Array<{ slot: string; count: number }>;
    const counts = { makers: 0, checkers: 0 };
    for (const row of rows) {
      if (row.slot === "maker") counts.makers = row.count;
      else if (row.slot === "checker") counts.checkers = row.count;
      else throw new Error("Corrupt placement slot in reservation counts");
    }
    return counts;
  }

  activePage(afterId: string | null, limit: number): PlacementRecord[] {
    pageSize.parse(limit);
    const rows = this.db.prepare(`SELECT data FROM tavern_placements
      WHERE json_extract(data,'$.phase')<>'released' AND id>? ORDER BY id LIMIT ?`)
      .all(afterId ?? "", limit) as Array<{ data: string }>;
    return rows.map(row => placementRecordSchema.parse(JSON.parse(row.data)));
  }

  reserve(input: PlacementRecord, limits: { maxMakers: number; maxCheckers: number }): PlacementRecord {
    const record = placementRecordSchema.parse(input);
    limitsSchema.parse(limits);
    return this.db.transaction(() => {
      const existing = this.byHireToken(record.hireToken);
      if (existing) {
        for (const key of immutableKeys) {
          if (["id", "generation", "desiredState", "createdAt"].includes(key)) continue;
          if (!isDeepStrictEqual(existing[key], record[key])) throw new Error(`Hire token belongs to a different placement: ${key}`);
        }
        return existing;
      }
      if (record.generation !== 1 || record.phase !== "reserved" || record.desiredState !== "running") {
        throw new Error("A new reservation must start at running generation 1 in the reserved phase");
      }
      if (record.rule !== null) {
        const counts = this.counts(record.keeperThreadId);
        const current = record.slot === "maker" ? counts.makers : counts.checkers;
        const maximum = record.slot === "maker" ? limits.maxMakers : limits.maxCheckers;
        if (current >= maximum) throw new Error(`Machine ${record.slot} capacity is ${current}/${maximum}; wait for a reservation to be released.`);
      }
      new SnapshotStore(this.db).assertReferenceable(record);
      this.db.prepare("INSERT INTO tavern_placements(id,data) VALUES(?,?)").run(record.id, JSON.stringify(record));
      return record;
    }).immediate();
  }

  assertCurrent(id: string, generation: number, desiredState: PlacementRecord["desiredState"] = "running"): PlacementRecord {
    const record = this.get(id);
    if (!record || record.generation !== generation) throw new StalePlacementError(`Stale placement generation: ${id} at ${generation}`);
    if (record.desiredState !== desiredState) throw new StalePlacementError(`Placement desired state is ${record.desiredState}, not ${desiredState}`);
    return record;
  }

  private persist(record: PlacementRecord): PlacementRecord {
    const parsed = placementRecordSchema.parse(record);
    this.db.prepare("UPDATE tavern_placements SET data=? WHERE id=?").run(JSON.stringify(parsed), parsed.id);
    return parsed;
  }

  update(
    id: string, generation: number, change: (current: PlacementRecord) => PlacementRecord,
    desiredState: PlacementRecord["desiredState"] = "running",
  ): PlacementRecord {
    return this.db.transaction(() => {
      const current = this.assertCurrent(id, generation, desiredState);
      const next = change(structuredClone(current));
      for (const key of immutableKeys) {
        if (!isDeepStrictEqual(current[key], next[key])) throw new Error(`Immutable placement field: ${key}`);
      }
      if (current.memberThreadId !== null && next.memberThreadId !== current.memberThreadId) {
        throw new Error("Immutable member binding: create a new placement for another member");
      }
      if (next.memberThreadId !== null) {
        const assignment = this.byMember(next.memberThreadId);
        if (assignment !== null && assignment.id !== id) throw new Error("Member already belongs to another private placement assignment");
      }
      if (next.phase === "released") throw new Error("Use finishRelease after preservation and resource reconciliation");
      new SnapshotStore(this.db).assertReferenceable(next);
      return this.persist({ ...next, updatedAt: this.now() });
    }).immediate();
  }

  block(
    id: string, generation: number, blocked: NonNullable<PlacementRecord["blocked"]>,
    desiredState: PlacementRecord["desiredState"] = "running",
  ): PlacementRecord {
    return this.update(id, generation, current => {
      if (current.phase === "released") throw new Error("A released placement cannot be blocked");
      return {
        ...current, phase: "blocked", blocked,
        resumePhase: current.phase === "blocked" ? current.resumePhase : current.phase,
      };
    }, desiredState);
  }

  retry(id: string, generation: number, desiredState: PlacementRecord["desiredState"] = "running"): PlacementRecord {
    return this.update(id, generation, current => {
      if (!current.blocked?.retryable || current.resumePhase === null) throw new Error("This placement has no retryable blocked phase");
      return { ...current, phase: current.resumePhase, blocked: null, resumePhase: null };
    }, desiredState);
  }

  cancel(id: string, generation: number): PlacementRecord {
    return this.db.transaction(() => {
      const current = this.get(id);
      if (current?.desiredState === "released" && (current.generation === generation || current.generation === generation + 1)) return current;
      const record = this.assertCurrent(id, generation);
      return this.persist({
        ...record, generation: record.generation + 1, desiredState: "released",
        phase: record.memberThreadId === null ? "releasing" : "preserving", blocked: null, resumePhase: null,
        preservation: {
          ...record.preservation,
          source: record.memberThreadId === null || ["lost", "unknown", "unpreserved"].includes(record.preservation.source) ||
            record.preservation.source === "saved" && record.preservation.artifacts === "unknown" && record.preservation.liveOwnerThreadId === null ? record.preservation.source : "pending",
        },
        acknowledgedScopeRevision: null, updatedAt: this.now(),
      });
    }).immediate();
  }

  finishRelease(id: string, generation: number, resourcesReconciled: boolean): PlacementRecord {
    return this.db.transaction(() => {
      const record = this.assertCurrent(id, generation, "released");
      if (record.phase === "released") return record;
      if (!resourcesReconciled) throw new Error("Reconcile possible children and machine resources before release");
      const preserved = ["not-needed", "saved"].includes(record.preservation.source) &&
        (["not-declared", "saved"].includes(record.preservation.artifacts) ||
          record.preservation.artifacts === "unpreserved" && record.preservation.artifactManifestId !== null);
      const lost = (["lost", "unknown"].includes(record.preservation.source) || record.preservation.source === "saved" && record.preservation.artifacts === "unknown") && record.phase === "releasing" &&
        record.preservation.liveOwnerThreadId === null && record.preservation.reason !== null;
      if ((!preserved && !lost) || !record.preservation.stopConfirmed) throw new Error("Preservation or reconciled loss and a confirmed stop are required before release");
      return this.persist({
        ...record, phase: "released", blocked: null, resumePhase: null,
        preservation: { ...record.preservation, liveOwnerThreadId: null }, updatedAt: this.now(),
      });
    }).immediate();
  }

  snapshot(id: string): SourceSnapshot | null {
    const row = this.db.prepare("SELECT data FROM tavern_source_snapshots WHERE id=?").get(id) as { data: string } | undefined;
    if (!row) return null;
    const snapshot = sourceSnapshotSchema.parse(JSON.parse(row.data));
    if (!snapshot.ownerId) return snapshot;
    const owner = new SnapshotStore(this.db).forDescriptor(snapshot);
    return sourceSnapshotSchema.parse({ ...snapshot, homeCommit: owner.homeCommit });
  }

  captureSnapshot(input: Omit<SourceSnapshot, "id" | "ownerId" | "homeRef" | "homeCommit" | "createdAt">): SourceSnapshot {
    return this.db.transaction(() => {
      const draft = sourceSnapshotSchema.parse({ ...input, id: "pending", homeRef: "refs/tavern/pending", homeCommit: null, createdAt: this.now() });
      const owner = new SnapshotStore(this.db).retain(draft);
      const id = snapshotDescriptorId(draft), existing = this.snapshot(id);
      if (existing) for (const key of ["modifiedPaths", "untrackedPaths"] as const) {
        if (existing[key] === undefined) delete draft[key];
        else draft[key] = existing[key];
      }
      return this.saveSnapshot({ ...draft, id, ownerId: owner.id, homeRef: owner.homeRef, createdAt: existing?.createdAt ?? draft.createdAt });
    }).immediate();
  }

  saveSnapshot(input: SourceSnapshot): SourceSnapshot {
    const snapshot = sourceSnapshotSchema.parse(input);
    if (snapshot.homeCommit !== null) throw new Error("Use pinSnapshot after verifying the imported tree");
    return this.db.transaction(() => {
      if (snapshot.ownerId) {
        const owner = new SnapshotStore(this.db).forDescriptor(snapshot);
        if (owner.phase !== "retained") throw new Error("Snapshot owner is not retained");
      }
      const existing = this.snapshot(snapshot.id);
      if (existing) {
        if (!isDeepStrictEqual({ ...existing, homeCommit: null }, snapshot)) throw new Error("Immutable source snapshot identity");
        return existing;
      }
      this.db.prepare("INSERT INTO tavern_source_snapshots(id,data) VALUES(?,?)").run(snapshot.id, JSON.stringify(snapshot));
      return snapshot;
    }).immediate();
  }

  completeHomeTransfer(
    id: string, generation: number, transferId: string,
    homeCommit: string, observedTree: string, objectFormat: ObjectFormat, desiredState: PlacementRecord["desiredState"] = "running",
  ): SourceSnapshot {
    return this.db.transaction(() => {
      const record = this.assertCurrent(id, generation, desiredState);
      const receipt = record.transfers?.find(transfer => transfer.id === transferId);
      if (!receipt || receipt.generation !== generation || !["applying", "verified"].includes(receipt.phase))
        throw new Error("The home transfer has no current applying receipt");
      if (receipt.homeCommit !== null && receipt.homeCommit !== homeCommit) throw new Error("Immutable verified home commit");
      const snapshot = this.pinSnapshot(receipt.snapshotId, homeCommit, observedTree, objectFormat);
      this.update(id, generation, current => ({
        ...current, transfers: current.transfers!.map(transfer => transfer.id === transferId
          ? { ...transfer, phase: "verified", homeCommit } : transfer),
      }), desiredState);
      return snapshot;
    }).immediate();
  }

  completeCarry(id: string, generation: number, receiptId: string, head: string, tree: string, objectFormat: ObjectFormat) {
    return this.db.transaction(() => {
      const record = this.assertCurrent(id, generation), receipt = record.carries?.find(item => item.id === receiptId);
      if (!receipt || receipt.generation !== generation || !["carrying", "verified"].includes(receipt.phase))
        throw new Error("The carry has no current applying receipt");
      const snapshot = this.snapshot(receipt.snapshotId);
      if (!snapshot?.homeCommit || snapshot.objectFormat !== objectFormat || snapshot.tree !== tree || head.length !== tree.length)
        throw new Error("The carried content does not match the pinned home snapshot");
      if (receipt.head !== null && receipt.head !== head) throw new Error("Immutable verified carry commit");
      const updated = this.update(id, generation, value => ({ ...value,
        carries: value.carries!.map(item => item.id === receiptId ? { ...item, phase: "verified", head } : item),
      }));
      return updated.carries!.find(item => item.id === receiptId)!;
    }).immediate();
  }

  pinSnapshot(id: string, homeCommit: string, observedTree: string, objectFormat: ObjectFormat): SourceSnapshot {
    return this.db.transaction(() => {
      const snapshot = this.snapshot(id);
      if (!snapshot) throw new Error("Unknown source snapshot");
      if (snapshot.objectFormat !== objectFormat) throw new Error("object-format-mismatch");
      if (snapshot.tree !== observedTree) throw new Error("Imported source tree does not match the immutable snapshot");
      if (snapshot.homeCommit !== null && snapshot.homeCommit !== homeCommit) throw new Error("Immutable pinned home commit");
      if (snapshot.ownerId) {
        new SnapshotStore(this.db).pin(snapshot.ownerId, homeCommit, observedTree, objectFormat);
        return this.snapshot(id)!;
      }
      const pinned = sourceSnapshotSchema.parse({ ...snapshot, homeCommit });
      this.db.prepare("UPDATE tavern_source_snapshots SET data=? WHERE id=?").run(JSON.stringify(pinned), id);
      return pinned;
    }).immediate();
  }
}
