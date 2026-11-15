// @vitest-environment node
import type { z } from "zod";
import { describe, expect, it } from "vitest";
import { validatePlacementInputs } from "../../src/server/placement/inputs";
import { providerInputsSchema } from "../../src/shared/placement-settings";

type Json = z.infer<typeof providerInputsSchema>;
const owner = (inputs: Json | null, acceptsEmptyInputs = false) => ({ id: "vendor", inputs, acceptsEmptyInputs });
const substitutions = {
  "keeper.branch": "feature/source", "source.commit": "a".repeat(40),
  "member.branch": "tavern/member-1", "quest.id": "quest-1",
};

describe("opaque placement provider inputs", () => {
  it("keeps omitted input distinct from explicit null and a provider's missing schema", () => {
    expect(validatePlacementInputs(owner(null, true), undefined)).toEqual({
      state: "valid", inputs: null, supplied: false, method: "advertised-empty",
    });
    expect(validatePlacementInputs(owner(null, true), null)).toMatchObject({ state: "invalid" });
    expect(validatePlacementInputs(owner({ type: "null" }), null)).toEqual({
      state: "valid", inputs: null, supplied: true, method: "json-schema-subset",
    });
    expect(validatePlacementInputs(owner({ type: "null" }), undefined)).toMatchObject({ state: "invalid" });
  });

  it("uses advertised empty acceptance instead of inventing object inputs or defaults", () => {
    expect(validatePlacementInputs(owner({ type: "object" }, true), undefined)).toMatchObject({
      state: "valid", inputs: null, supplied: false, method: "advertised-empty",
    });
    expect(validatePlacementInputs(owner(null), undefined)).toMatchObject({ state: "invalid" });
  });

  it("fills typed substitutions in every string value without renaming keys or interpreting other data", () => {
    const inputs = { "{quest.id}": ["{keeper.branch}", { Commit: "{source.commit}", Ref: "{member.branch}" }],
      keep: [null, false, 3, "$HOME; $(whoami)"], label: "Task {quest.id}" };
    const result = validatePlacementInputs(owner({ type: "object" }), inputs, substitutions);
    expect(result).toMatchObject({ state: "valid", supplied: true, inputs: {
      "{quest.id}": ["feature/source", { Commit: "a".repeat(40), Ref: "tavern/member-1" }],
      keep: [null, false, 3, "$HOME; $(whoami)"], label: "Task quest-1",
    } });
    expect(inputs["{quest.id}"][0]).toBe("{keeper.branch}");
  });

  it.each(["{unknown}", "{quest.ID}", "{constructor}"])("refuses unknown substitution %s", value => {
    expect(validatePlacementInputs(owner({ type: "string" }), value, substitutions)).toMatchObject({
      state: "invalid", issues: [{ path: "inputs", message: expect.stringContaining("Unknown substitution") }],
    });
  });

  it("refuses a missing or detached branch rather than guessing main", () => {
    expect(validatePlacementInputs(owner({ type: "string" }), "{keeper.branch}", { "keeper.branch": null }))
      .toMatchObject({ state: "invalid", issues: [{ path: "inputs", message: expect.stringContaining("keeper.branch") }] });
  });

  it("checks both original and expanded inputs against the shared finite JSON bound", () => {
    expect(validatePlacementInputs(owner(true), Infinity as never)).toMatchObject({ state: "invalid" });
    expect(validatePlacementInputs(owner(true), "{member.branch}".repeat(1000), { "member.branch": "a".repeat(100) }))
      .toMatchObject({ state: "invalid" });
  });

  it("retains mixed-case fields and rejects reserved keys before the SDK can lose them", () => {
    expect(validatePlacementInputs(owner(true), { MachineFlavor: "large", Nested: { snake_case: [null] } }))
      .toMatchObject({ state: "valid", inputs: { MachineFlavor: "large", Nested: { snake_case: [null] } } });
    expect(validatePlacementInputs(owner(true), JSON.parse('{"Nested":[{"__proto__":1}]}')))
      .toMatchObject({ state: "invalid", issues: [{ message: expect.stringContaining("__proto__") }] });
  });

  it.each([
    [{ type: "string", pattern: "^task-[0-9]+$" }, "task-7", "other"],
    [{ type: "array", items: { type: ["integer", "null"] }, minItems: 1 }, [1, null], ["1"]],
    [{ type: "object", properties: { Upper: { type: "number", minimum: 1 } }, required: ["Upper"], additionalProperties: false }, { Upper: 2 }, { Upper: 0 }],
    [{ anyOf: [{ type: "string" }, { type: "null" }] }, null, 1],
    [{ type: "string", enum: ["small", "large"] }, "large", "giant"],
    [{ type: "string", const: "one" }, "one", "two"],
  ] as Array<[Json, Json, Json]>)("validates the advertised supported schema %#", (schema, valid, invalid) => {
    expect(validatePlacementInputs(owner(schema), valid)).toMatchObject({ state: "valid", inputs: valid });
    expect(validatePlacementInputs(owner(schema), invalid)).toMatchObject({ state: "invalid" });
  });

  it("does not let JSON Schema default annotations waive required properties or alter explicit data", () => {
    const schema = { type: "object", properties: { value: { type: "string", default: "invented" } }, required: ["value"] };
    expect(validatePlacementInputs(owner(schema), {})).toMatchObject({ state: "invalid" });
    expect(validatePlacementInputs(owner({ type: "object", properties: { value: { type: "string", default: "invented" } } }), {}))
      .toMatchObject({ state: "valid", inputs: {} });
  });

  it.each([
    { type: "string", format: "vendor-secret-format" },
    { type: "object", if: { required: ["x"] }, then: { required: ["y"] } },
    { type: "string", vendorConstraint: true },
    { minimum: 5 },
    { type: "string", enum: ["x"], minLength: 10 },
    { type: "string", const: 1 },
    { type: "string", $ref: "#/$defs/value", $defs: { value: { type: "string" } }, minLength: 10 },
    { anyOf: [{ type: "number" }], allOf: [{ type: "string" }] },
    { additionalProperties: false },
    { prefixItems: [false] },
    { not: {}, anyOf: [{ type: "string" }] },
    { type: "number", minimum: "not a number" },
    { type: "string", minLength: "not a length" },
    { $ref: false },
  ] as Json[])("reports unsupported validation honestly instead of calling it checked %#", schema => {
    expect(validatePlacementInputs(owner(schema), "x")).toMatchObject({ state: "unsupported", supplied: true });
  });

  it("supports local refs without a network schema fetch", () => {
    expect(validatePlacementInputs(owner({ $ref: "#/$defs/value", $defs: { value: { type: "integer" } } }), 2))
      .toMatchObject({ state: "valid", inputs: 2 });
    expect(validatePlacementInputs(owner({ $ref: "https://vendor.invalid/input.json" }), 2))
      .toMatchObject({ state: "unsupported" });
  });
});
