// @vitest-environment node
import { describe, expect, it } from "vitest";
import { burnUsageSchema, usageOf } from "../src/bb-port";
import { usageText } from "../src/format";
import type { ThreadUsage, TokenCounts, UsageRead } from "../src/ports";
import { MISSING_RETRY_MS, PASS_CALLS, REREAD_MS, readUsage, SETTLE_MS } from "../src/usage";
import { harness, pr, testConfig } from "./helpers";

const KEY = "forge:acme/app#3";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NO_AUTO = { enabled: false, when: ["requested" as const], drafts: false, preset: "", repos: [], maxPerDay: 8, rerun: "never" as const };
/** Local noon, so a few hours either way stay on the same calendar day wherever the tests run. */
const NOON = new Date(2026, 9, 23, 12, 0).getTime();

/** `n` tokens: most of them cache reads, as a review's are. */
const tokens = (n: number): TokenCounts => ({ input: n * 0.1, output: n * 0.1, cacheRead: n * 0.7, cacheWrite: n * 0.1 });
type Turn = { at: number; tokens: number; cost: number; model?: string };

/** What Burn says one thread used: these turns, and totals that are their sum unless `extra` adds turns it no longer lists. */
function burn(turns: Turn[], extra: { tokens: number; cost: number } = { tokens: 0, cost: 0 }, descendants: string[] = []): UsageRead {
  const sum = (pick: (t: Turn) => number) => turns.reduce((n, t) => n + pick(t), 0);
  const total = sum((t) => t.tokens) + extra.tokens;
  const usage: ThreadUsage = {
    startedAt: Math.min(...turns.map((t) => t.at)),
    updatedAt: Math.max(...turns.map((t) => t.at)),
    calls: turns.length + (extra.tokens > 0 ? 1 : 0),
    tokens: tokens(total),
    cost: sum((t) => t.cost) + extra.cost,
    estimated: false,
    model: "anthropic/claude",
    turns: turns.map((t, i) => ({ n: i + 1, at: t.at, calls: 1, cost: t.cost, tokens: tokens(t.tokens), model: t.model ?? "anthropic/claude" })),
  };
  return { usage, descendants };
}

/** A review of PR 3 started at local noon in a thread Shuttle started; `run` ends it with a draft. */
async function reviewing() {
  const h = harness(testConfig({ autoReview: NO_AUTO }));
  h.clock.now = NOON;
  h.lists.review_requested = [pr(3)];
  await h.shuttle.sync();
  const { threadId } = await h.shuttle.review({ key: KEY });
  const draft = () => h.shuttle.saveDraft(threadId, KEY, { summary: "One race", verdict: "changes", findings: [{ severity: "high", path: "a.go", line: 3, body: "Race" }] });
  return { h, threadId, draft };
}

describe("review usage", () => {
  it("counts each turn toward the review running in its thread, and a critic toward the review it started under", async () => {
    const { h, threadId, draft } = await reviewing();
    await draft();
    h.clock.now = NOON + HOUR;
    await h.shuttle.review({ key: KEY });
    h.clock.now = NOON + HOUR + 10 * MINUTE;
    await draft();
    h.port.usage.set(threadId, burn([
      { at: NOON + 5_000, tokens: 1_000, cost: 1 },
      { at: NOON + 3 * MINUTE, tokens: 500, cost: 0.5 },
      // A turn sent with the second review's prompt can start a moment before Shuttle records the run.
      { at: NOON + HOUR - 20_000, tokens: 2_000, cost: 2 },
    ], undefined, ["thr_critic1", "thr_critic2"]));
    h.port.usage.set("thr_critic1", burn([{ at: NOON + MINUTE, tokens: 300, cost: 0.3 }, { at: NOON + HOUR + 2 * MINUTE, tokens: 100, cost: 0.1 }]));
    h.port.usage.set("thr_critic2", burn([{ at: NOON + HOUR + 2 * MINUTE, tokens: 400, cost: 0.4 }]));
    await h.shuttle.readUsage();

    const view = h.shuttle.usage("today");
    expect(view.totals).toMatchObject({ tokens: 4_300, reviews: 2, calls: 6 });
    expect(view.totals.cost).toBeCloseTo(4.3);
    // A critic counts toward the review it started under, even for its turns after the next review began. The second
    // review's draft waits; it replaced the first one's.
    expect(view.reviews.map((r) => ({ tokens: r.tokens, critics: r.critics, outcome: r.outcome }))).toEqual([
      { tokens: 2_400, critics: 1, outcome: "waiting" },
      { tokens: 1_900, critics: 1, outcome: "replaced" },
    ]);
    expect(view.critics).toMatchObject({ tokens: 800, threads: 2 });
    expect(view.presets).toEqual([expect.objectContaining({ preset: "Standard review", reviews: 2, tokens: 4_300 })]);
    expect(view.source).toMatchObject({ state: "ok", unread: 0 });
    // By the hour each turn started: the second review's first turn began at 12:59.
    expect(view.series.find((row) => row.start === new Date(2026, 9, 23, 12).getTime())).toMatchObject({ tokens: 3_800, critics: 300, reviews: 1 });
    expect(view.series.find((row) => row.start === new Date(2026, 9, 23, 13).getTime())).toMatchObject({ tokens: 500, critics: 500, reviews: 1 });
  });

  it("counts a review in a thread you picked only until it ends", async () => {
    const h = harness(testConfig({ autoReview: NO_AUTO }));
    h.clock.now = NOON;
    h.lists.review_requested = [pr(3)];
    await h.shuttle.sync();
    h.port.addThread("thr_mine", "My work");
    await h.shuttle.review({ key: KEY, threadId: "thr_mine" });
    h.clock.now = NOON + 10 * MINUTE;
    await h.shuttle.saveDraft("thr_mine", KEY, { summary: "Fine", verdict: "comment", findings: [] });
    h.port.usage.set("thr_mine", burn([
      { at: NOON - HOUR, tokens: 5_000, cost: 5 },
      { at: NOON + MINUTE, tokens: 700, cost: 0.7 },
      { at: NOON + HOUR, tokens: 9_000, cost: 9 },
    ]));
    await h.shuttle.readUsage();
    expect(h.shuttle.usage("today").totals).toMatchObject({ tokens: 700, reviews: 1 });
  });

  it("keeps turns Burn stops listing, and counts what its turns leave out of a thread's totals when the thread started", async () => {
    const { h, threadId, draft } = await reviewing();
    h.port.usage.set(threadId, burn([{ at: NOON + MINUTE, tokens: 1_000, cost: 1 }, { at: NOON + 2 * MINUTE, tokens: 1_000, cost: 1 }]));
    await h.shuttle.readUsage();
    h.clock.now += REREAD_MS;
    // Burn lists only a thread's latest turns: the first is gone, and its totals still count it.
    const later = burn([{ at: NOON + 2 * MINUTE, tokens: 1_000, cost: 1 }, { at: NOON + 4 * MINUTE, tokens: 1_000, cost: 1 }], { tokens: 1_000, cost: 1 });
    later.usage!.turns = later.usage!.turns.map((t, i) => ({ ...t, n: i + 2 }));
    h.port.usage.set(threadId, later);
    await h.shuttle.readUsage();
    expect(h.shuttle.usage("today").totals.tokens).toBe(3_000);

    // A thread Shuttle first reads with turns missing counts them when it started.
    await draft();
    h.store.saveUsage("thr_other", threadId, burn([{ at: NOON + 3 * MINUTE, tokens: 100, cost: 0.1 }], { tokens: 400, cost: 0.4 }).usage);
    expect(h.shuttle.usage("today").totals.tokens).toBe(3_500);
  });

  it("never loses figures it has when Burn has none for a thread, such as one deleted since", async () => {
    const { h, threadId } = await reviewing();
    h.port.usage.set(threadId, burn([{ at: NOON + MINUTE, tokens: 1_000, cost: 1 }]));
    await h.shuttle.readUsage();
    h.port.usage.delete(threadId);
    h.clock.now += REREAD_MS;
    await h.shuttle.readUsage();
    expect(h.port.usageCalls).toEqual([threadId, threadId]);
    expect(h.shuttle.usage("today").totals.tokens).toBe(1_000);
  });

  it("reads a running review every few minutes, a finished one until an hour after it ended, then never again", async () => {
    const { h, threadId, draft } = await reviewing();
    h.port.usage.set(threadId, burn([{ at: NOON + MINUTE, tokens: 1_000, cost: 1 }]));
    await h.shuttle.readUsage();
    await h.shuttle.readUsage();
    expect(h.port.usageCalls).toHaveLength(1);
    h.clock.now += REREAD_MS;
    await h.shuttle.readUsage();
    expect(h.port.usageCalls).toHaveLength(2);
    await draft();
    for (let i = 0; i < 20; i += 1) {
      h.clock.now += REREAD_MS;
      await h.shuttle.readUsage();
    }
    const reads = h.port.usageCalls.length;
    expect(reads).toBe(2 + Math.ceil(SETTLE_MS / REREAD_MS));
    h.clock.now += 24 * HOUR;
    await h.shuttle.readUsage();
    expect(h.port.usageCalls).toHaveLength(reads);
    // A new review in the same thread reads it again.
    await h.shuttle.review({ key: KEY });
    await h.shuttle.readUsage();
    expect(h.port.usageCalls).toHaveLength(reads + 1);
  });

  it("reads the newest reviews first, at most a pass's worth of Burn calls at a time", async () => {
    const h = harness(testConfig({ autoReview: NO_AUTO }));
    h.clock.now = NOON;
    h.lists.review_requested = Array.from({ length: PASS_CALLS + 5 }, (_, i) => pr(i + 1));
    await h.shuttle.sync();
    const threads: string[] = [];
    for (let i = 1; i <= PASS_CALLS + 5; i += 1) {
      h.clock.now += 1_000;
      threads.push((await h.shuttle.review({ key: `forge:acme/app#${i}` })).threadId);
    }
    await h.shuttle.readUsage();
    expect(h.port.usageCalls).toEqual(threads.slice(5).reverse());
    expect(h.shuttle.usage("today").source.unread).toBe(5);
  });

  it("reads a thread with more threads under it than a pass allows over several passes, and counts it once it has them all", async () => {
    const { h, threadId } = await reviewing();
    const children = Array.from({ length: PASS_CALLS + 10 }, (_, i) => `thr_child${i}`);
    h.port.usage.set(threadId, burn([{ at: NOON + MINUTE, tokens: 1_000, cost: 1 }], undefined, children));
    for (const id of children) h.port.usage.set(id, burn([{ at: NOON + 2 * MINUTE, tokens: 10, cost: 0.01 }]));
    h.clock.now = NOON + 3 * MINUTE;
    await h.shuttle.readUsage();
    expect(h.port.usageCalls).toHaveLength(PASS_CALLS);
    // The critics read so far count already; the review thread's own figures wait for the next pass.
    expect(h.shuttle.usage("today").totals.tokens).toBe(10 * (PASS_CALLS - 1));
    expect(h.shuttle.usage("today").source.unread).toBe(1);
    h.clock.now += 30_000;
    await h.shuttle.readUsage();
    expect(h.port.usageCalls).toHaveLength(PASS_CALLS + 12);
    expect(h.shuttle.usage("today").totals).toMatchObject({ tokens: 1_000 + 10 * children.length, reviews: 1 });
    expect(h.shuttle.usage("today").critics.threads).toBe(children.length);
  });

  it("says when Burn is not there, and asks again only after a while", async () => {
    const { h } = await reviewing();
    h.port.noBurn = true;
    await h.shuttle.readUsage();
    expect(h.shuttle.usage("7d").source).toMatchObject({ state: "missing", message: 'unknown plugin "burn"', unread: 1 });
    await h.shuttle.readUsage();
    expect(h.port.usageCalls).toHaveLength(1);
    h.clock.now += MISSING_RETRY_MS;
    h.port.noBurn = false;
    await h.shuttle.readUsage();
    expect(h.port.usageCalls).toHaveLength(2);
    expect(h.shuttle.usage("7d").source.state).toBe("ok");
  });

  it("stops a pass after three failed reads in a row, says so once an hour, and waits before the next pass", async () => {
    const h = harness(testConfig({ autoReview: NO_AUTO }));
    h.clock.now = NOON;
    h.lists.review_requested = [pr(1), pr(2), pr(3), pr(4)];
    await h.shuttle.sync();
    for (let i = 1; i <= 4; i += 1) {
      const { threadId } = await h.shuttle.review({ key: `forge:acme/app#${i}` });
      h.port.usage.set(threadId, new Error("Burn timed out"));
    }
    await h.shuttle.readUsage();
    expect(h.port.usageCalls).toHaveLength(3);
    expect(h.shuttle.usage("today").source).toMatchObject({ state: "error", message: "Burn timed out" });
    expect(h.port.logs.filter((line) => line.includes("Burn timed out"))).toHaveLength(1);
    await h.shuttle.readUsage();
    expect(h.port.usageCalls).toHaveLength(3);
    h.clock.now += REREAD_MS;
    await h.shuttle.readUsage();
    expect(h.port.usageCalls).toHaveLength(6);
    expect(h.port.logs.filter((line) => line.includes("Burn timed out"))).toHaveLength(1);
  });

  it("compares today with yesterday by this time, and puts the last 7 days in days", async () => {
    const { h, threadId } = await reviewing();
    h.port.usage.set(threadId, burn([{ at: NOON + MINUTE, tokens: 1_000, cost: 1 }]));
    await h.shuttle.readUsage();
    // Yesterday's review: one turn before this time of day and one after.
    const yesterday = await (async () => {
      h.clock.now = NOON - 24 * HOUR - HOUR;
      h.lists.review_requested = [pr(3), pr(4)];
      await h.shuttle.sync();
      const { threadId: id } = await h.shuttle.review({ key: "forge:acme/app#4" });
      return id;
    })();
    h.port.usage.set(yesterday, burn([{ at: NOON - 24 * HOUR - 50 * MINUTE, tokens: 400, cost: 0.4 }, { at: NOON - 24 * HOUR + 2 * HOUR, tokens: 4_000, cost: 4 }]));
    h.clock.now = NOON + 2 * MINUTE;
    await h.shuttle.readUsage();

    const today = h.shuttle.usage("today");
    expect(today).toMatchObject({ bucket: "hour", totals: { tokens: 1_000 }, previous: { tokens: 400, reviews: 1 } });
    expect(today.series).toHaveLength(13);
    const week = h.shuttle.usage("7d");
    expect(week).toMatchObject({ bucket: "day", totals: { tokens: 5_400, reviews: 2 } });
    expect(week.series.map((row) => row.tokens)).toEqual([0, 0, 0, 0, 0, 4_400, 1_000]);
    expect(week.series.at(-1)!.start).toBe(new Date(2026, 9, 23).getTime());

    // Yesterday in full, against the whole day before it; and the 7 days that ended yesterday.
    const yesterdayView = h.shuttle.usage("today", "2026-10-22");
    expect(yesterdayView).toMatchObject({ today: "2026-10-23", end: "2026-10-22", latest: false, firstDay: "2026-10-22", bucket: "hour", totals: { tokens: 4_400, reviews: 1 }, previous: { tokens: 0, reviews: 0 } });
    expect(yesterdayView.from).toBe(new Date(2026, 9, 22).getTime());
    expect(yesterdayView.to).toBe(new Date(2026, 9, 23).getTime());
    expect(yesterdayView.series).toHaveLength(24);
    expect(usageText(yesterdayView).split("\n")[0]).toBe("Yesterday, Oct 22: 4.40K tokens and $4.40 across 1 review and 2 model calls.");
    expect(usageText(h.shuttle.usage("today")).split("\n")[0]).toBe("Today, Oct 23: 1.00K tokens and $1.00 across 1 review and 1 model call (up 150% from yesterday by now).");
    expect(yesterdayView.series.find((row) => row.start === new Date(2026, 9, 22, 14).getTime())).toMatchObject({ tokens: 4_000 });
    const lastWeek = h.shuttle.usage("7d", "2026-10-22");
    expect(lastWeek).toMatchObject({ end: "2026-10-22", latest: false, totals: { tokens: 4_400 } });
    expect(lastWeek.series.map((row) => row.start)).toEqual(Array.from({ length: 7 }, (_, i) => new Date(2026, 9, 16 + i).getTime()));
    // Today and later are the newest period.
    expect(h.shuttle.usage("today", "2026-11-30")).toMatchObject({ end: "2026-10-23", latest: true, totals: { tokens: 1_000 } });
  });
});

describe("Burn's answer", () => {
  it("is read from the fields Shuttle needs, each turn with its first model or the costliest one", () => {
    const answer = burnUsageSchema.parse({
      report: {
        version: 2, startedAt: 1, updatedAt: 9, calls: 66, lastTurnCost: 5.24,
        tokens: { input: 132, output: 41_567, cacheRead: 8_807_155, cacheWrite: 197_886, reasoning: 20_735 },
        cost: { input: 0.001, output: 1.77, cacheRead: 1.87, cacheWrite: 2.1, total: 5.74 },
        estimated: false,
        byModel: [{ key: "openai/gpt", cost: 0.1 }, { key: "anthropic/claude", cost: 5.64 }],
        turns: [
          { n: 1, at: 2, endAt: 3, calls: 1, cost: 0.5, tokens: { input: 4, output: 165, cacheRead: 0, cacheWrite: 46_521 }, models: [] },
          { n: 2, at: 4, endAt: 9, calls: 65, cost: 5.24, tokens: { input: 128, output: 41_402, cacheRead: 8_807_155, cacheWrite: 151_365 }, models: ["openai/gpt"] },
        ],
        series: [],
      },
      source: "log",
      family: { total: 6, calls: 70, estimated: false, children: [{ threadId: "thr_critic1", title: "Jon", cost: 0.3, calls: 4, running: false, model: null, estimated: false }] },
    });
    const read = usageOf(answer);
    expect(read.descendants).toEqual(["thr_critic1"]);
    expect(read.usage).toMatchObject({ calls: 66, cost: 5.74, model: "anthropic/claude", tokens: { input: 132, output: 41_567, cacheRead: 8_807_155, cacheWrite: 197_886 } });
    expect(read.usage!.turns.map((t) => t.model)).toEqual(["anthropic/claude", "openai/gpt"]);
    expect(usageOf(burnUsageSchema.parse({ report: null, family: { children: [] } }))).toEqual({ usage: null, descendants: [] });
  });
});

