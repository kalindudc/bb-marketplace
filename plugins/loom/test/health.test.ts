import { describe, expect, it } from "vitest";
import type { ThreadRow, TicketRow } from "../src/db/store";
import { projectHealth } from "../src/health";
import { parseSpec, type Spec } from "../src/spec";
import type { TicketState } from "../src/states";
import { HOUR, NOW, metrics } from "./fixtures";
import { specToml, type Doc } from "./helpers";

const MINUTE = 60_000;
const DAY = 24 * HOUR;

const ticket = (n: number, state: TicketState, over: Partial<TicketRow> = {}): TicketRow => ({
  id: n,
  project_id: 1,
  seq: n,
  key: `CSV-${n}`,
  ref: `t${n}`,
  title: `Ticket ${n}`,
  body: "",
  acceptance_json: "[]",
  verify_json: "[]",
  scope_json: JSON.stringify([`src/t${n}/**`]),
  deps_json: "[]",
  priority: 2,
  state,
  attempt: 0,
  failures: 0,
  check_failures: 0,
  review_round: 0,
  branch: null,
  environment_id: null,
  worker_thread_id: null,
  head_sha: null,
  merge_before: null,
  pr_url: null,
  pr_checked_at: null,
  blocked_reason: null,
  repo: null,
  pr_branch: null,
  pushed_sha: null,
  pushed_at: null,
  pr_ask_json: null,
  pr_text_json: null,
  pr_seen_json: "[]",
  pr_rounds: 0,
  pr_status_json: null,
  handback_json: null,
  stack_json: null,
  pr_base: null,
  start_wait_json: null,
  environment_json: null,
  pr_poll_json: null,
  merge_after_json: "[]",
  pr_meta_json: null,
  head_tree: null,
  created_by: "human",
  created_at: NOW,
  updated_at: NOW,
  state_at: NOW,
  ...over,
});

const reviewer = (state: ThreadRow["state"]): ThreadRow => ({
  id: 1,
  thread_id: "thr_r",
  spawn_token: null,
  project_id: 1,
  ticket_id: 1,
  role: "reviewer",
  state,
  environment_id: null,
  idle_count: 0,
  rate_limit_retries: 0,
  tokens: null,
  tokens_at: null,
  review_round: 1,
  attempt: null,
  started_at: NOW,
  clock_at: null,
  ended_at: null,
  end_reason: null,
  released_at: null,
  resume_json: null,
  maintenance_seq: 0,
});

const specWith = (edit?: (doc: Doc) => void): Spec => parseSpec(specToml(edit)).spec!;
const throughput = (doneByDay: number[]) => doneByDay.map((done, index) => ({ day: `2026-01-${String(index + 1).padStart(2, "0")}`, done }));
const states = (entries: Array<[TicketState, number]>) => entries.flatMap(([state, count]) => Array.from({ length: count }, () => state)).map((state, index) => ticket(index + 1, state));

describe("projectHealth", () => {
  it("counts progress without the cancelled tickets, and the pace and time left over the running time in the 14-day window", () => {
    const tickets = states([
      ["done", 8],
      ["working", 2],
      ["review", 1],
      ["blocked", 1],
      ["queued", 2],
      ["cancelled", 1],
    ]);
    const health = projectHealth({ tickets, threads: [], metrics: metrics({ wip: 3, throughput: throughput([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]), windowActiveMs: 14 * DAY }), spec: specWith(), now: NOW });
    expect(health.progress).toEqual({ done: 8, total: 14, inFlight: 3, blocked: 1, queued: 2 });
    expect(health.pace.remaining).toBe(6);
    expect(health.pace.perHour! * 24).toBeCloseTo(0.5);
    expect(health.pace.etaMs).toBeCloseTo(12 * DAY);
  });

  it("paces a project that started today by the hours it ran, not by the 14 days of the window", () => {
    const tickets = states([
      ["done", 8],
      ["working", 1],
      ["queued", 2],
    ]);
    const health = projectHealth({ tickets, threads: [], metrics: metrics({ throughput: throughput([...Array(13).fill(0), 8]), windowActiveMs: 2 * HOUR }), spec: specWith(), now: NOW });
    expect(health.pace).toEqual({ perHour: 4, remaining: 3, etaMs: 45 * MINUTE });
  });

  it("has no time left at a pace of zero", () => {
    const health = projectHealth({ tickets: states([["queued", 2]]), threads: [], metrics: metrics({ throughput: throughput(Array(14).fill(0)), windowActiveMs: 7 * HOUR }), spec: specWith(), now: NOW });
    expect(health.pace).toEqual({ perHour: 0, remaining: 2, etaMs: null });
  });

  it("has no pace when the project did not run in the window, even if a ticket finished while it was paused", () => {
    const health = projectHealth({ tickets: states([["done", 1], ["queued", 2]]), threads: [], metrics: metrics({ throughput: throughput([...Array(13).fill(0), 1]), windowActiveMs: 0 }), spec: specWith(), now: NOW });
    expect(health.pace).toEqual({ perHour: null, remaining: 2, etaMs: null });
  });

  it("has no budget and no deadline when the spec sets neither", () => {
    const health = projectHealth({ tickets: [], threads: [], metrics: metrics(), spec: specWith(), now: NOW });
    expect(health.budget).toBeNull();
    expect(health.deadline).toBeNull();
  });

  it("shows the sampled tokens against max_tokens, and counts the deadline day until it is over", () => {
    const spec = specWith((doc) => (doc.budget = { max_tokens: 50_000, deadline: "2026-01-15" }));
    const health = projectHealth({ tickets: [], threads: [], metrics: metrics(), spec, now: NOW });
    expect(health.budget).toEqual({ used: 12_000, max: 50_000 });
    expect(health.deadline).toEqual({ date: "2026-01-15", daysLeft: 6 });
    expect(projectHealth({ tickets: [], threads: [], metrics: metrics(), spec: specWith((doc) => (doc.budget = { deadline: "2026-01-10" })), now: NOW }).deadline!.daysLeft).toBe(1);
  });

  it("counts busy worker slots, live reviewers, and the ready tickets that wait for a slot", () => {
    const tickets = [ticket(1, "working"), ticket(2, "checking"), ticket(3, "queued"), ticket(4, "queued"), ticket(5, "queued"), ticket(6, "review")];
    const threads = [reviewer("active"), reviewer("spawning"), reviewer("ended")];
    const spec = specWith((doc) => (doc.agents = { ...doc.agents, max_workers: 2, max_reviewers: 3 }));
    expect(projectHealth({ tickets, threads, metrics: metrics(), spec, now: NOW }).capacity).toEqual({ workers: 2, maxWorkers: 2, reviewers: 2, maxReviewers: 3, readyWaiting: 3, handBacksWaiting: 0 });
    expect(projectHealth({ tickets: [ticket(1, "working"), ticket(3, "queued")], threads: [], metrics: metrics(), spec, now: NOW }).capacity.readyWaiting).toBe(0);
  });
});
