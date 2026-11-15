import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registrySchema } from "../../../src/shared/contract";

// The Character voice row was once hidden because nothing read the setting. The server honours it again (registry.voice), so
// the page offers it, and its history label still reads "Character voice". The row's behaviour is tested in insights.test.tsx.
describe("the settings page", () => {
  it("offers a Character voice row only because the server reads the setting", () => {
    expect(registrySchema.shape.voice).toBeDefined();
    const source = readFileSync("src/ui/page/settings.tsx", "utf8");
    expect(source).toMatch(/<Row label="Character voice"/);
    expect(source).toMatch(/"tavern\.voice": "Character voice"/);
  });
});
