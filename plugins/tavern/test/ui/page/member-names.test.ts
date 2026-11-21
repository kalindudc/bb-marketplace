import { describe, expect, it } from "vitest";
import type { Member } from "../../../src/shared/schema";
import { describeEvent, eventContext, namedDetail } from "../../../src/ui/page/model";
import { questLabels } from "../../../src/ui/page/machines-model";
import * as scenes from "./scenes";

// Members a Keeper hires with no character carry characterId null (Peter's contract); the page names them by class, never blank or by id.
const unnamed = (base: Member, extra: Partial<Member> = {}): Member => ({ ...base, characterId: null, displayName: undefined, ...extra });

describe("page names for members", () => {
  const smith = unnamed(scenes.juno, { threadId: "thr_smith1" });
  const room = { ...scenes.richRoom, keepers: scenes.richRoom.keepers.map((k, i) => i === 0 ? { ...k, boardQuests: k.boardQuests.map((q, j) => j === 0 ? { ...q, members: [...q.members, smith] } : q) } : k) };
  const ctx = eventContext(room, scenes.registry);
  const event = (type: string, data: Record<string, unknown>, text = "") => ({ id: 1, at: 1, keeperThreadId: room.keepers[0]!.member.threadId, boardQuestId: null, type, text, data, actor: { kind: "tavern" as const } });

  it("uses the class when there is no character and still names the Keeper", () => {
    expect(describeEvent(event("member.hired", { memberThreadId: smith.threadId }), ctx)!.head).toBe("hired Smith, Wren's Smith");
    expect(describeEvent(event("member.told", { memberThreadId: smith.threadId }), ctx)!.head).toBe("re-briefed Smith, Wren's Smith");
  });
  it("names a member and their Keeper in an event's detail, not by thread id", () => {
    expect(namedDetail(`Waiting on ${smith.threadId} for the diff`, null, ctx)).toBe("Waiting on Smith, Wren's Smith for the diff");
  });
  it("prefers the display name to the character's name", () => {
    expect(ctx.memberName(unnamed(scenes.juno, { displayName: "Juno II" }))).toBe("Juno II, Wren's Smith");
    expect(ctx.memberName(scenes.juno)).toBe("Juno, Wren's Smith");
  });
  it("names twin quests' Keepers by their character's name when the registry is known, not by the raw id", () => {
    const [k] = scenes.richRoom.keepers;
    const keeper = { ...k!, member: { ...k!.member, displayName: undefined } };
    const twin = { ...keeper, member: { ...keeper.member, threadId: "thr-twin" }, boardQuests: keeper.boardQuests.slice(0, 1).map((q) => ({ ...q, id: "twin-q" })) };
    const labels = questLabels({ ...scenes.richRoom, keepers: [{ ...keeper, boardQuests: keeper.boardQuests.slice(0, 1) }, twin] }, Date.now(), scenes.registry);
    const name = scenes.registry.characters.find((c) => c.id === keeper.member.characterId)!.name;
    for (const label of labels.values()) expect(label).toContain(name);
  });
});
