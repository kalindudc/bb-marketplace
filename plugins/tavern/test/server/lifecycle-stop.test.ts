// @vitest-environment node
import { seedQuest } from "./support";
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { makeThreadResponse } from "./host";

const brief = { outcome: "Build", mode: "make-it-work" as const, outOfScope: "", doneWhen: "Tests", context: [], questions: [], timeboxMinutes: null };
async function party() {
  const f = setup();
  const q = await seedQuest(f.k,"lead", "Build", "Build");
  f.k.bind("child", "smith", "juno", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Build", brief });
  f.k.activity("child", "working");
  let status: "active" | "idle" = "active";
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => makeThreadResponse({ id: threadId, status: threadId === "child" ? status : "idle" }));
  f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
  return { ...f, q, idle: () => { status = "idle"; } };
}
it("keeps a stop progressing, backs off, and confirms it on a later sweep", async () => {
  const f = await party();
  expect(await f.runtime.stop(f.q.id)).toEqual({ phase: "stopping", unconfirmed: 1 });
  expect(f.k.quest(f.q.id)).toMatchObject({ phase: "stopping", endedAt: null });
  expect(f.k.member("child")).toMatchObject({ stopPending: true, lastStopAttemptAt: f.time() });
  expect(() => f.k.archiveQuests([f.q.id], true)).toThrow(/Only done or stopped/);
  await f.runtime.retryStops("lead");
  expect(f.bb.sdk.threads.stop).toHaveBeenCalledTimes(1);
  f.advance(5000);
  await f.runtime.retryStops("lead");
  expect(f.bb.sdk.threads.stop).toHaveBeenCalledTimes(2);
  f.idle();
  f.advance(15_000);
  await f.runtime.retryStops("lead");
  expect(f.k.quest(f.q.id)).toMatchObject({ phase: "stopped", endedAt: f.time() });
  expect(f.k.member("child")).toMatchObject({ stopPending: false, state: "stopped", stopError: null });
});
it("raises just one blocker after two minutes and withdraws it on confirmation", async () => {
  const f = await party();
  await f.runtime.stop(f.q.id);
  f.advance(120_000);
  await f.runtime.retryStops("lead");
  await f.runtime.retryStops("lead");
  const asks = f.k.store.openAsks("lead", f.q.id);
  expect(asks).toHaveLength(1);
  expect(asks[0]?.why).toContain("@thread:child");
  f.idle();
  expect(await f.runtime.stop(f.q.id)).toEqual({ phase: "stopped", unconfirmed: 0 });
  expect(f.k.store.get("asks", asks[0]!.id)?.state).toBe("withdrawn");
});
it.each(["archivedAt", "deletedAt", "not-found"] as const)("treats %s as confirmed gone without a stop side effect", async gone => {
  const f = await party();
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => {
    if (gone === "not-found") throw Object.assign(new Error("thread missing"), { status: 404 });
    return makeThreadResponse({ id: threadId, [gone]: f.time() });
  });
  expect(await f.runtime.stop(f.q.id)).toEqual({ phase: "stopped", unconfirmed: 0 });
  expect(f.bb.sdk.threads.stop).not.toHaveBeenCalled();
});
it("counts a bound pending hire only once among unconfirmed members", async () => {
  const f = await party();
  f.k.store.put("hires", "token", { classId: "smith", characterId: "juno", projectId: "project", createdAt: f.time(), memberThreadId: "child", owner: { keeperThreadId: "lead", boardQuestId: f.q.id, waypointId: null, errand: false, title: "Build", brief } });
  expect(await f.runtime.stop(f.q.id)).toEqual({ phase: "stopping", unconfirmed: 1 });
});
it("a returned quest refuses Stop without changing its final timestamp or touching members", async () => {
  const f = await party();
  f.k.store.put("quests", f.q.id, { ...f.q, phase: "done", endedAt: 99 });
  await expect(f.runtime.stop(f.q.id)).rejects.toThrow(/already returned/);
  expect(f.k.quest(f.q.id).endedAt).toBe(99);
  expect(f.bb.sdk.threads.stop).not.toHaveBeenCalled();
});
