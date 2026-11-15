// @vitest-environment node
import { seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";

const input = {
  classId: "ranger",
  errand: true,
  title: "Scout: plugin folders vs README",
  brief: {
    outcome: "Read",
    mode: "make-it-work" as const,
    outOfScope: "Writes",
    doneWhen: "Report",
    context: [],
    questions: ["1. What failed?"],
    timeboxMinutes: 5,
  },
};
async function hiredTitle(
  f: ReturnType<typeof setup>,
  options: Parameters<typeof f.runtime.hire>[2] = input,
) {
  const member = await f.runtime.hire("lead", "project", options);
  const name = f.runtime
    .snapshot()
    .characters.find((character) => character.id === member.characterId)!.name;
  const args = f.harness.inspection.sdk.callsTo("threads.spawn")[0]!.args[0] as { title: string };
  return { name, title: args.title };
}
describe("member thread titles", () => {
  it.each([
    "Ranger",
    "Scout",
    "Smith",
    "Builder",
    "Warden",
    "Checker",
    "Wanderer",
    "Keeper",
    "General",
  ])("strips a leading %s role prefix from side-quest helpers", async (prefix) => {
    const { name, title } = await hiredTitle(setup(), {
      ...input,
      title: `${prefix}: plugin folders vs README`,
    });
    expect(title).toBe(`${name} · plugin folders vs README`);
  });
  it("uses the same format for a board-quest party member", async () => {
    const f = setup(),
      q = await seedQuest(f.k,"lead", "Read the tree", "Tree");
    const { name, title } = await hiredTitle(f, { ...input, errand: false, boardQuestId: q.id });
    expect(title).toBe(`${name} · plugin folders vs README`);
  });
  it("recognizes registered class ids, labels and plain names without treating punctuation as regex", async () => {
    for (const prefix of ["pathfinder", "R&D [Scout]", "trail finder"]) {
      const f = setup(),
        snapshot = f.runtime.snapshot(),
        ranger = snapshot.classes.find((role) => role.id === "ranger")!;
      vi.spyOn(f.runtime, "snapshot").mockReturnValue({
        ...snapshot,
        classes: [
          ...snapshot.classes,
          { ...ranger, id: "pathfinder", label: "R&D [Scout]", plain: "trail finder" },
        ],
      });
      const { name, title } = await hiredTitle(f, {
        ...input,
        title: `${prefix}: follow the trail`,
      });
      expect(title).toBe(`${name} · follow the trail`);
    }
  });
  it("collapses whitespace and strips repeated case-insensitive prefixes", async () => {
    const { name, title } = await hiredTitle(setup(), {
      ...input,
      title: "  sCoUt  : Ranger:  plugin\n folders\tvs README  ",
    });
    expect(title).toBe(`${name} · plugin folders vs README`);
  });
  it("keeps meaningful colons that do not follow role words", async () => {
    const { name, title } = await hiredTitle(setup(), {
      ...input,
      title: "Compare: folders vs README",
    });
    expect(title).toBe(`${name} · Compare: folders vs README`);
  });
  it("caps the complete title at 60 Unicode characters, with an ellipsis", async () => {
    const { title } = await hiredTitle(setup(), {
      ...input,
      title: `Scout: ${"🔎 folders ".repeat(20)}`,
    });
    expect(Array.from(title).length).toBeLessThanOrEqual(60);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });
  it("makes an empty task explicit after removing a role prefix", async () => {
    const { name, title } = await hiredTitle(setup(), { ...input, title: "Scout:  " });
    expect(title).toBe(`${name} · Untitled task`);
  });
});
