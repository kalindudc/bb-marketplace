// Stored spec JSON is read as it was saved, by older versions of Loom too: a field the schema has since given a default
// may be missing, and a hook may have the shape of a key Loom no longer reads. Every reader gets the defaults, and the
// retired shapes are skipped instead of breaking a pass.
import { describe, expect, it } from "vitest";
import { settleChecks } from "../src/checks";
import { readSpec } from "../src/spec";
import { specOf } from "../src/ctx";
import { makeEngine, reachReview, seedProject, workerRows, type Doc, type EngineHarness } from "./helpers";

const stored = (h: EngineHarness & { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }, edit: (spec: Doc) => void) => {
  const project = h.store.projectBySlug("csv")!;
  const spec = JSON.parse(h.store.specVersion(project.id, project.approved_version!)!.spec_json) as Doc;
  edit(spec);
  h.db.prepare("UPDATE spec_versions SET spec_json = ? WHERE project_id = ? AND version = ?").run(JSON.stringify(spec), project.id, project.approved_version);
};

describe("a stored spec without a field the schema now defaults", () => {
  it("gets 180 minutes for a worker and 25 for a check, and keeps a stored value", () => {
    expect(readSpec(JSON.stringify({ agents: { worker: {}, reviewer: {} }, checks: { commands: [] } }))).toMatchObject({ agents: { ticket_timeout_minutes: 180 }, checks: { timeout_minutes: 25 } });
    expect(readSpec(JSON.stringify({ agents: { ticket_timeout_minutes: 120 }, checks: { timeout_minutes: 15 } }))).toMatchObject({ agents: { ticket_timeout_minutes: 120 }, checks: { timeout_minutes: 15 } });
  });

  it("does not end a worker that just started, and ends it after 180 minutes", async () => {
    const h = makeEngine();
    await seedProject(h);
    await h.engine.tick();
    stored(h, (spec) => delete spec.agents.ticket_timeout_minutes);
    await h.engine.tick();
    expect(workerRows(h, "CSV-1").map((row) => row.state)).toEqual(["active"]);
    h.clock.advance(179 * 60_000);
    await h.engine.tick();
    expect(workerRows(h, "CSV-1")[0]!.state).toBe("active");
    h.clock.advance(2 * 60_000);
    await h.engine.tick();
    expect(workerRows(h, "CSV-1")[0]!.end_reason).toBe("timeout");
  });

  it("runs each check with 25 minutes", async () => {
    const h = makeEngine();
    await seedProject(h);
    stored(h, (spec) => delete spec.checks.timeout_minutes);
    expect(specOf(h.store, h.store.projectBySlug("csv")!).checks.timeout_minutes).toBe(25);
    await reachReview(h);
    await settleChecks(h.ctx);
    const timeouts = h.host.callsTo("exec").map((call) => call.timeoutMs);
    expect(timeouts.length).toBeGreaterThan(0);
    expect(new Set(timeouts)).toEqual(new Set([25 * 60_000]));
  });
});
