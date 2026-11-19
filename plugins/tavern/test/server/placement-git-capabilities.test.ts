// @vitest-environment node
import { expect, it } from "vitest";
import { HostError } from "../../src/host/registry";
import { readyFixture } from "./placement-e2e-ready";

it.each([false, true])("keeps unsupported Git lasting after readiness (serialized error: %s)", async serialized => {
  const f = await readyFixture();
  const message = "This machine's Git can't carry Tavern's work (git --list-cmds=builtins: unknown option). Members can't be placed on it yet.";
  f.intercept((method, _input, result) => {
    if (method === "inspect") throw serialized ? new Error(message) : new HostError("git-unsupported", message);
    return result;
  });
  const ready = f.make();
  expect(await ready.forThread("member")).toContain("Stop this placement or hire without placement; retrying will not help");
  expect(f.placements.get("placement")).toMatchObject({ phase: "blocked", blocked: { stage: "bind", code: "git-unsupported", retryable: false, message: expect.stringContaining(message) } });
  expect(() => f.placements.retry("placement", 1)).toThrow(/no retryable blocked phase/);
  const calls = f.harness.experimental_hostRpcCalls.length;
  expect(await ready.forThread("member")).toMatch(/stop/i);
  expect(f.harness.experimental_hostRpcCalls).toHaveLength(calls);
}, 60_000);
