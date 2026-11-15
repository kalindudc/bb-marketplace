import { describe, expect, it } from "vitest";
import { decodePageRoute, graphFor, levelFromWins, visibleMembers, waypointMove, openAskCount, describeEvent, eventContext } from "../../../src/ui/page/model";
import { detail, emptyRoom, registry, room } from "../../../src/ui/page/fixtures";
import { boardQuestDetailSchema, registrySchema, roomSchema } from "../../../src/shared/contract";

describe("Tavern page data", () => {
  it("names a retelling in human words", () => {
    expect(describeEvent({ id: 1, at: 1, keeperThreadId: null, boardQuestId: null, type: "quest.retold", text: "Updated delivery", data: {}, actor: { kind: "tavern" } }, eventContext(room, registry))?.head).toBe("retold the tale");
  });
  it.each(["journal.changed", "questlog.changed"])("keeps %s churn out of the visible history", type => {
    expect(describeEvent({ id: 1, at: 1, keeperThreadId: null, boardQuestId: null, type, text: "changed", data: {}, actor: { kind: "tavern" } }, eventContext(room, { characters: [], classes: [] }))).toBeNull();
  });
  it("keeps the development fixtures valid at the RPC boundary", () => {
    expect(roomSchema.parse(room)).toEqual(room);
    expect(roomSchema.parse(emptyRoom)).toEqual(emptyRoom);
    expect(registrySchema.parse(registry)).toEqual(registry);
    expect(boardQuestDetailSchema.parse(detail)).toEqual(detail);
  });
  it("decodes each route segment without allowing malformed or extra segments", () => {
    expect(decodePageRoute("quest/vault%20cutover")).toEqual({ kind: "quest", id: "vault cutover" });
    expect(decodePageRoute("quest/%E0%A4")).toEqual({ kind: "missing" });
    expect(decodePageRoute("quest/vault/extra")).toEqual({ kind: "missing" });
    expect(decodePageRoute("classes")).toEqual({ kind: "classes" });
  });
  it("levels come from verified wins, not work volume or reports", () => {
    expect([0, 7, 8, 15, 16, 31, 32, 39, 40].map(levelFromWins)).toEqual([1, 1, 2, 2, 3, 4, 5, 5, 6]);
    expect(visibleMembers(room).filter((m) => m.threadId === "smith")).toHaveLength(1);
  });
  it("counts only open asks for the navigation badge", () => {
    expect(openAskCount(room)).toBe(1);
    expect(openAskCount({ ...room, asks: room.asks.map((ask) => ({ ...ask, state: "answered" })) })).toBe(0);
  });
  it("groups by whose move, not just by status", () => {
    expect(detail.quest.waypoints.map(waypointMove)).toEqual(["Done", "Waiting on others", "Your next moves"]);
  });
  it("builds the connection picture from real quest ownership, asks and outside gates", () => {
    const graph = graphFor(room, registry);
    expect(graph.nodes.some((node) => node.label === "Luc")).toBe(true);
    expect(graph.nodes.some((node) => node.id === "ask:send")).toBe(true);
    expect(graph.edges).toContainEqual(["member:smith", "outside:vault:w2"]);
    expect(graph.edges.every(([a, b]) => graph.nodes.some((n) => n.id === a) && graph.nodes.some((n) => n.id === b))).toBe(true);
  });
});
