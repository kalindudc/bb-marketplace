// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JOURNAL_INSTRUCTIONS } from "../../src/server/journal";

const skill = readFileSync(new URL("../../skills/journal/SKILL.md", import.meta.url), "utf8");

describe("journal guidance for coordinators", () => {
  it("adds one short pointer to every thread's instructions and keeps the rules in the skill", () => {
    const lines = JOURNAL_INSTRUCTIONS.split("\n");
    const pointer = lines.filter((l) => /delegat/i.test(l) && /Coordinating other agents/.test(l));
    expect(pointer).toHaveLength(1);
    expect(pointer[0]!.length).toBeLessThanOrEqual(120);
    // Every bb thread reads these instructions: the pointer may grow them by one line only.
    expect(lines).toHaveLength(8);
    expect(Buffer.byteLength(JOURNAL_INSTRUCTIONS)).toBeLessThan(1800);
  });
  it("gives the coordinating rules in the skill", () => {
    const section = skill.split("## Coordinating other agents")[1]?.split("\n## ")[0] ?? "";
    for (const rule of [/one entry per delegated deliverable/i, /owner/i, /same turn/i, /one parent per round/i, /umbrella/i, /note/i]) expect(section).toMatch(rule);
    expect(skill).toMatch(/`start` \| `id`, optional `owner` \| Set doing\. With `owner`, hands the entry over in one call\. Your other unowned doing entry returns to todo; entries with an owner stay doing/);
    for (const action of ["settle", "wait"]) expect(skill).toMatch(new RegExp(`\\| \`${action}\` \\|`));
    expect(section).toMatch(/Going idle is not finishing/);
  });
});
