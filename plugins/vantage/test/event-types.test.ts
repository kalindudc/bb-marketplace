import { describe, expect, it } from "vitest";
import { classifyEventTypes, FILE_EVENT_TYPES } from "../src/event-types";

describe("classifyEventTypes", () => {
  it.each([
    [undefined, "changed"],
    [[], "changed"],
    [["item/agentMessage/delta", "item/commandExecution/outputDelta"], "unchanged"],
    [["item/started", "thread/tokenUsage/updated", "turn/started"], "unchanged"],
    [["item/completed"], "look"],
    [["item/agentMessage/delta", "item/started", "item/completed"], "look"],
    [["item/completed", "turn/completed"], "changed"],
    [["turn/diff/updated"], "changed"],
    [["item/completed", "something/new"], "changed"],
  ] as const)("reads %j as %s", (types, verdict) => {
    expect(classifyEventTypes(types)).toBe(verdict);
  });

  it("never reads an event the page refreshes for as unchanged", () => {
    for (const type of FILE_EVENT_TYPES) expect(classifyEventTypes([type])).not.toBe("unchanged");
  });

  it("lists every type the server treats as a change on its own", () => {
    expect(FILE_EVENT_TYPES).toEqual(expect.arrayContaining([
      "item/completed", "turn/completed", "turn/diff/updated", "item/backgroundTask/completed", "item/delegation/completed",
    ]));
  });
});
