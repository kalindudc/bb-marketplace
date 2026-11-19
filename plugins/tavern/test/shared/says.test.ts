// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRegistryDefinition } from "../../src/server/registry-file";
import { characterDefSchema } from "../../src/shared/schema";
import { pickLine, SPEECH_KEYS } from "../../src/shared/says";

const dir = new URL("../../characters/", import.meta.url);
const files = readdirSync(dir).filter(name => name.endsWith(".md"));
const raw = (name: string) => readFileSync(new URL(name, dir), "utf8");
const deny = /\b(?:stag(?:e|es|ed|ing)|deploy\w*|prs?|ci|code|bug\w*|servers?|tickets?|e-?mail\w*|meetings?|diffs?|sprints?|he|him|his|himself|she|her|hers|herself|they|them|their|theirs|themselves|you|your|yours|yourself|we|us|our|ours|i|me|my|mine|lads?|lass(?:es)?|sir|madam|brothers?|sisters?|men|man|women|woman)\b/i;

describe("authored lines", () => {
  it("ships twelve character files", () => expect(files).toHaveLength(12));
  it.each(files)("%s parses with three to five on-theme lines per key", name => {
    const char = parseRegistryDefinition("character", raw(name), name);
    expect(Object.keys(char.says ?? {}).sort()).toEqual([...SPEECH_KEYS].sort());
    for (const key of SPEECH_KEYS) {
      const lines = char.says![key]!;
      expect(lines.length).toBeGreaterThanOrEqual(3);
      expect(lines.length).toBeLessThanOrEqual(5);
      expect(new Set(lines).size).toBe(lines.length);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
    }
    for (const line of [...Object.values(char.lines), ...Object.values(char.says!).flat()]) {
      expect(line).not.toMatch(deny);
      expect(line.replace(/\{(?:quest|waypoint|checker|minutes)\}/g, "")).not.toMatch(/[{}]/);
    }
  });

  it("allows old files but rejects unknown slots and oversized lines or lists", () => {
    const old = raw("wren.md").replace(/\nsays:\n[\s\S]*?(?=\n---)/, "");
    const character = parseRegistryDefinition("character", old, "legacy");
    expect(character.says).toBeUndefined();
    for (const says of [{ waiting: ["Stay close."] }, { idle: ["a".repeat(61)] }, { idle: Array(6).fill("Quiet.") }]) {
      expect(characterDefSchema.safeParse({ ...character, says }).success).toBe(false);
    }
  });
});

describe("pickLine", () => {
  const key = "maker:verified:w1";
  it("is deterministic and excludes the previous rendered line", () => {
    const lines = ["Road clear.", "The lantern is lit.", "Good weather."];
    const first = pickLine(lines, key, null, {});
    expect(first).not.toBeNull();
    expect(pickLine(lines, key, null, {})).toBe(first);
    expect(lines).toContain(pickLine(lines, key, first, {}));
    expect(pickLine([first!], key, first, {})).toBeNull();
  });

  it("fills only known facts and skips lines without all of their facts", () => {
    const line = "{checker} sealed {waypoint} for {quest} in {minutes}.";
    const facts = { checker: "Vex", waypoint: "Stone Bridge", quest: "Old Road", minutes: 0 };
    expect(pickLine([line], key, null, facts)).toBe("Vex sealed Stone Bridge for Old Road in 0.");
    expect(pickLine([line, "Seal set."], key, null, { ...facts, quest: null })).toBe("Seal set.");
    expect(pickLine(["{unknown}"], key, null, {})).toBeNull();
    expect(pickLine(undefined, key, null, {})).toBeNull();
  });
});
