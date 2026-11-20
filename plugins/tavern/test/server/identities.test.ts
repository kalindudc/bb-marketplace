// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { rpcHandlers } from "../../src/server/rpc";
import { rpcContract } from "../../src/shared/contract";
import { IDENTITY_PAGE_SIZE } from "../../src/shared/identity";
import { setup } from "./runtime-fixture";
import { makeThreadResponse } from "./host";

const f = () => {
  const fixture = setup();
  disposals.push(() => fixture.k.store.db.close());
  return fixture;
};
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

it("refuses an oversized identities page before reading any thread", () => {
  const { bb } = f();
  const get = vi.spyOn(bb.sdk.threads, "get");
  const ids = Array.from({ length: IDENTITY_PAGE_SIZE }, (_, i) => `thr_${i}`);
  expect(rpcContract.identities?.input.safeParse({ ids, viewer: "lead" })).toMatchObject({ success: true });
  expect(rpcContract.identities?.input.safeParse({ ids: [...ids, "extra"], viewer: "lead" })).toMatchObject({ success: false });
  expect(get).not.toHaveBeenCalled();
});

it("resolves relatives and names from the SDK and member records, not Tavern lifecycle flags", async () => {
  const { runtime, k, bb } = f();
  k.bind("moss", "keeper", null, "project");
  k.store.put("members", "moss", { ...k.member("moss")!, displayName: "Moss" });
  for (const [id, keeper] of [["juno", "moss"], ["sibling", "lead"], ["child", "lead"]]) {
    k.store.put("members", id!, { ...k.member("lead")!, threadId: id!, keeperThreadId: keeper!, role: "member", classId: "smith", displayName: id === "juno" ? "Juno" : undefined, characterId: null });
  }
  const get = vi.spyOn(bb.sdk.threads, "get").mockImplementation(async ({ threadId }) => {
    if (threadId === "missing") throw Object.assign(new Error("not found"), { status: 404 });
    if (threadId === "offline" || threadId === "juno") throw new Error("host offline");
    const parentThreadId = threadId === "viewer" ? "plain-parent" : threadId === "child" ? "lead" : null;
    return makeThreadResponse({ id: threadId, parentThreadId, title: threadId === "old" ? "Old notes" : null, archivedAt: threadId === "old" ? 20 : null, deletedAt: threadId === "deleted" ? 30 : null });
  });
  k.store.put("members", "viewer", { ...k.member("sibling")!, threadId: "viewer" });
  const readRuntime = vi.spyOn(k.store, "runtime");
  const read = rpcHandlers(runtime).identities;
  expect(read).toBeTypeOf("function");
  const result = await read({ viewer: "viewer", ids: ["viewer", "lead", "sibling", "old", "deleted", "missing", "plain-parent"] });
  const scanned = Object.fromEntries(result.identities.map(value => [value.threadId, value]));
  expect(scanned.viewer?.relation).toBe("self");
  expect(scanned.lead?.relation).toBe("this thread's Keeper");
  expect(scanned.sibling?.relation).toBe("in this Keeper's party");
  expect(scanned["plain-parent"]?.relation).toBe("parent of this thread");
  expect(scanned.old).toMatchObject({ name: "Old notes", life: "archived", canOpen: true });
  for (const id of ["deleted", "missing"]) expect(scanned[id]).toMatchObject({ life: "deleted", canOpen: false });
  expect(get.mock.calls.filter(([arg]) => arg.threadId === "viewer")).toHaveLength(1);
  expect((await read({ viewer: "lead", ids: ["child"] })).identities[0]).toMatchObject({ relation: "child of this thread", life: "live", canOpen: true });
  expect((await read({ viewer: "child", ids: ["lead"] })).identities[0]?.relation).toBe("this thread's Keeper");
  expect((await read({ viewer: "viewer", ids: [] })).identities).toEqual([]);
  const partial = await read({ viewer: "viewer", ids: ["offline", "juno", "old", "missing"] });
  expect(partial.identities).toEqual([
    expect.objectContaining({ threadId: "offline", name: "a thread", life: "live", relation: "other", canOpen: true }),
    expect.objectContaining({ threadId: "juno", name: "Juno", life: "live", relation: "other", canOpen: true }),
    expect.objectContaining({ threadId: "old", life: "archived", canOpen: true }),
    expect.objectContaining({ threadId: "missing", life: "deleted", canOpen: false }),
  ]);
  expect(readRuntime).not.toHaveBeenCalled();
});
