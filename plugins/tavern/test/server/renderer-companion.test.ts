// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { seedQuest } from "./support";
import { makeThreadResponse } from "./host";
import { captureTaleDelivery } from "../../src/server/tale";
import { TaleCompanions, storageReferences, rewriteReferences } from "../../src/server/renderer/companion";
import { renderPrompt } from "../../src/server/renderer/provider";
import { registerRpc } from "../../src/server/rpc";

const dbs: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
async function fixture() {
  let sequence = 0;
  const spawn = vi.fn(async () => ({ id: `renderer-${++sequence}` }));
  const remove = vi.fn(async () => ({}));
  const archive = vi.fn(async () => ({}));
  const unarchive = vi.fn(async () => ({}));
  const update = vi.fn(async () => ({}));
  const write = vi.fn(async () => ({}));
  const send = vi.fn(async () => ({}));
  const f = setup({ threads: {
    spawn, archive, unarchive, delete: remove, output: async () => ({ output: null }), get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "project", environmentId: "env" }),
    storageLocation: async ({ threadId }: { threadId: string }) => ({ hostId: "host", storageRootPath: `/storage/${threadId}` }),
    queuedMessages: { list: async () => [{ id: "queued", updatedAt: 1 }], update, send },
  }, files: { read: async () => ({ content: "image", contentEncoding: "utf8", sizeBytes: 5 }), mkdir: async () => ({}), write } });
  dbs.push(f.k.store.db);
  const q = await seedQuest(f.k, "lead", "Render", "Deliver");
  f.k.store.put("quests", q.id, { ...f.k.quest(q.id), phase: "done" });
  const text = `# Answer\n\n${"$BB_THREAD_STORAGE"}/figure.svg\n\n::tavern-tale{quest="${q.id}"}`;
  const tell = () => f.k.store.event(f.time(), "lead", q.id, "quest.retold", "Retold", { outcome: "Done" });
  f.k.store.event(f.time(), "lead", q.id, "quest.wrapped", "Done", { outcome: "Done" });
  captureTaleDelivery(f.k, "lead", text);
  const companions = new TaleCompanions(f.bb, f.k);
  f.runtime.taleRenderer = companions;
  return { ...f, q, text, tell, companions, spawn, remove, archive, unarchive, update, write, send };
}
it("holds renderer spawns while Tavern is stopped without discarding the saved tale", async () => {
  const f = await fixture();
  const deliveries = f.k.store.all("taleDeliveries");
  f.k.store.put("stopAll", "tavern", { state: "stopped", since: f.time(), by: { kind: "user" }, receipt: null });
  await f.companions.ensure(f.q.id);
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.k.store.all("taleDeliveries")).toEqual(deliveries);
});
it("copies storage files and sends a marked delivery in a hidden no-model thread", async () => {
  const f = await fixture();
  const members = f.k.store.all("members");
  await Promise.all([f.companions.ensure(f.q.id), f.companions.ensure(f.q.id)]);
  expect(f.k.store.all("members")).toEqual(members);
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.spawn).toHaveBeenCalledWith(expect.objectContaining({
    providerId: "tavern", model: "tavern-renderer", reasoningLevel: "low", visibility: "hidden", parentNotifications: "off",
    projectId: "project", environment: { type: "reuse", environmentId: "env" }, parentThreadId: "lead",
  }));
  expect(f.write).toHaveBeenCalledWith(expect.objectContaining({ path: "/storage/renderer-1/tale-files/figure.svg", content: "image" }));
  expect(f.update).toHaveBeenCalledWith(expect.objectContaining({ input: [expect.objectContaining({ text: renderPrompt(f.q.id, "# Answer\n\n$BB_THREAD_STORAGE/tale-files/figure.svg\n"), visibility: "agent-only" })] }));
  expect(f.k.store.get("taleDeliveries", f.q.id)).toMatchObject({ companionThreadId: "renderer-1", companionReady: false });
  f.companions.idle("renderer-1", "# Answer");
  expect(f.k.store.get("taleDeliveries", f.q.id)?.companionReady).toBe(true);
});
it("replaces a retold companion and cleans quests and Keepers idempotently without deleting evidence", async () => {
  const f = await fixture(); await f.companions.ensure(f.q.id);
  f.tell(); captureTaleDelivery(f.k, "lead", f.text); await f.companions.ensure(f.q.id);
  expect(f.remove).toHaveBeenCalledWith({ threadId: "renderer-1", childThreadsConfirmed: false });
  expect(f.spawn).toHaveBeenCalledTimes(2);
  await f.companions.deleteQuest(f.q.id); await f.companions.deleteQuest(f.q.id);
  expect(f.remove).toHaveBeenCalledTimes(2);
  expect(f.k.store.all("taleDeliveries")).toHaveLength(2);
  await f.companions.ensure(f.q.id);
  await f.companions.deleteKeeper("lead");
  expect(f.remove).toHaveBeenCalledTimes(3);
});
it("contains creation failures and marks failed companions for fallback", async () => {
  const f = await fixture(); f.spawn.mockRejectedValueOnce(new Error("unavailable"));
  await expect(f.companions.ensure(f.q.id)).resolves.toBeUndefined();
  expect(f.k.store.get("taleDeliveries", f.q.id)?.companionReady).not.toBe(true);
});
it("creates on idle capture and backfills a companion on an older tale read", async () => {
  const f = await fixture();
  f.tell();
  f.runtime.memberEnded(makeThreadResponse({ id: "lead" }), f.text);
  await f.companions.settled();
  expect(f.spawn).toHaveBeenCalledTimes(1);
  const g = await fixture();
  registerRpc(g.bb, g.runtime);
  await g.harness.invokeRpc("boardQuest", { id: g.q.id });
  await g.companions.settled();
  expect(g.spawn).toHaveBeenCalledTimes(1);
});
it("does not block soft deletion or party archiving when cleanup fails, and retries cleanup", async () => {
  const f = await fixture(); await f.companions.ensure(f.q.id);
  const text = f.k.store.get("taleDeliveries", f.q.id)!.text;
  f.remove.mockRejectedValue(new Error("delete unavailable"));
  await expect(f.runtime.deleteBoardQuest(f.q.id)).resolves.toMatchObject({ ok: true, changed: 1 });
  expect(f.k.quest(f.q.id).deletedAt).not.toBeNull();
  expect(f.archive).toHaveBeenCalledWith({ threadId: "lead" });
  await expect(f.runtime.deleteBoardQuest(f.q.id)).resolves.toMatchObject({ ok: true, changed: 0 });
  expect(f.remove).toHaveBeenCalledTimes(2);
  expect(f.k.store.get("taleDeliveries", f.q.id)!.text).toBe(text);
});
it("keeps companions on archive and removes them on Keeper deletion", async () => {
  const f = await fixture(); await f.companions.ensure(f.q.id);
  await f.runtime.threadLifecycle("thread.archived", { thread: makeThreadResponse({ id: "lead", archivedAt: f.time() }) });
  expect(f.remove).not.toHaveBeenCalled();
  await f.runtime.threadLifecycle("thread.deleted", { thread: makeThreadResponse({ id: "lead", deletedAt: f.time() }) });
  expect(f.remove).toHaveBeenCalledTimes(1);
  expect(f.k.store.get("taleDeliveries", f.q.id)?.text).toContain("# Answer");
});
it("cleans a Keeper companion when reconciliation confirms its thread is gone", async () => {
  const f = await fixture(); await f.companions.ensure(f.q.id);
  f.runtime.threadGone("lead");
  await f.companions.settled();
  expect(f.remove).toHaveBeenCalledWith({ threadId: "renderer-1", childThreadsConfirmed: false });
  expect(f.k.store.get("taleDeliveries", f.q.id)?.text).toContain("# Answer");
});
it("marks a deleted companion for fallback without polling", async () => {
  const f = await fixture(); await f.companions.ensure(f.q.id);
  f.companions.idle("renderer-1", "# Answer");
  await f.runtime.threadLifecycle("thread.deleted", { thread: makeThreadResponse({ id: "renderer-1", deletedAt: f.time() }) });
  expect(f.k.store.get("taleDeliveries", f.q.id)).toMatchObject({ companionReady: false, companionFailed: true });

});
it("leaves transient lookup errors alone and succeeds on the next read", async () => {
  const f = await fixture(); await f.companions.ensure(f.q.id);
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => makeThreadResponse({ id: threadId, environmentId: "env" })).mockRejectedValueOnce(new Error("network down"));
  f.bb.sdk.threads.output = vi.fn(async () => ({ output: "# Answer" }));
  await f.companions.ensure(f.q.id);
  expect(f.k.store.get("taleDeliveries", f.q.id)).toMatchObject({ companionThreadId: "renderer-1", companionFailed: false });
  await f.companions.ensure(f.q.id);
  expect(f.k.store.get("taleDeliveries", f.q.id)?.companionReady).toBe(true);
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.remove).not.toHaveBeenCalled();
});
it("records archive without failure, restores on read and clears failure on unarchive", async () => {
  const f = await fixture(); await f.companions.ensure(f.q.id);
  f.companions.idle("renderer-1", "# Answer");
  await f.runtime.threadLifecycle("thread.archived", { thread: makeThreadResponse({ id: "renderer-1", archivedAt: f.time() }) });
  expect(f.k.store.get("taleDeliveries", f.q.id)).toMatchObject({ companionArchived: true, companionReady: true, companionFailed: false });
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => makeThreadResponse({ id: threadId, environmentId: "env", archivedAt: f.time() }));
  await f.companions.ensure(f.q.id);
  expect(f.unarchive).toHaveBeenCalledWith({ threadId: "renderer-1" });
  expect(f.k.store.get("taleDeliveries", f.q.id)).toMatchObject({ companionArchived: false, companionReady: true, companionFailed: false });
  f.companions.failed("renderer-1");
  await f.runtime.threadLifecycle("thread.unarchived", { thread: makeThreadResponse({ id: "renderer-1" }) });
  expect(f.k.store.get("taleDeliveries", f.q.id)?.companionFailed).toBe(false);
  expect(f.spawn).toHaveBeenCalledTimes(1);
});
it.each(["gone", "unarchive failed"])("replaces a %s companion only once per telling, even across restart", async reason => {
  const f = await fixture(); await f.companions.ensure(f.q.id);
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => {
    if (threadId.startsWith("renderer-") && reason === "gone") throw Object.assign(new Error("not found"), { status: 404 });
    return makeThreadResponse({ id: threadId, environmentId: "env", archivedAt: threadId.startsWith("renderer-") ? f.time() : null });
  });
  f.unarchive.mockRejectedValue(new Error("restore failed"));
  await f.companions.ensure(f.q.id);
  expect(f.spawn).toHaveBeenCalledTimes(2);
  expect(f.remove).toHaveBeenCalledWith({ threadId: "renderer-1", childThreadsConfirmed: false });
  const restored = new TaleCompanions(f.bb, f.k);
  await restored.ensure(f.q.id); await restored.ensure(f.q.id);
  expect(f.spawn).toHaveBeenCalledTimes(2);
  f.tell(); captureTaleDelivery(f.k, "lead", f.text);
  await restored.ensure(f.q.id);
  expect(f.spawn).toHaveBeenCalledTimes(3);
  await restored.ensure(f.q.id);
  expect(f.spawn).toHaveBeenCalledTimes(4);
});
it("does not loop creation when the one replacement attempt fails", async () => {
  const f = await fixture(); await f.companions.ensure(f.q.id);
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => makeThreadResponse({ id: threadId, environmentId: "env", archivedAt: threadId.startsWith("renderer-") ? f.time() : null }));
  f.unarchive.mockRejectedValue(new Error("restore failed"));
  f.spawn.mockRejectedValueOnce(new Error("create failed"));
  await f.companions.ensure(f.q.id);
  expect(f.k.store.get("taleDeliveries", f.q.id)?.companionReplacementAttempted).toBe(true);
  const restored = new TaleCompanions(f.bb, f.k);
  await restored.ensure(f.q.id); await restored.ensure(f.q.id);
  expect(f.spawn).toHaveBeenCalledTimes(2);
});
it("removes a companion if its Keeper disappears while it is being created", async () => {
  const f = await fixture();
  f.spawn.mockImplementationOnce(async () => {
    f.runtime.threadGone("lead");
    return { id: "renderer-late" };
  });
  await f.companions.ensure(f.q.id);
  expect(f.remove).toHaveBeenCalledWith({ threadId: "renderer-late", childThreadsConfirmed: false });
  expect(f.k.store.get("taleDeliveries", f.q.id)?.companionThreadId).toBeUndefined();
});
it("rewrites only copied safe storage references", () => {
  expect(rewriteReferences("[File](file:///storage/lead/a.svg)", "/storage/lead", new Set(["a.svg"]), "tale-files")).toBe("[File]($BB_THREAD_STORAGE/tale-files/a.svg)");
  expect(storageReferences("$BB_THREAD_STORAGE/a.svg /storage/lead/b.md $BB_THREAD_STORAGE/../secret", "/storage/lead")).toEqual(["a.svg", "b.md"]);
  expect(rewriteReferences("$BB_THREAD_STORAGE/a.svg /storage/lead/b.md", "/storage/lead", new Set(["a.svg"]), "tale-files")).toBe("$BB_THREAD_STORAGE/tale-files/a.svg /storage/lead/b.md");
});
