import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { endpointSchema } from "../../shared/placement";
import type { Database } from "../ports";

const id = z.string().min(1).max(200);
// At the ceiling, invalidation is terminal; renewing a binding must still advance.
const maxGeneration = Number.MAX_SAFE_INTEGER;
const generation = z.number().int().min(1).max(maxGeneration);
const epoch = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sourceEndpointSchema = endpointSchema.extend({ environmentId: id });
const bodySchema = z.object({
  authorityId: id,
  endpoint: sourceEndpointSchema,
  canonicalRoot: endpointSchema.shape.root.nullable(),
  state: z.enum(["current", "invalidated"]),
}).strict();
const recordSchema = bodySchema.extend({ keeperThreadId: id, generation, updatedAt: epoch });
const rowSchema = z.object({
  keeper_thread_id: id, generation, record_json: z.string(), updated_at: epoch,
}).strict();
export type DiscoveryBinding = z.infer<typeof recordSchema>;
type SourceEndpoint = z.infer<typeof sourceEndpointSchema>;

export class StaleDiscoveryError extends Error {
  constructor(message: string) { super(message); this.name = "StaleDiscoveryError"; }
}

export class DiscoveryStore {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {}

  get(keeperThreadId: string): DiscoveryBinding | null {
    id.parse(keeperThreadId);
    const found = this.db.prepare(
      "SELECT keeper_thread_id,generation,record_json,updated_at FROM tavern_placement_discoveries WHERE keeper_thread_id=?",
    ).get(keeperThreadId);
    if (found === undefined || found === null) return null;
    const row = rowSchema.parse(found);
    const body = bodySchema.parse(JSON.parse(row.record_json));
    return { ...body, keeperThreadId: row.keeper_thread_id, generation: row.generation, updatedAt: row.updated_at };
  }

  private persist(input: DiscoveryBinding): DiscoveryBinding {
    const record = recordSchema.parse(input);
    const body = bodySchema.parse({ authorityId: record.authorityId, endpoint: record.endpoint, canonicalRoot: record.canonicalRoot, state: record.state });
    this.db.prepare(`INSERT INTO tavern_placement_discoveries(keeper_thread_id,generation,record_json,updated_at)
      VALUES(?,?,?,?) ON CONFLICT(keeper_thread_id) DO UPDATE
      SET generation=excluded.generation,record_json=excluded.record_json,updated_at=excluded.updated_at`)
      .run(record.keeperThreadId, record.generation, JSON.stringify(body), record.updatedAt);
    return record;
  }

  bind(keeperThreadId: string, endpoint: SourceEndpoint): DiscoveryBinding {
    id.parse(keeperThreadId);
    const checked = sourceEndpointSchema.parse(endpoint);
    return this.db.transaction(() => {
      const current = this.get(keeperThreadId);
      const unchanged = current !== null && isDeepStrictEqual(current.endpoint, checked);
      if (unchanged && current.state === "current") return current;
      return this.persist({
        keeperThreadId,
        authorityId: current === null ? `discovery_${randomUUID()}` : current.authorityId,
        generation: current === null ? 1 : current.generation + 1,
        state: "current",
        endpoint: checked,
        canonicalRoot: unchanged ? current.canonicalRoot : null,
        updatedAt: this.now(),
      });
    }).immediate();
  }

  assertCurrent(keeperThreadId: string, expected: number): DiscoveryBinding {
    generation.parse(expected);
    const current = this.get(keeperThreadId);
    if (current === null || current.generation !== expected)
      throw new StaleDiscoveryError("Stale source discovery generation.");
    if (current.state !== "current")
      throw new StaleDiscoveryError("Source discovery binding was invalidated.");
    return current;
  }

  pin(keeperThreadId: string, expected: number, canonicalRoot: string): DiscoveryBinding {
    endpointSchema.shape.root.parse(canonicalRoot);
    const result = this.db.transaction(() => {
      const current = this.assertCurrent(keeperThreadId, expected);
      if (current.canonicalRoot !== null && current.canonicalRoot !== canonicalRoot) {
        return { changed: true, record: this.persist({
          ...current, generation: Math.min(current.generation + 1, maxGeneration), state: "invalidated", updatedAt: this.now(),
        }) };
      }
      return { changed: false, record: current.canonicalRoot === canonicalRoot ? current : this.persist({
        ...current, canonicalRoot, updatedAt: this.now(),
      }) };
    }).immediate();
    if (result.changed) throw new StaleDiscoveryError("Canonical source root changed behind the current SDK binding.");
    return result.record;
  }

  invalidate(keeperThreadId: string, expected?: number): DiscoveryBinding | null {
    if (expected !== undefined) generation.parse(expected);
    return this.db.transaction(() => {
      const current = this.get(keeperThreadId);
      if (current === null || current.state === "invalidated" ||
          expected !== undefined && current.generation !== expected) return current;
      return this.persist({
        ...current, generation: Math.min(current.generation + 1, maxGeneration), state: "invalidated", updatedAt: this.now(),
      });
    }).immediate();
  }

  invalidateHost(hostId: string): number {
    id.parse(hostId);
    return this.db.prepare(`UPDATE tavern_placement_discoveries
      SET generation=CASE WHEN generation<${maxGeneration} THEN generation+1 ELSE generation END,
      record_json=json_set(record_json,'$.state','invalidated'),updated_at=?
      WHERE json_extract(record_json,'$.endpoint.hostId')=? AND json_extract(record_json,'$.state')='current'`)
      .run(epoch.parse(this.now()), hostId).changes;
  }
}
