// Loom's own ways of starting a turn in a thread it carries into, its sends and its scheduled retries, wait for the carry.
import { describe, expect, it } from "vitest";
import { holdingMessages, holdingSends } from "../src/carry-hold";
import { FakePort } from "./helpers";

describe("a carry's hold on a thread", () => {
  it("holds sends and scheduled retries to the thread, and lets them go in order after the carry", async () => {
    const bb = new FakePort();
    const port = holdingSends(bb);
    await holdingMessages(port, "thr_w", async () => {
      void port.send("thr_w", "first");
      void port.retryTurn("thr_w", "req_1", 1_000);
      void port.send("thr_w", "second");
      await port.send("thr_other", "not held");
      expect(bb.calls.filter((call) => call.method === "send" || call.method === "retryTurn").map((call) => call.args)).toEqual([["thr_other", "not held"]]);
    });
    expect(bb.calls.filter((call) => call.method === "send" || call.method === "retryTurn").map((call) => call.args)).toEqual([
      ["thr_other", "not held"],
      ["thr_w", "first"],
      ["thr_w", "req_1", 1_000],
      ["thr_w", "second"],
    ]);
  });

});
