// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { roomSchema, type Room } from "../../src/shared/contract";
import { registerRpc } from "../../src/server/rpc";
import { KeeperStore } from "../../src/server/keeper/store";
import { makeThreadResponse } from "./host";
import { setup } from "./runtime-fixture";

const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const f = setup();
  databases.push(f.k.store.db);
  registerRpc(f.bb, f.runtime);
  const room = () => f.harness.invokeRpc("room", {}) as Promise<Room>;
  return { ...f, room };
}

describe("room Keeper thread metadata", () => {
  it("returns strict JSON nulls for unobserved legacy metadata, not the binding time", async () => {
    const f = fixture();
    const room = await f.room();
    expect(room.keepers[0]).toMatchObject({ threadTitle: null, threadCreatedAt: null });
    expect(f.k.member("lead")!.createdAt).toBe(f.time());
    expect(() => z.json().parse(room)).not.toThrow();
    expect(JSON.parse(JSON.stringify(room))).toStrictEqual(room);
    const legacy = { ...room, keepers: room.keepers.map(({ threadTitle: _title, threadCreatedAt: _created, ...row }) => row) };
    expect(roomSchema.parse(legacy)).toStrictEqual(legacy);
  });

  it("keeps same-name Keepers separate using their actual bb title and creation time", async () => {
    const f = fixture();
    f.k.bind("other", "keeper", "wren", "project");
    f.runtime.updateThread(makeThreadResponse({ id: "lead", title: "Fix the checkout", createdAt: 100 }));
    f.runtime.updateThread(makeThreadResponse({ id: "other", title: "Investigate queues", createdAt: 200 }));
    const room = await f.room();
    expect(room.keepers.map(row => ({ id: row.member.threadId, name: row.member.characterId, title: row.threadTitle, created: row.threadCreatedAt }))).toEqual([
      { id: "lead", name: "wren", title: "Fix the checkout", created: 100 },
      { id: "other", name: "wren", title: "Investigate queues", created: 200 },
    ]);
    expect(new KeeperStore(f.k.store.db).runtime("lead")).toMatchObject({ threadTitle: "Fix the checkout", threadCreatedAt: 100 });
  });

  it("refreshes a title-only observation and invalidates the room without creating Keeper news", async () => {
    const f = fixture();
    const thread = makeThreadResponse({ id: "lead", title: "Old title", createdAt: 100 });
    f.runtime.updateThread(thread);
    const events = f.k.store.events("lead", 0, 100);
    const reanchor = f.k.store.runtime("lead").reanchor;
    vi.mocked(f.bb.rpc.experimental_invalidate).mockClear();
    f.runtime.updateThread({ ...thread, title: "New title" });
    expect((await f.room()).keepers[0]).toMatchObject({ threadTitle: "New title", threadCreatedAt: 100 });
    expect(f.bb.rpc.experimental_invalidate).toHaveBeenCalledWith(expect.arrayContaining(["tavern:room"]));
    expect(f.k.store.events("lead", 0, 100)).toEqual(events);
    expect(f.k.store.runtime("lead").reanchor).toEqual(reanchor);
    vi.mocked(f.bb.rpc.experimental_invalidate).mockClear();
    f.runtime.updateThread({ ...thread, title: "New title" });
    expect(f.bb.rpc.experimental_invalidate).not.toHaveBeenCalled();
  });

  it("preserves a null title rather than inventing a fallback, including archived Keepers", async () => {
    const f = fixture();
    f.runtime.updateThread(makeThreadResponse({ id: "lead", title: "Before", createdAt: 100 }));
    f.runtime.updateThread(makeThreadResponse({ id: "lead", title: null, titleFallback: "Not a title", createdAt: 100, archivedAt: f.time() }));
    expect((await f.room()).keepers[0]).toMatchObject({ threadTitle: null, threadCreatedAt: 100, archived: true });
  });

  it("fills old Keeper rows from bb on cold reconciliation without fetching during room reads", async () => {
    const f = fixture();
    f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => makeThreadResponse({ id: threadId, title: "Restored title", createdAt: 123 }));
    await f.runtime.reconcile();
    vi.mocked(f.bb.sdk.threads.get).mockClear();
    expect((await f.room()).keepers[0]).toMatchObject({ threadTitle: "Restored title", threadCreatedAt: 123 });
    expect(f.bb.sdk.threads.get).not.toHaveBeenCalled();
  });

  it("captures metadata carried by native thread observations", async () => {
    const f = fixture();
    await f.runtime.observe(makeThreadResponse({ id: "lead", title: "Observed title", createdAt: 0 }), 1);
    expect((await f.room()).keepers[0]).toMatchObject({ threadTitle: "Observed title", threadCreatedAt: 0 });
  });
});
