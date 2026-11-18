// @vitest-environment node
import { seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { tags } from "../../src/shared/contract";
import { setup } from "./runtime-fixture";
import { makeThreadResponse } from "./host";

function ask(f: ReturnType<typeof setup>, keeperId = "lead", boardQuestId: string | null = null) {
  return f.k.ask(keeperId, { boardQuestId, kind: "decision", question: "Use the private draft?", why: "A reversible choice", options: [{ id: "yes", label: "Use it", detail: "", recommended: true }], meanwhile: "Keep reading", holds: [], reversible: true, proceedInMinutes: 1 });
}
describe("archived Keeper asks", () => {
  it("withdraws every open ask with an attributed receipt, preserving answered history and other Keepers", async () => {
    const f = setup();
    const q = await seedQuest(f.k,"lead", "A", "A");
    const local = ask(f), questAsk = ask(f, "lead", q.id), answered = ask(f);
    f.k.answerAsk(answered.id, "yes", "Approved", "page", "user");
    f.k.bind("other", "keeper", "moss", "project");
    const other = ask(f, "other");
    vi.mocked(f.bb.rpc.experimental_invalidate).mockClear();
    await f.runtime.threadLifecycle("thread.archived", { thread: makeThreadResponse({ id: "lead", archivedAt: f.time() }), actor: { kind: "user" } });
    for (const entry of [local, questAsk]) {
      expect(f.k.store.get("asks", entry.id)).toMatchObject({ state: "withdrawn", answer: null });
      const receipt = f.k.store.events("lead").find(event => event.type === "ask.withdrawn" && event.data.askId === entry.id)!;
      expect(receipt.actor).toEqual({ kind: "user" });
      expect(receipt.text).toContain("archived");
      expect(receipt.boardQuestId).toBe(entry.boardQuestId);
    }
    expect(f.k.store.get("asks", answered.id)).toMatchObject({ state: "answered", answer: { note: "Approved" } });
    expect(f.k.store.get("asks", other.id)?.state).toBe("open");
    expect(f.k.store.openAsks("lead")).toEqual([]);
    expect(vi.mocked(f.bb.rpc.experimental_invalidate).mock.calls.flat(2)).toContain(tags.boardQuest(q.id));
    await f.runtime.threadLifecycle("thread.archived", { thread: makeThreadResponse({ id: "lead", archivedAt: f.time() }) });
    expect(f.k.store.events("lead").filter(event => event.type === "ask.withdrawn")).toHaveLength(2);
  });
  it("never restores archived asks on unarchive, applies their defaults, or accepts stale cards", async () => {
    const f = setup(), entry = ask(f);
    await f.runtime.threadLifecycle("thread.archived", { thread: makeThreadResponse({ id: "lead", archivedAt: f.time() }) });
    f.advance(120_000);
    f.k.defaults();
    await f.runtime.threadLifecycle("thread.unarchived", { thread: makeThreadResponse({ id: "lead", archivedAt: null }) });
    expect(f.k.store.get("asks", entry.id)).toMatchObject({ state: "withdrawn", answer: null });
    expect(() => f.k.answerAsk(entry.id, "yes", null, "page", "user")).toThrow("no longer open");
    expect(f.k.store.events("lead").filter(event => event.type === "ask.defaulted")).toEqual([]);
    expect(ask(f).state).toBe("open");
  });
  it("does not withdraw the Keeper's asks when only a member is archived", async () => {
    const f = setup(), entry = ask(f);
    f.k.bind("scout", "ranger", "pip", "project");
    await f.runtime.threadLifecycle("thread.archived", { thread: makeThreadResponse({ id: "scout", archivedAt: f.time() }) });
    expect(f.k.store.get("asks", entry.id)?.state).toBe("open");
  });
  it("reconciles archived Keepers missed while unloaded and drains more than one indexed page", async () => {
    const f = setup(), entry = ask(f);
    for (let i = 0; i < 503; i++) f.k.store.put("asks", `extra-${i}`, { ...entry, id: `extra-${i}` });
    f.bb.sdk.threads.get = async ({ threadId }) => makeThreadResponse({ id: threadId, archivedAt: f.time() });
    await f.runtime.reconcile();
    const count = () => (f.k.store.db.prepare("SELECT COUNT(*) AS n FROM tavern_records WHERE kind='asks' AND json_extract(data,'$.state')='open'").get() as { n: number }).n;
    expect(count()).toBe(0);
    const receipts = () => (f.k.store.db.prepare("SELECT COUNT(*) AS n FROM tavern_events WHERE type='ask.withdrawn'").get() as { n: number }).n;
    expect(receipts()).toBe(504);
    await f.runtime.reconcile();
    expect(receipts()).toBe(504);
  });
});
