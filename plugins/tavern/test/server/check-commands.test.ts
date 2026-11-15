// @vitest-environment node
import { describe, expect, it } from "vitest";
import { doneWhenCommands } from "../../src/server/check-commands";

describe("commands explicitly recorded in done-when", () => {
  it("retains quoted commands and shell fences verbatim", () => {
    expect(doneWhenCommands([
      "Run `npm  test -- --runInBand` and `./bin/check-duration --strict`.",
      "Run this check:\n```sh\ncustom-verifier --fast\n```",
    ])).toEqual(["npm  test -- --runInBand", "./bin/check-duration --strict", "custom-verifier --fast"]);
  });
  it("does not translate prose, values, function examples or artifact references into permissions", () => {
    expect(doneWhenCommands([
      "All tests pass, npm test exits zero and the duration is right.",
      "`formatDuration(0)` returns `0s`; `src/duration.js` exports it.",
      "```js\nassert.equal(formatDuration(0), '0s')\n```",
      null,
    ])).toEqual([]);
  });
  it("recognizes bare standard check forms without treating a sentence as a command", () => {
    expect(doneWhenCommands(["npm test", "node --test", "npm test passes", "./bin/verify-duration --strict"])).toEqual([
      "npm test", "node --test", "./bin/verify-duration --strict",
    ]);
  });
  it("deduplicates exact commands but does not normalize their source", () => {
    expect(doneWhenCommands(["`npm test`", "Run `npm test`", "Run `npm  test`"])).toEqual(["npm test", "npm  test"]);
  });
});
