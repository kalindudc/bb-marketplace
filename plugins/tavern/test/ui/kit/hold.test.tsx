// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { activeHold, characterName, heldQuests, releaseWords, questMove } from "../../../src/ui/kit";
import { askSchema, checkerHandoffHoldSchema } from "../../../src/shared/schema";
import { fixtureAsk } from "../../../src/ui/thread/fixtures";
import { registry, richRoom } from "../page/scenes";

const keeper = { ...richRoom.keepers[0]!, archived: false };
const base = keeper.boardQuests.find(q => q.phase !== "done" && q.phase !== "stopped")!;
const names = { keeper: characterName(registry, keeper.member), member: (m: Parameters<typeof characterName>[1]) => characterName(registry, m) };
const hold = checkerHandoffHoldSchema.parse({ id: "hold-1", routeId: "route-1", sourceMessageId: "msg-1", sourceText: "don't hand it to a checker yet", reason: "You asked to hold the checker handoff", createdAt: 5000, release: null });
const held = { ...base, phase: "build" as const, checkerHandoffHold: hold };
const ask = (id: string, over: Record<string, unknown> = {}) => askSchema.parse({ ...fixtureAsk, id, keeperThreadId: keeper.member.threadId, boardQuestId: held.id, question: `Question ${id}?`, kind: "decision", draft: null, ...over });

describe("an active checker-handoff hold", () => {
  it("is active only while unreleased on a quest that still takes work", () => {
    expect(activeHold(held)).toBe(hold);
    expect(activeHold({ ...held, checkerHandoffHold: { ...hold, release: { at: 6000, via: "banner", askId: null } } })).toBeNull();
    for (const phase of ["done", "stopped", "stopping"] as const) expect(activeHold({ ...held, phase })).toBeNull();
    expect(activeHold({ ...held, checkerHandoffHold: undefined })).toBeNull();
  });

  it("counts once per quest, and not where the Keeper's own release ask already stands for it", () => {
    const other = { ...held, id: "other", checkerHandoffHold: { ...hold, id: "hold-2" } };
    expect(heldQuests([held, other], []).map(q => q.id)).toEqual([held.id, "other"]);
    expect(heldQuests([held, other], [ask("r", { kind: "blocker", releaseHoldId: "hold-2" })]).map(q => q.id)).toEqual([held.id]);
    // An answered release ask no longer stands for the hold.
    expect(heldQuests([other], [ask("r", { kind: "blocker", releaseHoldId: "hold-2", state: "answered" })]).map(q => q.id)).toEqual(["other"]);
  });

  it("is the user's move: one hold alone, or beside the quest's asks", () => {
    expect(questMove(held, [], names)).toEqual({ tone: "you", who: "You", next: "1 hold" });
    expect(questMove(held, [ask("a")], names)).toEqual({ tone: "you", who: "You", next: "1 ask · 1 hold" });
    expect(questMove(held, [ask("a"), ask("b")], names).next).toBe("2 asks · 1 hold");
    expect(questMove(held, [ask("g", { kind: "greenlight" })], names).next).toBe("form the party · 1 hold");
    expect(questMove(held, [ask("x", { kind: "blocker" })], names)).toEqual({ tone: "bad", who: "You", next: "blocked · 1 hold" });
  });

  it("reads the Keeper's release ask as the hold itself, not as a blocker", () => {
    const release = ask("r", { kind: "blocker", releaseHoldId: hold.id });
    expect(questMove(held, [release], names)).toEqual({ tone: "you", who: "You", next: "1 hold" });
    expect(questMove(held, [release, ask("a")], names).next).toBe("1 ask · 1 hold");
  });

  it("leaves the other moves alone: no hold, a released one, or a quest that takes no work", () => {
    const released = { ...held, checkerHandoffHold: { ...hold, release: { at: 6000, via: "page" as const, askId: null } } };
    expect(questMove(released, [], names).next).not.toMatch(/hold/);
    expect(questMove({ ...held, phase: "stopping" }, [], names).who).toBe("Stopping");
    expect(questMove(held, [], names, { keeperArchived: true }).tone).toBe("archived");
  });

  it("says how it was released, in words", () => {
    expect(releaseWords({ at: 6000, via: "banner", askId: null })).toBe("from the ask banner");
    expect(releaseWords({ at: 6000, via: "phone", askId: "r" })).toBe("by answering the Keeper's ask, from your phone");
  });
});
