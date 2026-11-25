// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { LIMIT_FIELDS } from "../../src/shared/limits";
import { DEFAULT_SETTINGS, isGuardrailSetting, settingsSchema } from "../../src/shared/settings";
import { decodeSettingsToml, snake } from "../../src/server/settings/format";
import { parse } from "smol-toml";
import { placementSettingsSchema } from "../../src/shared/placement-settings";

const skill = (file: string) => readFileSync(new URL(`../../skills/tavern/${file}`, import.meta.url), "utf8");

it("documents each fixed reference key exactly once and gives its current default", () => {
  const expected = Object.entries(settingsSchema.shape).flatMap(([group, schema]) => {
    if (group === "limits") return [];
    const section = schema.unwrap();
    if (section instanceof z.ZodRecord)
      return Object.keys((section.valueType as z.ZodObject).shape).map(key => [`${group}.<id>.${snake(key)}`, "Inherits"]);
    const defaults = DEFAULT_SETTINGS[group as keyof typeof DEFAULT_SETTINGS] as Record<string, unknown>;
    return Object.keys((section as z.ZodObject).shape).map(key => [`${group}.${snake(key)}`, `\`${JSON.stringify(defaults[key])}\``]);
  });
  const entries = [...skill("references/settings.md").matchAll(/^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map(([, key, description, value, authority]) => ({ key, description: description!.trim(), value: value!.trim(), authority: authority!.trim() }));
  expect(entries.map(entry => [entry.key, entry.value]).sort()).toEqual(expected.sort());
  for (const entry of entries) {
    expect(entry.description).not.toBe("");
    const key = entry.key!.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    const consent = ["keepers.alwaysAsk", "away.neverWhileClosed", "machines.forges", "scopes.sendTools", "tavern.gitProgram", "tavern.piProgram", "tavern.speechExtensions", "tavern.speechInstructions", "tavern.speechRecentMessages"];
    expect(entry.authority).toMatch(/^User\b/);
    expect(entry.authority.includes("Plain")).toBe(isGuardrailSetting(key) && !consent.includes(key));
    expect(entry.authority.includes("Granted")).toBe(!isGuardrailSetting(key));
  }
});

it("points agents to live settings and documents each protective limit", () => {
  const reference = skill("references/settings.md");
  expect(reference).toContain("`bb tavern settings get limits`");
  const expected = Object.entries(LIMIT_FIELDS).flatMap(([group, fields]) =>
    Object.keys(fields).map(key => `limits.${group}.${key}`));
  const documented = [...reference.matchAll(/^\| `(limits\.[^`]+)`(?: \(Advanced\))? \|/gm)].map(match => match[1]);
  expect(documented.sort()).toEqual(expected.sort());
  expect(expected.every(isGuardrailSetting)).toBe(true);
});

it("shows a valid disabled rule with each consent switch off", () => {
  const examples = [...skill("references/settings.md").matchAll(/```toml\n([\s\S]*?)```/g)].map(match => match[1]).join("\n");
  const settings = placementSettingsSchema.parse(decodeSettingsToml(parse(examples)).machines);
  expect(settings.rules).toMatchObject([{
    enabled: false, consent: { guardInstall: false, remoteDetectionOnly: false, linuxUncontainedChecks: false },
    target: { environmentProviderId: "checkout-provider", machine: { machineProviderId: "machine-provider" } },
  }]);
});

it("asks the user to test the alert route during setup", () => {
  const setup = skill("references/setup.md");
  expect(setup).toContain("Send a test alert");
  expect(setup).toContain("It arrived");
  expect(setup).toContain("It did not");
});
