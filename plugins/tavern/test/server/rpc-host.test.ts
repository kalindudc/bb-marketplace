// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createFakePluginHost } from "./host";

const invalid: [string, () => unknown][] = [
  ["undefined", () => undefined],
  ["optional undefined field", () => ({ scope: { guardPosture: undefined } })],
  ["undefined array item", () => [undefined]],
  ["function", () => ({ callback: () => {} })],
  ["symbol", () => Symbol("value")],
  ["symbol key", () => ({ [Symbol("key")]: 1 })],
  ["bigint", () => ({ count: 1n })],
  ["NaN", () => ({ count: NaN })],
  ["positive infinity", () => [Infinity]],
  ["negative infinity", () => -Infinity],
  ["Date", () => new Date(0)],
  ["Map", () => new Map([["key", "value"]])],
  ["Set", () => new Set([1])],
  ["class instance", () => new class Result { ok = true; }()],
  ["cycle", () => { const value: unknown[] = []; value.push(value); return value; }],
];
describe("strict host RPC wire boundary", () => {
  it.each(invalid)("rejects %s instead of dropping or coercing it", async (_label, makeResult) => {
    const f = createFakePluginHost({ pluginId: "tavern", sdk: {} });
    f.bb.rpc.register({ probe: { input: z.null(), output: z.unknown() } }, { probe: makeResult });
    await expect(f.harness.invokeRpc("probe", null)).rejects.toMatchObject({ code: "non_json_result" });
  });
  it("rejects an explicitly undefined declared optional output field", async () => {
    const f = createFakePluginHost({ pluginId: "tavern", sdk: {} });
    f.bb.rpc.register({ probe: { input: z.null(), output: z.object({ scope: z.object({ guardPosture: z.string().optional() }) }) } }, { probe: () => ({ scope: { guardPosture: undefined } }) });
    await expect(f.harness.invokeRpc("probe", null)).rejects.toMatchObject({ code: "non_json_result" });
  });
  it("keeps every registration, validates schemas and returns detached JSON", async () => {
    const f = createFakePluginHost({ pluginId: "tavern", sdk: {} });
    const result = { ok: true, values: [null, 1, "value", false], optionalAbsent: {} };
    const first = vi.fn(() => result);
    f.bb.rpc.register({ first: { input: z.object({}).strict(), output: z.unknown() } }, { first });
    f.bb.rpc.register({ second: { input: z.null(), output: z.object({ ok: z.boolean() }) } }, { second: () => ({ ok: true }) });
    expect(f.harness.inspection.registrations.rpcMethods).toEqual(["first", "second"]);
    await expect(f.harness.invokeRpc("first", {})).resolves.toEqual(result);
    expect(await f.harness.invokeRpc("first", {})).not.toBe(result);
    await expect(f.harness.invokeRpc("second", null)).resolves.toEqual({ ok: true });
    await expect(f.harness.invokeRpc("first", null)).rejects.toMatchObject({ code: "invalid_input" });
    expect(first).toHaveBeenCalledTimes(2);
    await expect(f.harness.invokeRpc("missing", null)).rejects.toMatchObject({ code: "unknown_method" });
  });
  it("rejects schema-invalid outputs before returning them", async () => {
    const f = createFakePluginHost({ pluginId: "tavern", sdk: {} });
    f.bb.rpc.register({ probe: { input: z.null(), output: z.object({ ok: z.boolean() }) } }, { probe: () => ({ ok: "wrong" }) as never });
    await expect(f.harness.invokeRpc("probe", null)).rejects.toMatchObject({ code: "invalid_output" });
  });
});
