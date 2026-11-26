// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keeper } from "../../src/server/keeper/service";
import { KeeperStore } from "../../src/server/keeper/store";
import { registerJournal } from "../../src/server/journal";
import { registerRpc } from "../../src/server/rpc";
import { setup } from "./runtime-fixture";
import { planInput, seedQuest } from "./support";

const proof = [{ kind: "note" as const, ref: "Observed result", detail: "Matches the requested result", exitCode: null }];
const brief = { outcome: "Build", mode: "make-it-work" as const, outOfScope: "Publishing", doneWhen: "Tests pass", context: [], questions: [], timeboxMinutes: null };
const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

async function fixture(legacy = false) {
  const f = setup();
  databases.push(f.k.store.db);
  f.bb.sdk.threads.getPluginMetadata = async () => ({});
  f.bb.sdk.threads.stop = async () => ({ ok: true });
  const journal = registerJournal(f.bb, f.k.store.db, {
    roleOf: id => f.runtime.journalRole(id), invalidate: () => {},
    keeperWaypointCall: (id, input) => f.k.journalWaypointCall(id, input),
    keepsLinkedWork: entry => f.k.keepsLinkedWork(entry),
  });
  Object.assign(f.port, journal);
  registerRpc(f.bb, f.runtime);
  const q = await seedQuest(f.k, "lead", "Build the journal", "Build");
  if (legacy) f.k.store.put("quests", q.id, { ...q, waypointJournal: undefined });
  const plan = planInput(q.id);
  const base = { ...plan.waypoints[0]!, owner: null };
  f.k.plan("lead", { ...plan, waypoints: [
    { ...base, check: "warden" },
    { ...base, id: "w2", check: "keeper" },
    { ...base, id: "w3", check: "none" },
    { ...base, id: "w4", actor: "outside", owner: "Outside team", check: "keeper" },
    { ...base, id: "w5", actor: "user", check: "you" },
    { ...base, id: "w6", check: "none", optional: true },
    { ...base, id: "w7", check: "keeper" },
  ] });
  f.k.answerAsk(f.k.store.openAsks("lead", q.id)[0]!.id, "approve", null, "page", "user");
  const bind = (id: string, classId: string, waypointId: string | null) => f.k.bind(id, classId, null, "project", {
    keeperThreadId: "lead", boardQuestId: q.id, waypointId, title: "Work", brief, errand: false,
  });
  bind("maker", "smith", "w1");
  bind("checker", "warden", null);
  const tool = (threadId: string, input: unknown) => f.harness.behavior.invokeAgentTool("journal", input, { threadId });
  const link = async (waypointId: string, threadId = "maker") => {
    await journal.prepare(threadId);
    return journal.linkWaypoint(threadId, { boardQuestId: q.id, waypointId }, `Work on ${waypointId}`, threadId, { kind: "tavern" });
  };
  const done = (id: string, threadId = "maker") => tool(threadId, { action: "done", id, evidence: proof });
  const state = (id: string) => f.k.summary(q.id).waypoints.find(w => w.id === id)!;
  return { ...f, q, plan, journal, tool, link, done, state, bind };
}

it("offers a submitted entry for review while another linked entry is open", async () => {
  const f = await fixture();
  const id = await f.link("w1");
  await f.done(id);
  await f.tool("maker", { action: "add", description: "The other part" });
  const sibling = f.journal.get("maker").entries.at(-1)!.id;
  await f.tool("maker", { action: "link", id: sibling, link: { boardQuestId: f.q.id, waypointId: "w1" } });
  expect(f.state("w1").state).toBe("todo");
  expect(f.runtime.review().items).toMatchObject([{ boardQuestId: f.q.id, waypoint: { id: "w1" }, evidenceCount: 1 }]);
});

it("keeps unfinished released work open without erasing verified proof on the same waypoint", async () => {
  const f = await fixture();
  const first = await f.link("w1");
  await f.done(first);
  expect(await f.tool("checker", { action: "verify", threadId: "maker", id: first, evidence: proof })).not.toMatchObject({ isError: true });
  await f.tool("maker", { action: "add", description: "Another case" });
  const second = f.journal.get("maker").entries.at(-1)!.id;
  expect(await f.tool("maker", { action: "link", id: second, link: { boardQuestId: f.q.id, waypointId: "w1" } })).not.toMatchObject({ isError: true });
  expect(await f.runtime.release("lead", "maker", "Free the seat")).toBe(true);
  expect(f.state("w1").state).toBe("todo");
  expect(f.journal.get("maker").entries.map(entry => entry.status)).toEqual(["verified", "todo"]);
  expect(() => f.journal.edit("maker", { op: "delete", entryIds: [second] }, { kind: "agent", threadId: "lead" })).toThrow(/linked work/i);
  expect(f.state("w1").state).toBe("todo");
  await f.runtime.proposeWrap("lead", f.q.id, "Only part is verified", "Another case remains");
  expect(f.k.store.openAsks("lead", f.q.id).find(ask => ask.kind === "conclude")?.effect?.type).toBe("close-early");
});

it("lets a replacement's verified work settle the waypoint without deleting the first maker's unfinished entry", async () => {
  const f = await fixture();
  const first = await f.link("w1");
  await f.tool("maker", { action: "block", id: first, reason: "No fixture" });
  await f.runtime.release("lead", "maker", "Replace");
  expect(f.state("w1").state).toBe("blocked");
  f.bind("successor", "smith", "w1");
  const second = await f.link("w1", "successor");
  await f.done(second, "successor");
  expect(await f.tool("checker", { action: "verify", threadId: "successor", id: second, evidence: proof })).not.toMatchObject({ isError: true });
  expect(f.state("w1").state).toBe("verified");
  expect(f.journal.get("maker").entries.find(entry => entry.id === first)?.status).toBe("blocked");
  await f.runtime.release("lead", "successor", "Work finished");
  expect(f.state("w1").state).toBe("verified");
});

it("accepts a linked submission in the journal and Undo removes only that acceptance", async () => {
  const f = await fixture();
  const id = await f.link("w2");
  await f.done(id);
  expect(f.state("w2").state).toBe("reported");
  expect(await f.tool("lead", { action: "verify", threadId: "maker", id, reason: "Matches the goal" })).not.toMatchObject({ isError: true });
  expect(f.state("w2")).toMatchObject({ state: "accepted", verifiedBy: null });
  expect(f.journal.get("maker").entries[0]).toMatchObject({ status: "done", evidence: proof, review: { kind: "keeper", actor: { kind: "agent", threadId: "lead" }, reason: "Matches the goal" } });
  const decision = f.k.store.all("decisions").at(-1)!;
  await f.tool("maker", { action: "note", id, note: "Follow-up observation" });
  f.k.undoDecision(decision.id);
  expect(f.state("w2").state).toBe("reported");
  expect(f.journal.get("maker").entries[0]).toMatchObject({ status: "done", evidence: proof, review: null, note: expect.stringContaining("Follow-up observation") });
});

it("keeps the old acceptance auditable but asks for a new check when the maker changes the proof", async () => {
  const f = await fixture();
  const id = await f.link("w2");
  await f.done(id);
  await f.tool("lead", { action: "verify", threadId: "maker", id, reason: "Matches the goal" });
  expect(f.state("w2").state).toBe("accepted");
  await f.tool("maker", { action: "done", id, evidence: [{ ...proof[0]!, detail: "The result changed" }] });
  expect(f.state("w2").state).toBe("reported");
  expect(f.journal.get("maker").entries[0]).toMatchObject({ review: null, evidence: [proof[0], { detail: "The result changed" }] });
});

it("records an outside reply as submitted proof, but not the contact alone", async () => {
  const f = await fixture();
  const contact = { boardQuestId: f.q.id, waypointId: "w4", askedWho: "Outside team", via: "Their channel" };
  f.k.memory.gate("lead", contact);
  expect(f.state("w4").state).toBe("blocked");
  expect(f.journal.linkedEntries(f.q.id)).toEqual([]);
  const id = await f.link("w4", "lead");
  await f.done(id, "lead");
  expect(f.state("w4").state).toBe("blocked");
  f.k.memory.gate("lead", { ...contact, answer: "The check passed" });
  expect(f.state("w4").state).toBe("reported");
  expect(f.journal.linkedEntries(f.q.id)).toMatchObject([{ id, status: "done", evidence: [proof[0], { detail: "The check passed" }] }]);
  f.k.settle("lead", { boardQuestId: f.q.id, waypointId: "w4", as: "accepted", reason: "The reply confirms the claim" });
  expect(f.state("w4").state).toBe("accepted");
});

it("skips only optional linked work and does not require proof for a plain entry", async () => {
  const f = await fixture();
  const id = await f.link("w1");
  expect(await f.tool("lead", { action: "skip", threadId: "maker", id, reason: "Not needed" })).toMatchObject({ isError: true });
  expect(await f.tool("lead", { action: "skip", link: { boardQuestId: f.q.id, waypointId: "w6" }, reason: "Not needed" })).not.toMatchObject({ isError: true });
  expect(f.state("w6")).toMatchObject({ state: "skipped", verifiedBy: null });
  expect(f.journal.linkedEntries(f.q.id).find(entry => entry.link?.waypointId === "w6")).toMatchObject({ threadId: "lead", review: { kind: "skip", reason: "Not needed" } });
  await f.tool("solo", { action: "add", description: "Plain task" });
  expect(await f.tool("solo", { action: "done", id: "00" })).not.toMatchObject({ isError: true });
  expect(f.journal.get("solo").entries[0]).toMatchObject({ status: "done", link: null, evidence: [] });
});

it("uses the user's exact Close early answer to waive unfinished work without verifying it", async () => {
  const f = await fixture();
  const id = await f.link("w1");
  const closing = await f.runtime.proposeWrap("lead", f.q.id, "Stop with no verified result", "Check remains");
  await f.harness.invokeRpc("answerAsk", { askId: closing.askId, optionId: "close-early", via: "page" });
  expect(f.journal.get("maker").entries.find(entry => entry.id === id)).toMatchObject({ review: { kind: "waiver", actor: { kind: "user" }, ref: closing.askId } });
  expect(f.state("w1")).toMatchObject({ state: "skipped", verifiedBy: null, resolutionReason: expect.stringContaining("Waived by you") });
});

it("stores the user's qualifying answer with its authority and leaves a decline open", async () => {
  const f = await fixture();
  const makeAsk = () => f.k.ask("lead", { boardQuestId: f.q.id, kind: "decision", effect: { type: "decision" }, question: "Ready?", why: "Your call", waypointId: "w5", completeOn: ["yes"], holds: [], meanwhile: "Wait", options: [
    { id: "yes", label: "Done", recommended: true, detail: "Confirmed" }, { id: "no", label: "Not yet", recommended: false, detail: "Keep open" },
  ] });
  await f.harness.invokeRpc("answerAsk", { askId: makeAsk().id, optionId: "no", via: "page" });
  expect(f.journal.linkedEntries(f.q.id)).toEqual([]);
  expect(f.state("w5").state).not.toBe("done");
  const ask = makeAsk();
  await f.harness.invokeRpc("answerAsk", { askId: ask.id, optionId: "yes", note: "Confirmed the result", via: "page" });
  expect(f.journal.linkedEntries(f.q.id)).toMatchObject([{ status: "done", doneBy: { kind: "user" }, evidence: [{ ref: ask.id, detail: expect.stringContaining("Confirmed the result") }] }]);
  expect(f.state("w5").state).toBe("done");
});

it("preserves a legacy waypoint-level acceptance without attributing it to individual submissions", async () => {
  const f = await fixture(true);
  const id = await f.link("w2");
  await f.done(id);
  f.advance(Date.now() + 1000 - f.time());
  const decision = f.k.settle("lead", { boardQuestId: f.q.id, waypointId: "w2", as: "accepted", reason: "Accepted this waypoint" });
  if (!("waypointCall" in decision) || !decision.waypointCall) throw new Error("Expected a legacy decision");
  f.k.store.put("decisions", decision.id, { ...decision, waypointCall: { ...decision.waypointCall, acceptedEntries: undefined } });
  const before = f.journal.get("maker").entries;
  await f.k.migrateWaypointJournal();
  expect(f.state("w2")).toMatchObject({ state: "accepted", resolutionReason: "Accepted this waypoint", evidenceCount: proof.length });
  expect(f.journal.get("maker").entries).toEqual(before);
  expect(f.journal.get("lead").entries).toEqual(expect.arrayContaining([expect.objectContaining({
    evidence: proof, review: expect.objectContaining({ actor: { kind: "agent", threadId: "lead" }, at: decision.createdAt, ref: decision.id }),
  })]));
  const extra = [{ ...proof[0]!, detail: "Unreviewed follow-up" }];
  await f.tool("maker", { action: "done", id, evidence: extra });
  expect(f.state("w2").state).toBe("reported");
  f.k.undoDecision(decision.id);
  expect(f.journal.get("lead").entries.every(e => e.review?.ref !== decision.id)).toBe(true);
  expect(f.journal.get("maker").entries[0]?.evidence).toEqual([...proof, ...extra]);
});

it("leaves a failed migration on the legacy path, rolls back partial receipts, and retries", async () => {
  const f = await fixture(true);
  const id = await f.link("w2");
  await f.done(id);
  f.advance(Date.now() + 1000 - f.time());
  f.k.settle("lead", { boardQuestId: f.q.id, waypointId: "w2", as: "accepted", reason: "Checked" });
  f.k.settle("lead", { boardQuestId: f.q.id, waypointId: "w6", as: "skipped", reason: "Optional" });
  const record = f.port.recordWaypoint;
  const fail = vi.spyOn(f.port, "recordWaypoint").mockImplementationOnce(record).mockImplementationOnce(() => { throw new Error("Journal unavailable"); });
  const warn = vi.fn();
  await f.k.migrateWaypointJournal(warn);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("Journal unavailable"));
  expect(f.k.quest(f.q.id).waypointJournal).toBeUndefined();
  expect(f.state("w2").state).toBe("accepted");
  expect(f.journal.linkedEntries(f.q.id)).toMatchObject([{ id, review: null }]);
  fail.mockRestore();
  await f.k.migrateWaypointJournal(warn);
  expect(f.k.quest(f.q.id).waypointJournal).toBe(true);
  expect(f.state("w2").state).toBe("accepted");
  expect(f.state("w6").state).toBe("skipped");
});

it("migrates only attested legacy completions on an independent scratch copy and can roll back", async () => {
  const f = await fixture(true);
  const id = await f.link("w2");
  const ambiguousId = await f.link("w7");
  await f.done(id);
  await f.done(ambiguousId);
  f.advance(Date.now() + 1000 - f.time());
  const decision = f.k.settle("lead", { boardQuestId: f.q.id, waypointId: "w2", as: "accepted", reason: "Checked the evidence" });
  f.k.settle("lead", { boardQuestId: f.q.id, waypointId: "w6", as: "skipped", reason: "Optional" });
  const ambiguous = f.k.settle("lead", { boardQuestId: f.q.id, waypointId: "w7", as: "accepted", reason: "Unattested historical acceptance" });
  if (!("waypointCall" in ambiguous) || !ambiguous.waypointCall) throw new Error("Expected a legacy waypoint decision");
  f.k.store.put("decisions", ambiguous.id, { ...ambiguous, waypointCall: { ...ambiguous.waypointCall, acceptedEntries: [{ threadId: "maker", id: "missing" }] } });
  const original = f.journal.linkedEntries(f.q.id);
  expect(original.every(entry => !entry.review)).toBe(true);
  const root = mkdtempSync(join(tmpdir(), "waypoint-migration-"));
  const backup = join(root, "pre-upgrade.db"), scratch = join(root, "upgrade.db");
  const serialize = (f.k.store.db as unknown as Database.Database).serialize();
  writeFileSync(backup, serialize);
  writeFileSync(scratch, readFileSync(backup));
  function open(path: string) {
    const db = new Database(path);
    databases.push(db);
    const store = new KeeperStore(db);
    const journal = registerJournal(f.bb, db, { roleOf: id => store.get("members", id), invalidate: () => {} });
    return { keeper: new Keeper(store, journal, f.time), journal };
  }
  try {
    const { keeper, journal } = open(scratch);
    await keeper.migrateWaypointJournal();
    const result = journal.linkedEntries(f.q.id);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ id, evidence: original[0]!.evidence, review: expect.objectContaining({ kind: "keeper", actor: { kind: "agent", threadId: "lead" }, at: decision.createdAt, reason: "Checked the evidence" }) }),
      expect.objectContaining({ review: expect.objectContaining({ kind: "skip", reason: "Optional" }) }),
      expect.objectContaining({ id: ambiguousId, review: null }),
    ]));
    expect(keeper.summary(f.q.id).waypoints.find(w => w.id === "w7")).toMatchObject({ state: "reported", resolutionReason: expect.stringContaining("not backed by current submitted proof") });
    await keeper.migrateWaypointJournal();
    expect(journal.linkedEntries(f.q.id)).toEqual(result);
    keeper.undoDecision(decision.id);
    expect(keeper.summary(f.q.id).waypoints.find(w => w.id === "w2")?.state).toBe("reported");
    const restored = open(backup);
    expect(restored.journal.linkedEntries(f.q.id)).toEqual(original);
    expect(restored.keeper.quest(f.q.id).waypointJournal).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
