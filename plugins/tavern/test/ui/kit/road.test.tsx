// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PartyPicture, characterName, hearthWords, onTheRoad, questMove, type KeeperStatus } from "../../../src/ui/kit";
import { checkerHandoffHoldSchema } from "../../../src/shared/schema";
import { registry, richRoom } from "../page/scenes";

afterEach(cleanup);
const keeper = richRoom.keepers.find(k => k.boardQuests.some(q => q.plan && q.waypoints.length > 0))!;
const quest = keeper.boardQuests.find(q => q.plan && q.waypoints.length > 0)!;
const member0 = richRoom.keepers.flatMap(k => [...k.boardQuests.flatMap(q => q.members), ...k.errands])[0]!;
type M = typeof member0;
const m = (threadId: string, state: M["state"], over: Partial<M> = {}): M => ({ ...member0, threadId, state, ...over });
const names = { keeper: characterName(registry, keeper.member), member: (x: M) => characterName(registry, x) };

describe("onTheRoad", () => {
  it("counts working members and working errand helpers once each, across every Keeper", () => {
    const room = { keepers: [
      { ...keeper, boardQuests: [{ ...quest, members: [m("a", "working"), m("b", "done"), m("c", "idle")] }, { ...quest, id: "q2", members: [m("a", "working"), m("d", "working"), m("e", "failed")] }], errands: [m("f", "working"), m("g", "done")] },
      { ...keeper, member: { ...keeper.member, threadId: "k2" }, boardQuests: [{ ...quest, members: [m("h", "waiting"), m("i", "stopped")] }], errands: [m("j", "working")] },
    ] };
    expect(onTheRoad(room)).toBe(4);
    expect(onTheRoad({ keepers: [] })).toBe(0);
  });
});

describe("PartyPicture places members by their state, never the stored place", () => {
  it("draws a done member stored at the table under Resting, a working one under On the road, and an idle one at the table", () => {
    const members = [m("done-1", "done", { place: "table" }), m("work-1", "working", { place: "table" }), m("idle-1", "idle", { place: "road" }), m("stop-1", "stopped", { place: "road" })];
    const { container } = render(<div className="tavern"><PartyPicture members={members} registry={registry} /></div>);
    const zone = (place: string) => container.querySelector(`.zone.${place}`) as HTMLElement;
    const ids = (place: string) => [...zone(place).querySelectorAll<HTMLElement>("[data-member]")].map(e => e.dataset.member);
    expect(ids("rest")).toEqual(["done-1", "stop-1"]);
    expect(ids("road")).toEqual(["work-1"]);
    expect(ids("table")).toEqual(["idle-1"]);
    // data-place drives the sets-out cue, so it follows the state too.
    for (const e of container.querySelectorAll<HTMLElement>("[data-member]")) expect(e.closest(".zone")!.classList.contains(e.dataset.place!)).toBe(true);
  });
});

describe("the hearth, lit while the party works", () => {
  const st = (...tones: KeeperStatus["tone"][]) => tones.map(tone => ({ tone }));
  const line = (w: { lead: string; detail: string }) => `${w.lead} · ${w.detail}`;
  it("is lit while a Keeper is busy or a member is on the road, in Tony's words", () => {
    expect(line(hearthWords(st("busy", "holding"), { onRoad: 2 }))).toBe("Lit · 1 Keeper busy · 2 on the road");
    expect(line(hearthWords(st("busy", "busy", "idle"), { onRoad: 1 }))).toBe("Lit · 2 Keepers busy · 1 on the road");
    expect(line(hearthWords(st("holding", "idle"), { onRoad: 2 }))).toBe("Lit · 2 on the road");
    expect(hearthWords(st("holding"), { onRoad: 1 }).state).toBe("working");
    expect(line(hearthWords(st("busy", "holding"), { onRoad: 0 }))).toBe("Lit · 1 Keeper busy");
    expect(line(hearthWords(st("holding", "quiet", "idle"), { onRoad: 0 }))).toBe("Banked · nobody at work");
    expect(line(hearthWords(st(...Array(9).fill("holding")), { onRoad: 0 }))).toBe("Banked · nobody at work");
  });
  it("keeps closing time's words and the not-lit words, and never says a total", () => {
    expect(line(hearthWords(st("busy"), { onRoad: 3, away: { closed: true, until: null, dueBack: false } }))).toBe("Out · closed");
    expect(line(hearthWords([], { onRoad: 0 }))).toBe("Not lit yet · no Keeper");
    expect(line(hearthWords(st("archived"), { onRoad: 0 }))).toBe("Not lit · no active Keeper");
    for (const w of [hearthWords(st("busy", "idle"), { onRoad: 1 }), hearthWords(st("busy"), { onRoad: 0 })]) expect(w.detail).not.toMatch(/\bof\b/);
  });
});

describe("questMove on a reported waypoint: the check, never the maker at work", () => {
  const maker = m("maker-1", "done", { classId: "smith" });
  const reported = (over: Partial<typeof quest> = {}) => ({ ...quest, phase: "check" as const, ...over, waypoints: quest.waypoints.map((w, i) => i === 0 ? { ...w, state: "reported" as const, actor: "agent" as const, ownerMember: maker } : { ...w, state: "planned" as const }) });
  it("names the Keeper to find a checker when no Warden works on it", () => {
    const move = questMove(reported({ members: [maker] }), [], names);
    expect(move).toMatchObject({ tone: "keeper", who: names.keeper, verb: "find a checker for", task: quest.waypoints[0]!.title });
  });
  it("names the working Warden, checking, when one is on it", () => {
    const warden = m("warden-1", "working", { classId: "warden", checkerWaypointId: quest.waypoints[0]!.id });
    const move = questMove(reported({ members: [maker, warden] }), [], names);
    expect(move).toMatchObject({ tone: "work", who: names.member(warden), verb: "checking", task: quest.waypoints[0]!.title });
  });
  it("is the user's move while a checker-handoff hold waits", () => {
    const hold = checkerHandoffHoldSchema.parse({ id: "h1", routeId: "r1", sourceMessageId: "s1", sourceText: "wait", reason: "You asked to wait", createdAt: 1, release: null });
    expect(questMove(reported({ members: [maker], checkerHandoffHold: hold }), [], names)).toEqual({ tone: "you", who: "You", next: "1 hold" });
  });
});
