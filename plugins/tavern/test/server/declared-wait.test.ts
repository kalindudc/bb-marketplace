// @vitest-environment node
import { expect, it, vi } from "vitest";
import { registerTools } from "../../src/server/tools";
import { setup } from "./runtime-fixture";

async function party() {
  const f = setup();
  registerTools(f.bb, f.runtime);
  const brief = { outcome: "Read the result", mode: "make-it-work" as const, outOfScope: "", doneWhen: "Report", context: [], questions: [], timeboxMinutes: null };
  for (const id of ["waiting", "other"]) {
    f.k.bind(id, "smith", null, "project", { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: id, brief });
    f.k.activity(id, "idle");
  }
  const report = (wait: { condition: string; dueAt?: number }) => f.harness.behavior.invokeAgentTool("tavern_report", {
    status: "blocked", outcome: "Waiting for verification", evidence: [], artifacts: [], wait,
  }, { threadId: "waiting" });
  return { ...f, report };
}

it("keeps a declared wait scoped to its member and wakes the Keeper once at the deadline", async () => {
  const f = await party();
  const condition = "The build passes or fails";
  const dueAt = f.time() + 60 * 60_000;
  await f.report({ condition, dueAt });
  f.advance(40 * 60_000);
  f.k.stale();
  expect(f.k.member("waiting")?.strikes).toBe(0);
  expect(f.k.member("other")?.strikes).toBe(1);
  f.advance(20 * 60_000);
  f.k.stale();
  expect(f.k.member("waiting")?.strikes).toBe(1);
  await f.runtime.tick("lead");
  f.advance(61_000);
  await f.runtime.tick("lead");
  expect(f.k.store.events("lead").filter(e => e.type === "promise.due")).toEqual([
    expect.objectContaining({ text: expect.stringContaining(condition), data: expect.objectContaining({ memberThreadId: "waiting" }) }),
  ]);
});

it("does not flag a member with a pending wake-up, but resumes stale checks after it clears", async () => {
  const f = await party();
  const read = vi.spyOn(f.bb.sdk.threads, "experimental_listPluginMetadata");
  read.mockResolvedValueOnce({ threads: [{ threadId: "waiting", metadata: { wakeups: { version: 1, pending: [{ id: "wake" }], untilAt: f.time() + 60 * 60_000 } } }] });
  f.advance(40 * 60_000);
  await f.runtime.sweep();
  expect(read).toHaveBeenCalledWith(expect.objectContaining({ pluginId: "wakeup", threadIds: expect.arrayContaining(["waiting", "other"]) }));
  expect(f.k.member("waiting")?.strikes).toBe(0);
  expect(f.k.member("other")?.strikes).toBe(1);
  read.mockResolvedValueOnce({ threads: [] });
  await f.runtime.sweep();
  expect(f.k.member("waiting")?.strikes).toBe(1);
});

it("rejects a reported wait without a deadline", async () => {
  const f = await party();
  await expect(f.report({ condition: "The build passes" })).rejects.toThrow("dueAt");
  expect(f.k.store.all("reports")).toHaveLength(0);
});

it("retires a member wait when a fresh brief is delivered", async () => {
  const f = await party();
  await f.report({ condition: "A superseded check", dueAt: f.time() + 60 * 60_000 });
  expect(f.k.memory.notes("lead")).toHaveLength(1);
  f.runtime.briefed("waiting");
  expect(f.k.memory.notes("lead")).toHaveLength(0);
  f.advance(40 * 60_000);
  f.k.stale();
  expect(f.k.member("waiting")?.strikes).toBe(1);
});

it("strikes a hung working turn twice and advises release without issuing a quiet hint", async () => {
  const f = await party();
  f.k.activity("waiting", "working");
  for (let i = 1; i <= 2; i++) {
    f.advance(20 * 60_000);
    f.k.stale();
    expect(f.k.member("waiting")?.strikes).toBe(i);
  }
  const own = f.k.store.events("lead").filter(e => e.data.memberThreadId === "waiting");
  expect(own.filter(e => e.type === "member.quiet")).toHaveLength(0);
  expect(own.filter(e => e.type === "member.stale")).toEqual([
    expect.objectContaining({ data: expect.objectContaining({ strikes: 1 }) }),
    expect.objectContaining({ data: expect.objectContaining({ strikes: 2 }), text: expect.stringContaining("releasable") }),
  ]);
});

it("hints once about working with recent thread activity but no evidence, without adding strikes", async () => {
  const f = await party();
  f.k.activity("waiting", "working");
  for (let i = 0; i < 3; i++) {
    f.advance(20 * 60_000);
    f.k.touch("waiting");
    f.k.stale();
  }
  expect(f.k.member("waiting")?.strikes).toBe(0);
  expect(f.k.store.events("lead").filter(e => e.type === "member.quiet")).toEqual([
    expect.objectContaining({ data: { memberThreadId: "waiting" } }),
  ]);
});

it("carries a quiet member in the next ledger without waking until there is actionable news", async () => {
  const f = await party();
  f.k.activity("other", "working");
  f.k.activity("waiting", "working");
  f.advance(20 * 60_000);
  f.k.touch("waiting");
  f.k.touch("other");
  f.k.stale();
  await f.runtime.tick("lead");
  const sends = () => f.harness.inspection.sdk.callsTo("threads.send");
  expect(sends()).toHaveLength(0);
  expect(f.k.restatement("lead")).toMatch(/no progress evidence since [^;]+; "waiting"/);
  f.advance(20 * 60_000);
  f.k.touch("waiting");
  f.k.stale();
  await f.runtime.tick("lead");
  expect(sends()).toHaveLength(1);
  expect(JSON.stringify(sends()[0]?.args)).toContain("member.stale");
  expect(JSON.stringify(sends()[0]?.args)).not.toContain("member.quiet");
});
