// @vitest-environment node
import { seedQuest } from "./support";
import { describe, expect, it } from "vitest";
import { setup } from "./runtime-fixture";
import { readAwayDigest } from "../../src/server/away/digest";

const explicit = { kind: "explicit-return" as const, threadId: null, refId: null };
function ask(f: ReturnType<typeof setup>, questId: string, question: string) {
  return f.k.ask("lead", { effect: {type:"decision"}, boardQuestId: questId, kind: "production", question, why: "Needs you", options: [{ id: "wait", label: "Wait", detail: "Stay safe", recommended: true }], meanwhile: "Private drafts", holds: [] });
}

describe("Closing time digest", () => {
  it("has an honest empty state before the first close", () => {
    const f = setup();
    expect(readAwayDigest(f.k, f.runtime.away.store, {})).toMatchObject({ window: null, totalEvents: 0, events: [], asks: [], quests: [] });
  });
  it("includes only activity within event boundaries despite clock rollback and later work", async () => {
    const f = setup(), q = await seedQuest(f.k,"lead", "Draft", "Draft");
    f.runtime.away.store.close({ revision: 0, until: f.time() + 60_000, quests: [{ questId: q.id, endState: "drafts-ready" }] });
    f.advance(-1000);
    const included = f.k.store.event(f.time(), "lead", q.id, "report.filed", "Draft ready");
    f.runtime.away.store.finish(f.runtime.away.store.snapshot().window!.id, explicit);
    f.k.store.event(f.time(), "lead", q.id, "report.filed", "Later report");
    const result = readAwayDigest(f.k, f.runtime.away.store, {});
    expect(result.events.map(event => event.text)).toEqual(["Draft ready"]);
    expect(result.quests).toEqual([{ questId: q.id, title: "Draft", short: "Draft", missing: false, events: 1, reports: 1, decisions: 0, asks: 0 }]);
    expect(result.totalEvents).toBe(1);
    expect(included).toBeTruthy();
  });
  it("remembers asks already waiting at close and distinguishes those still waiting on return", async () => {
    const f = setup(), q = await seedQuest(f.k,"lead", "Draft", "Draft"), before = ask(f, q.id, "Already waiting?");
    f.runtime.away.store.close({ revision: 0, until: f.time() + 60_000, quests: [{ questId: q.id, endState: "pause" }] });
    const during = ask(f, q.id, "Waiting during?");
    f.k.answerAsk(before.id, "wait", null, "page", "user");
    f.runtime.away.store.finish(f.runtime.away.store.snapshot().window!.id, explicit);
    ask(f, q.id, "Asked after return?");
    f.k.answerAsk(during.id, "wait", null, "page", "user");
    const result = readAwayDigest(f.k, f.runtime.away.store, {});
    expect(result.totalAsks).toBe(2);
    expect(result.asks.find(row => row.ask.id === before.id)).toMatchObject({ waitingAtEnd: false });
    expect(result.asks.find(row => row.ask.id === during.id)).toMatchObject({ waitingAtEnd: true, ask: { state: "answered" } });
    expect(result.quests[0]?.asks).toBe(2);
  });
  it("pages events and asks without silently losing totals", async () => {
    const f = setup(), q = await seedQuest(f.k,"lead", "Draft", "Draft");
    f.runtime.away.store.close({ revision: 0, until: f.time() + 60_000, quests: [{ questId: q.id, endState: "pause" }] });
    const one = ask(f, q.id, "First?"), two = ask(f, q.id, "Second?");
    f.runtime.away.store.finish(f.runtime.away.store.snapshot().window!.id, explicit);
    const first = readAwayDigest(f.k, f.runtime.away.store, { limit: 1 });
    const second = readAwayDigest(f.k, f.runtime.away.store, { limit: 1, cursor: first.nextCursor!, askCursor: first.nextAskCursor });
    expect(first.totalEvents).toBe(2);
    expect(first.totalAsks).toBe(2);
    expect(first.nextCursor).not.toBeNull();
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.asks, ...second.asks].map(row => row.ask.id))).toEqual(new Set([one.id, two.id]));
  });
});
