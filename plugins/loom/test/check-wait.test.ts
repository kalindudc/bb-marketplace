import { describe, expect, it } from "vitest";
import { checkWaitOf, durationsKey, holdOf, median, progressOf, queuedSince, type Check } from "../src/check-wait";
import type { Spec } from "../src/spec";

const check = (more: Partial<Check> = {}): Check => ({ key: "check:1", name: "test", state: "pending", url: null, ...more });
const MIN = 60_000;

describe("checkWaitOf", () => {
  const spec = (merge: Partial<Spec["merge"]>) => ({ merge: { strategy: "pr", ...merge } }) as Spec;

  it("takes the spec's keys, then Loom's settings, then 5 minutes and 75%", () => {
    expect(checkWaitOf(spec({}), { settleMs: 30 * MIN })).toEqual({ settleMs: 30 * MIN, queuedMs: 5 * MIN, nearDone: 75 });
    expect(checkWaitOf(spec({}), { settleMs: MIN, queuedMinutes: 10, nearDonePercent: 50 })).toEqual({ settleMs: MIN, queuedMs: 10 * MIN, nearDone: 50 });
    expect(checkWaitOf(spec({ checks_queued_minutes: 0, checks_near_done_percent: 0 }), { settleMs: MIN, queuedMinutes: 10, nearDonePercent: 50 })).toEqual({ settleMs: MIN, queuedMs: 0, nearDone: 0 });
  });
});

describe("progressOf", () => {
  it("prefers the forge's number, then the time so far against the usual duration, then a job's steps", () => {
    const all = check({ progress: 40, startedAt: 0, steps: { done: 1, total: 2 } });
    expect(progressOf(all, 10 * MIN, 9 * MIN)).toEqual({ percent: 40, from: "forge" });
    expect(progressOf({ ...all, progress: null }, 10 * MIN, 9 * MIN)).toEqual({ percent: 90, from: "history" });
    expect(progressOf({ ...all, progress: null }, undefined, 9 * MIN)).toEqual({ percent: 50, from: "steps" });
    expect(progressOf(check({ startedAt: 0 }), undefined, MIN)).toBeNull();
    expect(progressOf(check({ steps: { done: 0, total: 0 } }), 10 * MIN, MIN)).toBeNull();
  });
});

describe("queuedSince", () => {
  const queued = check({ key: "check:q", started: false });
  const running = check({ key: "check:r", started: true });

  it("dates a queued check from the push on the first reading of Loom's head, and from now on a later reading or another head", () => {
    expect(queuedSince([queued, running], null, { head: "a", pushedSha: "a", pushedAt: 100, now: 500 })).toEqual({ "check:q": 100 });
    expect(queuedSince([queued], null, { head: "b", pushedSha: "a", pushedAt: 100, now: 500 })).toEqual({ "check:q": 500 });
    expect(queuedSince([queued], { head: "a", queued: {} }, { head: "a", pushedSha: "a", pushedAt: 100, now: 500 })).toEqual({ "check:q": 500 });
    expect(queuedSince([queued], { head: "a", queued: { "check:q": 200 } }, { head: "a", pushedSha: "a", pushedAt: 100, now: 500 })).toEqual({ "check:q": 200 });
    expect(queuedSince([queued], { head: "old", queued: { "check:q": 200 } }, { head: "a", pushedSha: "a", pushedAt: 100, now: 500 })).toEqual({ "check:q": 100 });
  });
});

describe("holdOf", () => {
  const wait = { settleMs: 30 * MIN, queuedMs: 5 * MIN, nearDone: 75 };
  const base = { queued: {}, usual: new Map<string, number>(), now: 10 * MIN, pushedAt: 0, wait };

  it("is settled with nothing pending, and ignores finished checks", () => {
    expect(holdOf([check({ state: "failed" }), check({ state: "passed" })], base)).toEqual({ settled: true, skipped: [] });
  });

  it("holds for a check that has not started for less than the limit, and for every queued check when the limit is 0", () => {
    const queued = check({ started: false });
    expect(holdOf([queued], { ...base, queued: { "check:1": 6 * MIN } }).settled).toBe(false);
    expect(holdOf([queued], { ...base, queued: { "check:1": 5 * MIN } })).toEqual({ settled: true, skipped: [{ name: "test", url: null, why: "queued", minutes: 5 }] });
    expect(holdOf([queued], { ...base, queued: { "check:1": 0 }, wait: { ...wait, queuedMs: 0 } }).settled).toBe(false);
  });

  it("holds for a running check from the near-done percent, up to twice its usual time", () => {
    const usual = new Map([["test", 10 * MIN]]);
    const at = (startedAt: number) => holdOf([check({ startedAt })], { ...base, usual, now: 25 * MIN, pushedAt: 20 * MIN });
    expect(at(17.5 * MIN).settled).toBe(false);
    expect(at(20 * MIN)).toEqual({ settled: true, skipped: [{ name: "test", url: null, why: "running", percent: 50 }] });
    expect(at(5 * MIN).settled).toBe(false);
    expect(at(4 * MIN)).toEqual({ settled: true, skipped: [{ name: "test", url: null, why: "overrun", percent: 210 }] });
  });

  it("holds for a running check it cannot measure, and for any running check when the percent is 0", () => {
    expect(holdOf([check({ started: null })], base).settled).toBe(false);
    expect(holdOf([check({ steps: { done: 0, total: 4 } })], { ...base, wait: { ...wait, nearDone: 0 } }).settled).toBe(false);
  });

  it("settles at the settle time after the push, naming the checks it still held for", () => {
    const pending = [check({ started: null, name: "reviews" }), check({ key: "check:2", started: false, name: "e2e" })];
    const result = holdOf(pending, { ...base, queued: { "check:2": 28 * MIN }, now: 31 * MIN, pushedAt: 0 });
    expect(result).toEqual({ settled: true, skipped: [{ name: "reviews", url: null, why: "settled", minutes: 31 }, { name: "e2e", url: null, why: "settled", minutes: 31 }] });
  });
});

describe("median and durationsKey", () => {
  it("takes the middle duration, or the mean of the two middle ones", () => {
    expect(median([])).toBeUndefined();
    expect(median([9, 1, 5])).toBe(5);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("keys durations by the forge repository in the pull request's URL, or by the project and repo", () => {
    expect(durationsKey("https://github.com/acme/shop/pull/12", 1, null)).toBe("https://github.com/acme/shop");
    expect(durationsKey("https://gitlab.example.com/acme/shop/-/merge_requests/3", 1, null)).toBe("https://gitlab.example.com/acme/shop");
    expect(durationsKey("https://review.example.com/shop/42", 7, "api")).toBe("project:7:api");
    expect(durationsKey(null, 7, null)).toBe("project:7:");
  });
});
