// Loom's own ways of starting a turn in a thread it carries into, its sends and its scheduled retries, wait for the carry;
// each one settles on bb's own answer once the carry is over, so a caller that keeps a message until bb takes it still does.
import { describe, expect, it } from "vitest";
import { holdingMessages, holdingSends } from "../src/carry-hold";
import type { BbPort } from "../src/ports";
import { FakePort, makeCtx, reachApproved, seedProject, ticketOf } from "./helpers";
import { deliverHandBacks, handBack, holdForWorker } from "../src/slots";
import { specOf } from "../src/ctx";
import { runMergeQueue, settleMerges } from "../src/merge";

describe("a carry's hold on a thread", () => {
  it("holds sends and scheduled retries to the thread, and lets them go in order after the carry", async () => {
    const bb = new FakePort();
    const port = holdingSends(bb);
    await holdingMessages("thr_w", async () => {
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

  it("settles a held send only once bb has taken it, and passes on bb's refusal to the caller", async () => {
    const taken: string[] = [];
    const bb = {
      send: async (_threadId: string, message: string) => {
        if (message === "refused") throw new Error("send unavailable");
        taken.push(message);
      },
      log: () => undefined,
    } as unknown as BbPort;
    const port = holdingSends(bb);
    const settled: string[] = [];
    let held: Promise<void> | undefined;
    let refused: Promise<unknown> | undefined;
    await holdingMessages("thr_w", async () => {
      held = port.send("thr_w", "taken").then(() => void settled.push("taken"));
      refused = port.send("thr_w", "refused").catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect([settled, taken]).toEqual([[], []]);
    });
    await held;
    expect([settled, taken]).toEqual([["taken"], ["taken"]]);
    expect(await refused).toMatchObject({ message: "send unavailable" });
  });
});

describe("a hand-back while a carry holds its worker's messages", () => {
  it("is sent once, after the carry, with what was appended to it meanwhile", async () => {
    const h = makeCtx();
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr", describe: "loom" }));
    const worker = await reachApproved(h);
    const ticket = () => ticketOf(h, "CSV-1");
    await runMergeQueue(h.ctx, h.store.projectBySlug("csv")!, specOf(h.store, h.store.projectBySlug("csv")!));
    await settleMerges(h.ctx);
    expect(ticket().state).toBe("pr_open");
    h.ctx.bb = holdingSends(h.bb);
    const before = h.bb.sent(worker.thread_id!).length;
    let delivery: Promise<void> | undefined;
    await holdingMessages(worker.thread_id!, async () => {
      handBack(h.ctx, ticket(), worker, worker.thread_id!, "Fix the rows.");
      delivery = deliverHandBacks(h.ctx, h.store.projectBySlug("csv")!.id);
      expect(h.bb.sent(worker.thread_id!)).toHaveLength(before);
      expect(holdForWorker(h.store, ticket(), "The human also asks for an empty export.")).toBe(true);
    });
    await delivery;
    await deliverHandBacks(h.ctx, h.store.projectBySlug("csv")!.id);
    const sent = h.bb.sent(worker.thread_id!).slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Fix the rows.");
    expect(sent[0]).toContain("The human also asks for an empty export.");
    expect(ticket().handback_json).toBeNull();
  });
});
