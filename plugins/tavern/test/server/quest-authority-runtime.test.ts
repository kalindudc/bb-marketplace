// @vitest-environment node
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { seedQuest, planInput, waypointEntry } from "./support";
import { requireUserAct } from "../../src/server/authority";
const receipt = (act: "delegateQuest" | "preapproveQuest" | "revokeQuestAuthority") => requireUserAct({ experimental_caller: { kind: "client" } } as never, act);
const options = [{ id: "approve", label: "Approve", detail: "", recommended: false }, { id: "deny", label: "Deny", detail: "", recommended: false }];
it("records delegated decisions with Undo, refuses after revoke and lets the Keeper ask when unsure", async () => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Quest", "Quest");
  f.k.authority.delegate(q.id, "credential", receipt("delegateQuest"));
  const ask = f.k.ask("lead", { boardQuestId: q.id, kind: "credential", effect: { type: "decision" }, question: "Grant?", why: "Delegated", options, holds: [], meanwhile: "Other work" });
  const decision = f.k.decide("lead", { boardQuestId: q.id, askId: ask.id, optionId: "approve", source: "keeper", text: "Grant", why: "Covered by the delegated kind", reversible: true });
  expect(f.k.store.get("asks", ask.id)?.answer?.by).toBe("keeper");
  f.k.undoDecision(decision.id);
  expect(f.k.store.get("asks", ask.id)?.state).toBe("open");
  const grant = f.k.quest(q.id).delegations![0]!;
  f.k.authority.revoke(q.id, grant.id, receipt("revokeQuestAuthority"));
  expect(() => f.k.decide("lead", { boardQuestId: q.id, askId: ask.id, optionId: "approve", source: "keeper", text: "Grant", why: "No longer delegated", reversible: true })).toThrow(/user/);
});
it("accepts only the assigned Warden’s current exact-act evidence", async () => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Quest", "Quest");
  f.k.authority.delegate(q.id, "merge", receipt("delegateQuest"));
  const warden = f.k.bind("reviewer", "warden", null, "project");
  f.k.store.put("members", warden.threadId, { ...warden, role: "member", boardQuestId: q.id, keeperThreadId: "lead", checkerMakerThreadId: "maker", checkerWaypointId: "w1" });
  const commit = "a".repeat(40);
  const ask = f.k.ask("lead", { boardQuestId: q.id, kind: "merge", effect: { type: "decision" }, target: { commit }, question: "Merge?", why: "Delegated", options, holds: [], meanwhile: "Wait" });
  const entry = { ...waypointEntry("maker", q.id), status: "verified" as const, review: { actor: { kind: "agent" as const, threadId: "reviewer" }, at: f.time(), evidence: [{ kind: "command" as const, ref: commit, detail: "Exact commit checked", exitCode: 0 }], reason: null, previousNote: null, memberEvidenceAt: f.time() } };
  vi.spyOn(f.port, "linkedEntries").mockReturnValue([entry]);
  expect(() => f.k.authority.recordVerdict("lead", ask.id, entry.id, { commit })).toThrow();
  f.k.authority.recordVerdict("reviewer", ask.id, entry.id, { commit });
  expect(() => f.k.authority.assertVerdict(ask)).not.toThrow();
  expect(() => f.k.authority.assertVerdict({ ...ask, target: { commit: "b".repeat(40) } })).toThrow(/exact/);
  vi.mocked(f.port.linkedEntries).mockReturnValue([{ ...entry, status: "doing", review: null }]);
  expect(() => f.k.authority.assertVerdict(ask)).toThrow(/current/);
});
it("automatically retries one real placement blocker then stops on the next", async () => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Quest", "Quest");
  f.k.authority.preapprove(q.id, { greenlight: null, placement: true, conclude: false, endsAt: null }, receipt("preapproveQuest"));
  const request = { boardQuestId: q.id, kind: "blocker" as const, effect: { type: "placement-blocker" } as const, question: "Placement failed", why: "System failure", options: [{ id: "retry", label: "Retry", detail: "", recommended: false }, { id: "stop", label: "Stop", detail: "", recommended: false }], holds: [], meanwhile: "Hold" };
  const first = f.k.ask("lead", request, {}, true); await f.runtime.applyStandingAnswers(q.id);
  expect(f.k.store.get("asks", first.id)?.answer).toMatchObject({ by: "preapproval", optionId: "retry" });
  const second = f.k.ask("lead", request, {}, true); await f.runtime.applyStandingAnswers(q.id);
  expect(f.k.store.get("asks", second.id)?.answer).toMatchObject({ by: "preapproval", optionId: "stop" });
  expect(["stopping", "stopped"]).toContain(f.k.quest(q.id).phase);
});
it.each(["wrong-class", "too-many", "always-ask", "expired", "revoked"])("leaves %s greenlights open", async condition => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Quest", "Quest");
  const grant = f.k.authority.preapprove(q.id, { greenlight: { maxMembers: condition === "too-many" ? 0 : 1, classes: condition === "wrong-class" ? ["ranger"] : ["smith"] }, placement: false, conclude: false, endsAt: condition === "expired" ? f.k.now() + 1 : null }, receipt("preapproveQuest"));
  if (condition === "expired") vi.spyOn(f.k, "now").mockReturnValue(grant.at + 2);
  if (condition === "revoked") f.k.authority.revoke(q.id, grant.id, receipt("revokeQuestAuthority"));
  f.k.plan("lead", { ...planInput(q.id), reversible: true, alwaysAskKinds: condition === "always-ask" ? ["merge"] : [], party: [{ classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] }] });
  expect(f.k.quest(q.id).greenlitVersion).toBeNull();
});
it("concludes only a fully verified quest, never one with skipped or unverified work", async () => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Quest", "Quest");
  f.k.plan("lead", planInput(q.id)); await f.runtime.answerAsk(f.k.store.openAsks("lead")[0]!.id, "approve", null, "page", true);
  f.k.authority.preapprove(q.id, { greenlight: null, placement: false, conclude: true, endsAt: null }, receipt("preapproveQuest"));
  const ask = f.k.ask("lead", { boardQuestId: q.id, kind: "conclude", effect: { type: "conclude", draft: { outcome: "Done", left: "" } }, question: "Conclude?", why: "End", options: [{ id: "conclude", label: "Conclude", detail: "", recommended: false }], holds: [], meanwhile: "Wait" });
  const summary = f.k.summary(q.id);
  vi.spyOn(f.k, "summary").mockReturnValue({ ...summary, waypoints: summary.waypoints.map(w => ({ ...w, state: "skipped" })) });
  expect(f.k.authority.match(ask)).toBeNull();
  vi.mocked(f.k.summary).mockReturnValue({ ...summary, waypoints: summary.waypoints.map(w => ({ ...w, state: "verified" })) });
  expect(f.k.authority.match(ask)?.optionId).toBe("conclude");
  await f.runtime.applyStandingAnswers(q.id);
  expect(f.k.quest(q.id).phase).toBe("done");
  expect(f.k.store.get("asks", ask.id)?.answer?.by).toBe("preapproval");
});
