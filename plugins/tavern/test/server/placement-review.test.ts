// @vitest-environment node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reviewFixture, reviewGit, proveCarryStage, proveWardenStage, proveCheckStage } from "./placement-e2e-review";

const fixtures: Awaited<ReturnType<typeof reviewFixture>>[] = [];
async function fixture() { const f = await reviewFixture(); fixtures.push(f); return f; }
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });

describe("independently placed Warden reviews", () => {
  it("brings home and carries the maker's exact unpushed and uncommitted tree", proveCarryStage, 60_000);
  it("uses its own rule, checker slot, machine and carried root", proveWardenStage, 60_000);
  it("runs the project check on the checker host and accepts the clean pinned tree", proveCheckStage, 60_000);
  it("waits for a busy maker without allocating or interrupting it", async () => {
    const f = await fixture(); await f.make(); f.threads.set("maker", { ...f.threads.get("maker")!, status: "active" });
    await expect(f.hire("warden")).rejects.toThrow(/Waiting for .* to finish its turn before its work can be checked/);
    expect(f.spawn).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled();
    expect(f.keeper.store.events("keeper", 0, 100).some(event => event.type === "hire.waiting")).toBe(true);
  }, 60_000);
  it("requires a separate Warden rule rather than inheriting the Smith's rule", async () => {
    const f = await fixture(); await f.make(); f.settings.update({ revision: 1, patch: { machines: { rules: [f.rules[0]] } }, why: "No checker rule" });
    await expect(f.hire("warden")).rejects.toThrow(/Add .*Warden.*rule.*Settings/);
    expect(f.spawn).toHaveBeenCalledTimes(1);
  }, 60_000);
  it.each(["dirty", "tree", "entry", "submission", "waypoint", "inactive-waypoint", "assignment", "maker-generation", "maker-released", "generation", "endpoint"] as const)("refuses a stale %s before writing a verdict", async stale => {
    const f = await fixture(), id = await f.make(); await f.check(); const placements = f.runtime.placements().store, checker = placements.byMember("checker")!;
    if (stale === "dirty") writeFileSync(join(checker.root!, "tracked"), "changed\n");
    if (stale === "tree") { writeFileSync(join(checker.root!, "tracked"), "changed\n"); reviewGit(checker.root!, "add", "-A"); reviewGit(checker.root!, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "changed tree"); }
    if (stale === "entry") f.journal.edit("maker", { op: "update", entryId: id, description: "Different work" }, { kind: "user" });
    if (stale === "submission") {
      writeFileSync(join(f.environments.get("maker-env")!.path!, "tracked"), "A newer submission\n");
      await f.runtime.placements().submissions.capture("maker", "w1");
    }
    if (stale === "waypoint") { const plan = f.keeper.summary(f.quest.id).plan!; f.keeper.store.put("plans", `${f.quest.id}:${plan.version}`, { ...plan, waypoints: plan.waypoints.map(waypoint => ({ ...waypoint, title: "Changed waypoint" })) }); }
    if (stale === "inactive-waypoint") f.keeper.store.put("quests", f.quest.id, { ...f.keeper.quest(f.quest.id), phase: "stopped" });
    if (stale === "assignment") f.keeper.store.put("members", "checker", { ...f.keeper.member("checker")!, checkerMakerThreadId: "other-maker" });
    if (stale === "maker-generation") f.intercept(method => { if (method === "worktreeState") { const maker=placements.byMember("maker")!; placements.cancel(maker.id,maker.generation); } });
    if (stale === "maker-released") { const maker=placements.byMember("maker")!; placements.cancel(maker.id,maker.generation); }
    if (stale === "generation") placements.cancel(checker.id, checker.generation);
    if (stale === "endpoint") f.environments.set("checker-env", { ...f.environments.get("checker-env")!, hostId: "maker" });
    const result = await f.tool("checker", "journal", { action: "verify", threadId: "maker", id, evidence: [{ kind: "command", ref: "node --test check.test.cjs", detail: "Claimed pass", exitCode: 0 }] });
    expect(result).toMatchObject({ isError: true }); expect(f.journal.get("maker").entries.find(entry => entry.id === id)!.status).toBe("done");
    if (["submission", "entry", "waypoint", "assignment", "maker-generation", "maker-released"].includes(stale)) {
      const instruction = "Hire a new Warden for this waypoint; this Warden's pinned tree is out of date";
      expect(JSON.stringify(result)).toContain(instruction);
      expect(f.keeper.store.events("keeper", 0, 100).some(event => event.type === "review.superseded" && event.text.includes(instruction))).toBe(true);
    }
    if (stale === "inactive-waypoint") {
      expect(JSON.stringify(result)).toContain("no verdict is needed");
      expect(f.keeper.store.events("keeper",0,100).some(event=>event.type==="review.superseded")).toBe(false);
    }
  }, 60_000);
  it("also fences rejects and rechecks assignment after the asynchronous host call", async () => {
    const f = await fixture(), id = await f.make(); await f.check();
    f.intercept(method => { if (method === "worktreeState") f.keeper.store.put("members", "checker", { ...f.keeper.member("checker")!, checkerMakerThreadId: "other" }); });
    expect(await f.tool("checker", "journal", { action: "reject", threadId: "maker", id, reason: "Not accepted" })).toMatchObject({ isError: true });
    expect(f.journal.get("maker").entries.find(entry => entry.id === id)!.status).toBe("done");
  }, 60_000);
});
