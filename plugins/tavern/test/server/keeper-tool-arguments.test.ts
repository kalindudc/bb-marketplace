// @vitest-environment node
import { expect, it, vi } from "vitest";
import { registerTools } from "../../src/server/tools";
import { setup } from "./runtime-fixture";
import { planInput, seedQuest } from "./support";

function fixture() {
  const f = setup();
  registerTools(f.bb, f.runtime);
  const call = (name: string, args: unknown) => f.harness.behavior.invokeAgentTool(name, args, { threadId: "lead" });
  return { ...f, call };
}

it.each(["action", "op", "decision"])("judges a Ranger report using %s", async field => {
  const f = fixture();
  const accept = vi.spyOn(f.runtime, "acceptRangerReport").mockResolvedValue({ reportId: "report", memberName: "Mira", accepted: true, archiveBlocker: null });
  await expect(f.call("tavern_judge", { [field]: "accept", reportId: "report", reason: "Evidence checked" })).resolves.toContain("accepted");
  expect(accept).toHaveBeenCalledWith("lead", "report", "Evidence checked");
});

it("reports the canonical judge field and requires a continuation reason", async () => {
  const f = fixture();
  const args = { reportId: "report" };
  await expect(f.call("tavern_judge", args)).rejects.toThrow(/action.*accept.*continue/);
  await expect(f.call("tavern_judge", { ...args, action: "accept", op: "continue" })).rejects.toThrow(/action.*conflict/i);
  await expect(f.call("tavern_judge", { ...args, action: "continue", minutes: 5 })).rejects.toThrow(/reason/);
});

it.each(["member", "memberThreadId"])("uses %s for member tools", async field => {
  const f = fixture();
  f.k.bind("member-1", "smith", null, "project", { keeperThreadId: "lead", boardQuestId: null, waypointId: null, title: "Build", errand: true,
    brief: { outcome: "Build", mode: "make-it-work", outOfScope: "", doneWhen: "Done", context: [], questions: [], timeboxMinutes: null } });
  const release = vi.spyOn(f.runtime, "release").mockResolvedValue(true);
  const tell = vi.spyOn(f.runtime, "tell").mockResolvedValue({ status: "delivered", memberName: "Mira", attempts: 1, briefPending: false, pendingBriefId: null });
  await expect(f.call("tavern_tell", { [field]: "member-1", text: "Read the plan" })).resolves.toContain("delivered");
  expect(tell).toHaveBeenCalledWith("lead", "member-1", "Read the plan", undefined, undefined, undefined, undefined);
  await expect(f.call("tavern_status", { [field]: "member-1", section: "pending" })).resolves.toContain("pending");
  await expect(f.call("tavern_release", { [field]: "member-1", reason: "Finished" })).resolves.toContain("Released");
  expect(release).toHaveBeenCalledWith("lead", "member-1", "Finished");
});

it("names missing inputs and preserves long prose and exact context paths", async () => {
  const f = fixture();
  const q = await seedQuest(f.k, "lead", "Plan the parser", "Parser");
  const plan = planInput(q.id);
  await expect(f.call("tavern_release", { reason: "Done" })).rejects.toThrow(/member/);
  await expect(f.call("tavern_route", { kind: "new-quest", summary: "Plan it", notes: [{ kind: "commitment", text: "Run checks" }] })).rejects.toThrow(/notes\.0\.dueAt/);
  await expect(f.call("tavern_plan", { ...plan, changeNote: "x".repeat(501), waypoints: [{ ...plan.waypoints[0], check: "keeper", title: "x".repeat(201) }] })).resolves.toContain("Plan v1 saved");
  const context = [`/tmp/${"segment/".repeat(225)}fixture.txt`];
  const outcome = "x".repeat(2001);
  await expect(f.call("tavern_hire", { title: "Check", classId: "ranger", errand: true, brief: { outcome, mode: "make-it-work", outOfScope: "", doneWhen: "Done", context, questions: ["What changed?"], timeboxMinutes: 5 } })).resolves.toContain("Hired");
  const member = f.k.store.all("members").find(m => m.classId === "ranger")!;
  expect(f.k.store.runtime(member.threadId).brief).toMatchObject({ context, outcome });
});
