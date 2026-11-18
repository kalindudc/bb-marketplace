// @vitest-environment node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reviewFixture } from "./placement-e2e-review";
import { journalEntryFingerprint } from "../../src/server/placement/submission";
import { waypointEntry } from "./support";
import { applyAction } from "../../src/server/journal/engine";
import { placementRecord } from "./placement-fixture";

const fixtures: Awaited<ReturnType<typeof reviewFixture>>[] = [];
async function fixture(checkers = 1) { const f = await reviewFixture(checkers); fixtures.push(f); return f; }
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
const evidence = [{ kind: "command" as const, ref: "node --test check.test.cjs", detail: "Passed", exitCode: 0 }];
const verdict = (f: Awaited<ReturnType<typeof reviewFixture>>, id: string, threadId = "checker") => f.tool(threadId, "journal", { action: "verify", threadId: "maker", id, evidence });

describe("Review B submission fixes", () => {
  it.each(["verify", "reject"] as const)("allows a sibling verify after %s with a reason", async action => {
    const f = await fixture(), id = await f.make();
    const entry = f.journal.get("maker").entries.find(entry => entry.id === id)!;
    const sibling = "fe";
    f.keeper.store.db.prepare("INSERT INTO questlog_entries(thread_id,id,board_quest_id,data) VALUES(?,?,?,?)").run("maker", sibling, entry.boardQuestId,
      JSON.stringify({ ...entry, id: sibling, description: "Sibling work", order: entry.order + 1 }));
    await f.check();
    expect(await f.tool("checker", "journal", { action, threadId: "maker", id, reason: "Checked the first entry", evidence })).not.toMatchObject({ isError: true });
    const result = await verdict(f, sibling);
    expect(result, JSON.stringify(result)).not.toMatchObject({ isError: true });
    expect(f.journal.get("maker").entries.find(entry => entry.id === sibling)!.status).toBe("verified");
  }, 60_000);
  it("keeps an unchanged capture's snapshot, submission and review identities without importing again", async () => {
    const f = await fixture(); await f.make(); const submissions = f.runtime.placements().submissions;
    const first = await submissions.capture("maker", "w1"), calls = f.harness.experimental_hostRpcCalls.length;
    expect(await submissions.capture("maker", "w1")).toEqual(first);
    expect(f.harness.experimental_hostRpcCalls.slice(calls).map(call => call.method)).not.toContain("importCommit");
    writeFileSync(join(f.environments.get("maker-env")!.path!, "tracked"), "changed submission\n");
    const changed = await submissions.capture("maker", "w1"); expect(changed).not.toEqual(first);
  }, 60_000);
  it("retains submission identities across checker-slot re-hire attempts", async () => {
    const f = await fixture(); await f.make();
    f.settings.update({ revision: 1, patch: { machines: { maxCheckers: 1 } }, why: "One checker machine" });
    f.runtime.placements().store.reserve(placementRecord({ id: "another-review", hireToken: "another-hire", allocationKey: "another-allocation", classId: "warden", slot: "checker", questId: null }), { maxMakers: 2, maxCheckers: 1 });
    await expect(f.hire("warden")).rejects.toThrow("Waiting for a checker slot: 1 of 1 in use");
    const captured = f.keeper.store.runtime("maker").submissionTarget;
    expect(captured?.snapshotId).toBeTruthy();
    await expect(f.hire("warden")).rejects.toThrow("Waiting for a checker slot: 1 of 1 in use");
    expect(f.keeper.store.runtime("maker").submissionTarget).toEqual(captured);
    expect(f.spawn).toHaveBeenCalledTimes(1);
  }, 60_000);
  it("refuses a second Warden on the same waypoint exactly as main without invalidating the first review", async () => {
    const f = await fixture(2), id = await f.make(); await f.check();
    const captured = f.keeper.store.runtime("maker").submissionTarget;
    await expect(f.hire("warden")).rejects.toThrow(/^This waypoint already has a live member of that class$/);
    expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(f.keeper.store.runtime("maker").submissionTarget).toEqual(captured);
    expect(await verdict(f, id)).not.toMatchObject({ isError: true });
  }, 60_000);
  it("refuses the next verdict after the Warden rejects the submitted entry", async () => {
    const f = await fixture(), id = await f.make(); await f.check();
    expect(await f.tool("checker", "journal", { action: "reject", threadId: "maker", id, reason: "Needs changes" })).not.toMatchObject({ isError: true });
    const result = await verdict(f, id);
    expect(result).toMatchObject({ isError: true }); expect(JSON.stringify(result)).toContain("Only reported done entries can be verified.");
  }, 60_000);
  it("captures a failed maker turn once it is quiescent", async () => {
    const f = await fixture(); await f.make(); f.threads.set("maker", { ...f.threads.get("maker")!, status: "error" });
    expect(await f.runtime.placements().submissions.capture("maker", "w1")).toMatchObject({ state: "captured" }); expect(f.stop).not.toHaveBeenCalled();
  }, 60_000);
  it("normalizes verdict-owned fields but still fingerprints maker work and maker-set status", () => {
    const makerContext = { threadId: "maker", actor: { kind: "agent" as const, threadId: "maker" }, now: 1_000_000, allocate: () => "a2", roleOf: () => null };
    const todo = { ...waypointEntry("maker", "quest"), status: "todo" as const };
    const done = applyAction([todo], { action: "done", id: todo.id }, makerContext).entries;
    const entry = applyAction(done, { action: "update", id: todo.id, description: "Reworded maker work" }, makerContext).entries[0];
    expect(entry.rewrites).toBeGreaterThan(0);
    const before = journalEntryFingerprint(entry);
    const verified = applyAction([entry], { action: "verify", id: entry.id, evidence, reason: "Checked" }, { threadId: "maker", actor: { kind: "agent", threadId: "checker" }, now: 2_000_000, allocate: () => "a2",
      roleOf: () => ({ classId: "warden", role: "member", boardQuestId: "quest", waypointId: "w1" }) }).entries[0];
    expect(journalEntryFingerprint(verified)).toBe(before);
    for (const patch of [{ description: "New work" }, { status: "doing" as const }, { parentId: "a2" }, { evidence: [...entry.evidence, { kind: "note" as const, ref: "new evidence", detail: "", exitCode: null }] }])
      expect(journalEntryFingerprint({ ...entry, ...patch })).not.toBe(before);
    const rejected = applyAction([entry], { action: "reject", id: entry.id, reason: "Needs changes" }, { threadId: "maker", actor: { kind: "agent", threadId: "checker" }, now: 2_000_000, allocate: () => "a2",
      roleOf: () => ({ classId: "warden", role: "member", boardQuestId: "quest", waypointId: "w1" }) }).entries[0];
    expect(journalEntryFingerprint(rejected)).toBe(before);
    for (const patch of [{ status: "rejected" as const }, { note: "Maker note" }, { evidence: [...entry.evidence, { kind: "note" as const, ref: "fix evidence", detail: "", exitCode: null }] }])
      expect(journalEntryFingerprint({ ...verified, ...patch, updatedBy: makerContext.actor })).not.toBe(before);
  });
});

describe("Review B verdict fixes", () => {
  it.each(["caller", "readiness", "identity", "dirty"] as const)("refuses %s without superseding the review", async refusal => {
    const f = await fixture(), id = await f.make(); await f.check();
    const store = f.runtime.placements().store, checker = store.byMember("checker")!;
    if (refusal === "readiness") store.update(checker.id, checker.generation, value => ({ ...value, acknowledgedScopeRevision: null }));
    if (refusal === "identity") f.environments.set("checker-env", { ...f.environments.get("checker-env")!, hostId: "maker" });
    if (refusal === "dirty") writeFileSync(join(checker.root!, "tracked"), "changed\n");
    const result = await verdict(f, refusal === "caller" ? "ff" : id);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).not.toContain("Hire a new Warden");
    expect(f.keeper.store.events("keeper", 0, 100).some(event => event.type === "review.superseded")).toBe(false);
    expect(f.journal.get("maker").entries.find(entry => entry.id === id)!.status).toBe("done");
    if (refusal === "dirty") {
      expect(JSON.stringify(result)).toContain("Restore your checkout to the pinned tree, then verify again.");
      writeFileSync(join(checker.root!, "tracked"), "submitted\n");
      expect(await verdict(f, id)).not.toMatchObject({ isError: true });
    }
  }, 60_000);
  it("permits and names untracked check output but refuses tracked changes with their paths", async () => {
    const f = await fixture(), id = await f.make(); await f.check(); const root = f.environments.get("checker-env")!.path!;
    writeFileSync(join(root, "check-output.txt"), "check output\n");
    const accepted = await verdict(f, id); expect(accepted).not.toMatchObject({ isError: true }); expect(JSON.stringify(accepted)).toContain("check-output.txt");
    writeFileSync(join(root, "tracked"), "modified\n");
    const refused = await verdict(f, id); expect(refused).toMatchObject({ isError: true }); expect(JSON.stringify(refused)).toContain("tracked");
  }, 60_000);
  it("does not hold the maker journal lock during host preflight and fences edits made meanwhile", async () => {
    const f = await fixture(), id = await f.make(); await f.check();
    let entered!: () => void, resume!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { resume = resolve; });
    f.intercept(async method => { if (method === "worktreeState") { entered(); await blocked; } });
    const checking = verdict(f, id); await started;
    const editing = f.tool("maker", "journal", { action: "update", id, description: "Changed during the host check" });
    let timeout: ReturnType<typeof setTimeout> | undefined, completed: boolean;
    try {
      completed = await Promise.race([editing.then(() => true), new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 750); })]);
    } finally { clearTimeout(timeout); resume(); }
    await editing; const refused = await checking; expect(completed).toBe(true); expect(refused).toMatchObject({ isError: true });
    expect(JSON.stringify(refused)).toContain("Hire a new Warden");
    expect(f.journal.get("maker").entries.find(entry => entry.id === id)!.status).toBe("done");
  }, 60_000);
});
