// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fixtureCharacter, fixtureClass, fixtureDetail, fixtureMember, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";

afterEach(cleanup);
const load = () => loadPluginApp(definePluginApp(registerThreadSurfaces));
const wren = { ...fixtureMember, threadId: "member-1", role: "member" as const, keeperThreadId: "keeper-1", boardQuestId: "vault" };
const message = { id: "m1", threadId: "keeper-1", turnId: null, projectId: null };
// 16 returned, but only 9 with verified work: the level counts the 9.
const record = { characterId: "wren", firstEarnedAt: 1, lastEarnedAt: 2, completeSince: null, backfilledAt: null, recordsTotal: 0, records: [], keeper: { returnedQuests: 16, verifiedReturns: 9, stoppedQuests: 0, verifiedWaypoints: 30 } };
const withRecords = { ...fixtureRegistry, serviceRecords: [record] };

type TaleLevel = { characterId: string; role: "maker" | "warden" | "keeper"; before: number | null; after: number | null; historyComplete?: boolean };
const juno = { ...fixtureMember, threadId: "member-2", role: "member" as const, keeperThreadId: "keeper-1", boardQuestId: "vault", characterId: "juno", classId: "smith" };
async function card(kind: "tavern-party" | "tavern-tale", registry: object, levels?: TaleLevel[] | null, members: (typeof wren)[] = [wren]) {
  const app = await load();
  const directive = app.messageDirectives.find(d => d.id === kind)!;
  const tale = { outcome: "Brought it back.", left: null, skipped: [], wrappedAt: 1, levels: levels ?? null };
  const detail = { ...fixtureDetail, ...(levels !== undefined ? { tale } : {}), quest: { ...fixtureDetail.quest, phase: kind === "tavern-tale" ? "done" as const : fixtureDetail.quest.phase, members } };
  return renderSlot(directive, { attributes: { quest: "vault" }, source: kind, message, openWorkspaceFile: null }, { rpc: { boardQuest: () => detail, registry: () => registry, crests: () => ({ crests: [] }) } });
}

describe("levels on the chat cards", () => {
  it("notches the party card's crest and puts the level's words in its tooltip", async () => {
    const slot = await card("tavern-party", withRecords);
    const crest = await slot.findByRole("img", { name: "Wren, Keeper, level 2" });
    expect(crest.getAttribute("data-notches")).toBe("1");
    expect(crest.closest("button")!.title).toBe("Open Wren’s thread · Level 2 · 7 more quests with verified work for level 3.");
    slot.lifecycle.unmount();
  });
  it("notches the tale card's crests at 24 px and names the level", async () => {
    const slot = await card("tavern-tale", withRecords);
    const button = await slot.findByRole("button", { name: "Open Wren’s thread, Keeper (lead), level 2" });
    expect(button.querySelector("svg")!.getAttribute("width")).toBe("24");
    expect(button.querySelector("svg")!.getAttribute("data-notches")).toBe("1");
    slot.lifecycle.unmount();
  });
  it("says who reached a level on the tale card, in the tale page's words, and stays silent otherwise", async () => {
    const levels: TaleLevel[] = [
      { characterId: "wren", role: "keeper", before: 1, after: 2, historyComplete: true },
      { characterId: "juno", role: "maker", before: 2, after: 3, historyComplete: false },
    ];
    const smith = { ...fixtureClass, id: "smith", label: "Smith", plain: "builder", characters: ["juno"] };
    const party = { ...withRecords, classes: [fixtureClass, smith], characters: [fixtureCharacter, { ...fixtureCharacter, id: "juno", name: "Juno", classes: ["smith"] }] };
    const slot = await card("tavern-tale", party, levels, [wren, juno]);
    const list = await slot.findByRole("list", { name: "Levels reached on this quest" });
    expect([...list.querySelectorAll("li")].map(li => li.textContent)).toEqual(["Wren reached level 2 on this quest.", "Juno was level 3 after this quest."]);
    expect(list.closest(".tale-foot")).toBeNull();
    slot.lifecycle.unmount();
    for (const quiet of [null, [{ characterId: "wren", role: "keeper" as const, before: null, after: 1, historyComplete: true }], [{ characterId: "wren", role: "keeper" as const, before: 2, after: 2, historyComplete: true }]]) {
      const s = await card("tavern-tale", withRecords, quiet);
      await s.findByText("Brought it back.");
      expect(s.queryByRole("list", { name: "Levels reached on this quest" })).toBeNull();
      s.lifecycle.unmount();
    }
  });
  it("says one crossing once when the party holds the same character twice, with the character's own name", async () => {
    const wrenII = { ...wren, threadId: "member-3", displayName: "Wren II" };
    const slot = await card("tavern-tale", withRecords, [{ characterId: "wren", role: "keeper", before: 1, after: 2, historyComplete: true }], [wrenII, wren]);
    const list = await slot.findByRole("list", { name: "Levels reached on this quest" });
    expect([...list.querySelectorAll("li")].map(li => li.textContent)).toEqual(["Wren reached level 2 on this quest."]);
    slot.lifecycle.unmount();
  });
  it("shows no level on either card when the Character levels setting is off", async () => {
    const off = { ...withRecords, levels: false };
    const party = await card("tavern-party", off);
    const crest = await party.findByRole("img", { name: "Wren, Keeper" });
    expect(crest.getAttribute("data-notches")).toBeNull();
    expect(crest.closest("button")!.title).toBe("Open Wren’s thread");
    party.lifecycle.unmount();
    const tale = await card("tavern-tale", off, [{ characterId: "wren", role: "keeper", before: 1, after: 2, historyComplete: true }]);
    await tale.findByText("Brought it back.");
    expect(tale.queryByRole("list", { name: "Levels reached on this quest" })).toBeNull();
    expect(tale.getByRole("button", { name: "Open Wren’s thread, Keeper (lead)" })).toBeTruthy();
    tale.lifecycle.unmount();
  });
  it("keeps crests plain with no records from the server", async () => {
    const slot = await card("tavern-party", fixtureRegistry);
    const crest = await slot.findByRole("img", { name: "Wren, Keeper" });
    expect(crest.getAttribute("data-notches")).toBeNull();
    expect(crest.closest("button")!.title).toBe("Open Wren’s thread");
    slot.lifecycle.unmount();
  });
});
