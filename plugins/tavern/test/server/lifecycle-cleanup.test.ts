// @vitest-environment node
import { putQuestFixture } from "./support";
import { seedQuest } from "./support";
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { makeThreadResponse } from "./host";

const brief = { outcome: "Build", mode: "make-it-work" as const, outOfScope: "", doneWhen: "Tests", context: [], questions: [], timeboxMinutes: null };
it.each(["archivedAt", "deletedAt", "not-found"] as const)("release checks fresh %s and never stops a gone member", async gone => {
  const f = setup();
  f.k.bind("child", "ranger", "juno", "project", { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Scout", brief });
  f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => {
    if (gone === "not-found") throw Object.assign(new Error("missing"), { status: 404 });
    return makeThreadResponse({ id: threadId, [gone]: f.time() });
  });
  expect(await f.runtime.release("lead", "child", "No longer needed")).toBe(true);
  expect(f.bb.sdk.threads.stop).not.toHaveBeenCalled();
});
it("refuses a new release on an ended quest without stopping its finished member", async () => {
  const f = setup();
  const q = await seedQuest(f.k,"lead", "Build", "Build");
  f.k.bind("child", "smith", "juno", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Build", brief });
  putQuestFixture(f.k.store, q.id, { ...q, phase: "done", endedAt: f.time() });
  f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
  await expect(f.runtime.release("lead", "child", "Late")).rejects.toThrow(/ended|stopping/);
  expect(f.bb.sdk.threads.stop).not.toHaveBeenCalled();
});
it("finishes an already requested release after its quest ends without new writes on that quest", async () => {
  const f = setup();
  const q = await seedQuest(f.k,"lead", "Build", "Build");
  f.k.bind("child", "smith", "juno", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Build", brief });
  f.k.store.patch("child", { releasePending: "Not needed" });
  putQuestFixture(f.k.store, q.id, { ...q, phase: "done", endedAt: f.time() });
  await f.runtime.sweep();
  expect(f.k.store.runtime("child").released?.reason).toBe("Not needed");
  expect(f.k.quest(q.id)).toMatchObject({ phase: "done", endedAt: f.time() });
});
it("pending archive cleanup treats a missing thread as already gone", async () => {
  const f = setup();
  f.k.bind("child", "ranger", "juno", "project", { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Scout", brief });
  f.k.store.patch("child", { archivePending: true });
  const get = f.bb.sdk.threads.get;
  f.bb.sdk.threads.get = vi.fn(async args => {
    if (args.threadId === "child") throw Object.assign(new Error("missing"), { status: 404 });
    return get(args);
  });
  await f.runtime.sweep();
  expect(f.k.store.runtime("child")).toMatchObject({ archivePending: false, archiveError: null, deletedAt: f.time() });
});
