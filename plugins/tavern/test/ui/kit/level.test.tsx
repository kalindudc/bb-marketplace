// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { CharacterServiceRecord } from "../../../src/shared/service-record";
import { Crest, earnedCount, levelFor, levelOf, levelRole, levelsShown, noLevelWords, reachedInParty, reachedLevel, reachedWords } from "../../../src/ui/kit";
import { notchPath } from "../../../src/ui/kit/crest";
import { CREST_EDGE_CSS, HUE_CSS } from "../../../src/shared/heraldry";
import { recordLines } from "../../../src/ui/page/service-record";
import { fixtureCharacter, fixtureClass } from "../../../src/ui/thread/fixtures";

afterEach(cleanup);

const record = (over: Partial<CharacterServiceRecord>): CharacterServiceRecord => ({
  characterId: "juno", firstEarnedAt: 1, lastEarnedAt: 2, completeSince: null, backfilledAt: null, recordsTotal: 0, records: [], ...over,
});

describe("levelOf", () => {
  it("gives a level per eight results, and says what it counts and what's left", () => {
    expect(levelOf("warden", 9)).toMatchObject({ level: 2, toNext: 7, notches: 1, words: "Level 2 · 7 more independent checks for level 3." });
    expect(levelOf("keeper", 1)!.words).toBe("Level 1 · 7 more quests with verified work for level 2.");
    expect(levelOf("maker", 15)!.words).toBe("Level 2 · 1 more verified waypoint for level 3.");
    expect(levelOf("maker", 16)).toMatchObject({ level: 3, toNext: 8, notches: 2 });
  });
  it("has no level for nothing earned, only the plain words", () => {
    expect(levelOf("maker", 0)).toBeNull();
    expect(noLevelWords("keeper")).toBe("No quests with verified work yet");
  });
  it("never contradicts the record: a Keeper whose returns were all skipped has no level, and says so in the level's own unit", () => {
    const r = record({ keeper: { returnedQuests: 2, verifiedReturns: 0, stoppedQuests: 0, verifiedWaypoints: 0 } });
    expect(levelFor({ serviceRecords: [r] }, "juno", "keeper")).toBeNull();
    const lines = recordLines(r, Date.now()).map(l => l.parts.join(""));
    expect(lines[0]).toMatch(/^Brought back 2 quests/);
    expect(noLevelWords("keeper")).toBe("No quests with verified work yet");
  });
  it("cuts at most five notches, and none at level 1", () => {
    expect(levelOf("maker", 7)!.notches).toBe(0);
    expect(levelOf("maker", 8 * 9)!.notches).toBe(5);
  });
});

describe("reachedLevel and reachedWords", () => {
  const juno = { characterId: "juno", classId: "smith" };
  const tale = (levels: { characterId: string; role: "maker" | "warden" | "keeper"; before: number | null; after: number | null; historyComplete?: boolean }[] | null) => ({ tale: { outcome: "", left: null, skipped: [], wrappedAt: 1, levels } });
  it("says a crossing from level 2 up, as earned only when the server's history was complete", () => {
    const complete = reachedLevel(tale([{ characterId: "juno", role: "maker", before: 1, after: 2, historyComplete: true }]), juno)!;
    expect(reachedWords("Juno", complete)).toBe("Juno reached level 2 on this quest.");
    for (const historyComplete of [false, undefined]) {
      const uncertain = reachedLevel(tale([{ characterId: "juno", role: "maker", before: 2, after: 3, historyComplete }]), juno)!;
      expect(reachedWords("Juno", uncertain)).toBe("Juno was level 3 after this quest.");
    }
    expect(reachedLevel(tale([{ characterId: "juno", role: "maker", before: null, after: 2, historyComplete: true }]), juno)).toEqual({ level: 2, earned: true });
  });
  it("stays silent at level 1, when the level didn't rise, for another role, and on a legacy tale", () => {
    expect(reachedLevel(tale([{ characterId: "juno", role: "maker", before: null, after: 1, historyComplete: true }]), juno)).toBeNull();
    expect(reachedLevel(tale([{ characterId: "juno", role: "maker", before: 2, after: 2, historyComplete: true }]), juno)).toBeNull();
    expect(reachedLevel(tale([{ characterId: "juno", role: "warden", before: 1, after: 2, historyComplete: true }]), juno)).toBeNull();
    expect(reachedLevel(tale([{ characterId: "juno", role: "maker", before: 1, after: null }]), juno)).toBeNull();
    expect(reachedLevel(tale(null), juno)).toBeNull();
    expect(reachedLevel({ tale: null }, juno)).toBeNull();
    expect(reachedLevel(tale([{ characterId: "juno", role: "maker", before: 1, after: 2, historyComplete: true }]), { characterId: null, classId: "smith" })).toBeNull();
  });
});

describe("the Character levels setting", () => {
  it("hides every level when the registry says levels are off, and shows them when it's on or absent (an older server)", () => {
    const serviceRecords = [{ characterId: "juno", firstEarnedAt: 1, lastEarnedAt: 2, completeSince: null, backfilledAt: null, recordsTotal: 0, records: [], maker: { verifiedWaypoints: 19, quests: 7 } }] as never;
    expect(levelFor({ serviceRecords, levels: false }, "juno", "smith")).toBeNull();
    expect(levelFor({ serviceRecords, levels: true }, "juno", "smith")?.level).toBe(3);
    expect(levelFor({ serviceRecords }, "juno", "smith")?.level).toBe(3);
    expect([levelsShown({ levels: false }), levelsShown({ levels: true }), levelsShown({})]).toEqual([false, true, true]);
  });
});

describe("reachedInParty", () => {
  const levels = [
    { characterId: "lark", role: "maker" as const, before: 1, after: 2, historyComplete: true },
    { characterId: "lark", role: "warden" as const, before: 2, after: 3, historyComplete: false },
  ];
  const tale = { tale: { outcome: "", left: null, skipped: [], wrappedAt: 1, levels } };
  const characters = [{ id: "lark", name: "Lark" }];
  it("says a character's crossing once, in party order, with the character's own name, even when the party holds it twice", () => {
    const party = [
      { threadId: "a", characterId: "lark", classId: "ranger", displayName: "Lark" },
      { threadId: "b", characterId: "lark", classId: "smith", displayName: "Lark II" },
      { threadId: "c", characterId: "lark", classId: "warden", displayName: "Lark III" },
    ];
    const said = reachedInParty(tale, party, characters);
    expect(said.map(x => [x.member.threadId, reachedWords(x.name, x.reached)])).toEqual([
      ["a", "Lark reached level 2 on this quest."],
      ["c", "Lark was level 3 after this quest."],
    ]);
  });
  it("skips a member whose character the registry doesn't know", () => {
    expect(reachedInParty(tale, [{ threadId: "a", characterId: "lark", classId: "smith" }], [])).toEqual([]);
  });
});

describe("earnedCount", () => {
  it("counts each class from the work it is trusted for", () => {
    const r = record({
      maker: { verifiedWaypoints: 13, quests: 4 },
      warden: { checks: 11, independentChecks: 9, sameFamilyChecks: 2, caughtDefects: 1, caughtSince: null },
      keeper: { returnedQuests: 10, verifiedReturns: 9, stoppedQuests: 2, verifiedWaypoints: 31 },
    });
    expect(earnedCount(r, "maker")).toBe(13);
    // Every independent check, whatever the verdict; same-family checks never count.
    expect(earnedCount(r, "warden")).toBe(9);
    // Returned with verified work only: a quest whose optional waypoints were all skipped earns nothing.
    expect(earnedCount(r, "keeper")).toBe(9);
    expect(earnedCount(null, "maker")).toBe(0);
  });
  it("treats Rangers, Smiths and Wanderers as makers", () => {
    expect(["ranger", "smith", "wanderer"].map(levelRole)).toEqual(["maker", "maker", "maker"]);
    expect(levelRole("keeper")).toBe("keeper");
    expect(levelRole("warden")).toBe("warden");
  });
  it("reads a character's level from the registry, and none when the server sends no records", () => {
    const r = record({ warden: { checks: 11, independentChecks: 9, sameFamilyChecks: 2, caughtDefects: 0, caughtSince: null } });
    expect(levelFor({ serviceRecords: [r] }, "juno", "warden")!.level).toBe(2);
    expect(levelFor({ serviceRecords: [r] }, "juno", "smith")).toBeNull();
    expect(levelFor({}, "juno", "warden")).toBeNull();
    expect(levelFor({ serviceRecords: [r] }, null, "warden")).toBeNull();
  });
});

describe("Crest notches", () => {
  const crest = (size: number, level?: number, plain = false) => render(<Crest cls={fixtureClass} character={{ ...fixtureCharacter, plain }} size={size} level={level} />).container.querySelector("svg")!;
  it("cuts level - 1 notches through a mask, and names the level", () => {
    const svg = crest(44, 3);
    expect(svg.getAttribute("data-notches")).toBe("2");
    const id = svg.querySelector("mask")!.id;
    expect(svg.querySelector("g")!.getAttribute("mask")).toBe(`url(#${id})`);
    expect(svg.querySelector("mask path")!.getAttribute("d")!.match(/M/g)).toHaveLength(2);
    // Each V's two sides carry the keyline, clipped to the field inside the ring, so a light field still shows a drawn cut.
    const sides = svg.querySelector("g > path[stroke]")!;
    expect(sides.getAttribute("d")!.match(/M/g)).toHaveLength(2);
    expect(sides.getAttribute("d")).not.toMatch(/Z/);
    expect(svg.querySelector(`clipPath#${sides.getAttribute("clip-path")!.slice(5, -1)} path`)).not.toBeNull();
    expect(svg.getAttribute("aria-label")).toBe(`${fixtureCharacter.name}, ${fixtureClass.label}, level 3`);
  });
  it("paints the notch sides in the ring's two layers, in the ring's order: the character's hue, then the keyline", () => {
    const svg = crest(44, 3);
    const layers = [...svg.querySelectorAll("g > path")];
    const sides = layers.filter(p => p.getAttribute("fill") === "none");
    expect(sides.map(p => p.getAttribute("stroke"))).toEqual([HUE_CSS[fixtureCharacter.hue], CREST_EDGE_CSS]);
    for (const attr of ["d", "stroke-width", "clip-path", "stroke-linejoin"]) expect(new Set(sides.map(p => p.getAttribute(attr))).size).toBe(1);
    // The ring is built the same way: the hue's shape lies under the keyline ring.
    const fills = layers.map(p => p.getAttribute("fill"));
    expect(fills.indexOf(HUE_CSS[fixtureCharacter.hue])).toBeLessThan(fills.indexOf(CREST_EDGE_CSS));
    expect(layers.indexOf(sides[0]!)).toBeGreaterThan(fills.indexOf(CREST_EDGE_CSS));
  });
  it("stays plain at level 1, below 24 px and for a member with no character", () => {
    for (const svg of [crest(44, 1), crest(22, 4), crest(44, 4, true), crest(44)]) {
      expect(svg.querySelector("mask")).toBeNull();
      expect(svg.getAttribute("aria-label")).not.toMatch(/level/);
    }
  });
  it("caps the cut at five notches", () => {
    expect(crest(80, 12).getAttribute("data-notches")).toBe("5");
  });
  it("gives every crest on a page its own mask", () => {
    const view = render(<div><Crest cls={fixtureClass} character={fixtureCharacter} size={44} level={2} /><Crest cls={fixtureClass} character={fixtureCharacter} size={44} level={3} /></div>);
    const ids = [...view.container.querySelectorAll("mask")].map(m => m.id);
    expect(new Set(ids).size).toBe(2);
  });
  it("centres each shape's group of notches on its edge, a notch's width apart and 2.6 units deep", () => {
    // The shield's top edge runs through y 1.5, centred on x 12: two V notches point down to x 10.5 and 13.5, at y 4.1.
    expect(notchPath("shield", 2)).toMatch(/L10\.5 4\.1Z.*L13\.5 4\.1Z/);
    // The tower's run down its left side (x 3), into the field to x 5.6.
    expect(notchPath("tower", 1)).toMatch(/L5\.6 13Z$/);
  });
});
