import { describe, expect, it } from "vitest";
import { DiagnosticRing } from "../src/diagnostics.ts";
import { operationSchemas } from "../src/operations.ts";

describe("shared operation boundaries", () => {
 it("rejects unknown selectors on every schema", () => {
  for (const schema of Object.values(operationSchemas)) expect(schema.safeParse({ unknownSelector: "cloud" }).success).toBe(false);
 });
 it("bounds diagnostics and expires records without retaining arbitrary input", () => {
  let now = 0;
  const ring = new DiagnosticRing(() => now);
  for (let i = 0; i < 205; i++) ring.record({ operation: "fetch", status: "success", durationMs: 1, counts: { items: 1 }, stageMs: { acquisition: 1 }, cache: { hit: 1 } });
  expect(ring.snapshot()).toHaveLength(200);
  expect(JSON.stringify(ring.snapshot())).not.toMatch(/https:|query|credential/);
  now = 86_400_001;
  expect(ring.snapshot()).toEqual([]);
 });
});
