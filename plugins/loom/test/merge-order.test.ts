import { describe, expect, it } from "vitest";
import type { TicketRow } from "../src/db/store";
import { mergeOrderOf, type MergeEntry } from "../src/merge-order";
import type { PrMeta } from "../src/pr-meta";
import { parseSpec, type Spec } from "../src/spec";
import type { TicketState } from "../src/states";
import { withRepos } from "./fixtures";
import { specToml } from "./helpers";

// web merges into main and api into trunk, as withRepos sets them up.
const spec: Spec = parseSpec(
  specToml((doc) => {
    withRepos(doc);
    delete doc.repo[0].after_merge;
    doc.merge = { strategy: "pr" };
  }),
).spec!;

let seq = 0;
type Over = Partial<TicketRow> & { deps?: string[]; after?: string[]; meta?: Partial<PrMeta>; checks?: { passed: number; failed: number; pending: number } };
function row(key: string, state: TicketState, over: Over = {}): TicketRow {
  seq += 1;
  const { deps = [], after = [], meta, checks, ...rest } = over;
  const pr = state !== "queued" && state !== "working";
  return {
    id: seq,
    project_id: 1,
    seq,
    key,
    ref: key.toLowerCase(),
    title: `${key} title`,
    body: "",
    acceptance_json: "[]",
    verify_json: "[]",
    scope_json: "[]",
    deps_json: JSON.stringify(deps),
    priority: 2,
    state,
    attempt: 1,
    failures: 0,
    check_failures: 0,
    review_round: 1,
    branch: `wt-${key}`,
    environment_id: null,
    worker_thread_id: null,
    head_sha: null,
    merge_before: null,
    pr_url: pr ? `https://github.com/acme/web/pull/${seq}` : null,
    pr_checked_at: null,
    blocked_reason: null,
    repo: "web",
    pr_branch: pr ? `loom/${key.toLowerCase()}` : null,
    pushed_sha: pr ? `sha-${key}` : null,
    pushed_at: null,
    pr_ask_json: null,
    pr_text_json: null,
    pr_seen_json: "[]",
    pr_rounds: 0,
    pr_status_json: checks === undefined ? null : JSON.stringify({ at: 0, head: "h", ...checks }),
    handback_json: null,
    stack_json: null,
    pr_base: null,
    start_wait_json: null,
    environment_json: null,
    pr_poll_json: null,
    merge_after_json: JSON.stringify(after),
    pr_meta_json: meta === undefined ? null : JSON.stringify({ at: 0, draft: null, review: null, base: null, ...meta }),
    created_by: "human",
    created_at: 0,
    updated_at: 0,
    state_at: 0,
    ...rest,
  };
}

const green = { passed: 5, failed: 0, pending: 0 };
const approved = { draft: false, review: "APPROVED" as const };
const byKey = (entries: MergeEntry[]) => Object.fromEntries(entries.map((entry) => [entry.key, entry]));

describe("mergeOrderOf", () => {
  it("is null on the integration strategy", () => {
    const integration = parseSpec(specToml()).spec!;
    expect(mergeOrderOf(integration, [row("CSV-1", "pr_open")])).toBeNull();
  });

  it("puts a stack in steps, one after the other, and counts what is first", () => {
    const a = row("CSV-1", "pr_open", { checks: green, meta: approved });
    const b = row("CSV-2", "pr_open", { deps: ["CSV-1"], pr_base: "loom/csv-1", checks: green });
    const c = row("CSV-3", "pr_open", { deps: ["CSV-2"], pr_base: "loom/csv-2" });
    const order = mergeOrderOf(spec, [a, b, c])!;
    const entries = byKey(order.entries);
    expect([entries["CSV-1"]!.step, entries["CSV-2"]!.step, entries["CSV-3"]!.step]).toEqual([1, 2, 3]);
    expect(entries["CSV-2"]).toMatchObject({ stackedOn: "CSV-1", verdict: "after", waitsOn: [{ key: "CSV-1", why: "stacked", repo: "web", prNumber: String(a.seq) }] });
    expect(entries["CSV-1"]).toMatchObject({ verdict: "ready", unblocks: ["CSV-2"], base: "main" });
    expect(order).toMatchObject({ steps: 3, repos: ["web", "api"], counts: { open: 3, first: 1, ready: 1, wrong: 0 } });
  });

  it("orders a dependency in another repo without stacking, and reads that repo's base", () => {
    const web = row("CSV-1", "pr_open", { checks: green, meta: approved });
    const api = row("CSV-2", "pr_open", { repo: "api", deps: ["CSV-1"], pr_base: "trunk", checks: green, meta: approved });
    const entries = byKey(mergeOrderOf(spec, [web, api])!.entries);
    expect(entries["CSV-2"]).toMatchObject({ step: 2, stackedOn: null, base: "trunk", verdict: "after", waitsOn: [{ key: "CSV-1", why: "depends", repo: "web" }] });
  });

  it("waits on merge_after like a dependency, and a merged one waits on nothing", () => {
    const merged = row("CSV-1", "done");
    const proxy = row("CSV-2", "pr_open", { checks: green, meta: approved });
    const client = row("CSV-3", "pr_open", { after: ["CSV-2", "CSV-1"], checks: green, meta: approved });
    const entries = byKey(mergeOrderOf(spec, [merged, proxy, client])!.entries);
    expect(entries["CSV-3"]).toMatchObject({ step: 2, verdict: "after", waitsOn: [{ key: "CSV-2", why: "merge_after" }] });
    expect(entries["CSV-1"]).toMatchObject({ step: 0, verdict: "merged" });
  });

  it("says what holds a pull request with nothing before it, and does not call one ready that the forge says nothing about", () => {
    const draft = row("CSV-1", "pr_open", { checks: { passed: 3, failed: 1, pending: 2 }, meta: { draft: true, review: "REVIEW_REQUIRED" } });
    const fixing = row("CSV-2", "working", { pr_url: "https://github.com/acme/web/pull/9", pushed_sha: "sq1", checks: green, meta: approved });
    const unread = row("CSV-3", "pr_open", { checks: green, meta: { draft: null, review: null } });
    const never = row("CSV-4", "pr_open", { checks: green });
    const entries = byKey(mergeOrderOf(spec, [draft, fixing, unread, never])!.entries);
    expect(entries["CSV-1"]).toMatchObject({ verdict: "first", holds: ["draft", "needs review", "1 check failing", "2 checks pending"] });
    expect(entries["CSV-2"]).toMatchObject({ verdict: "first", holds: ["Loom is pushing a fix"] });
    expect(entries["CSV-3"]).toMatchObject({ verdict: "checks_pass", reviewRead: false });
    expect(entries["CSV-4"]).toMatchObject({ verdict: "checks_pass", reviewRead: false });
  });

  it("flags a stacked pull request the forge shows approved while its parent is open", () => {
    const parent = row("CSV-1", "pr_open", { meta: { draft: false, review: "REVIEW_REQUIRED" } });
    const child = row("CSV-2", "pr_open", { deps: ["CSV-1"], pr_base: "loom/csv-1", checks: green, meta: approved });
    const order = byKey(mergeOrderOf(spec, [parent, child])!.entries);
    expect(order["CSV-2"]).toMatchObject({ trap: true, verdict: "after" });
    expect(order["CSV-1"]!.trap).toBe(false);
  });

  it("trusts the base the forge reported over the one Loom asked for", () => {
    const parent = row("CSV-1", "done");
    const child = row("CSV-2", "pr_open", { deps: ["CSV-1"], pr_base: "loom/csv-1", checks: green, meta: { ...approved, base: "main" } });
    expect(byKey(mergeOrderOf(spec, [parent, child])!.entries)["CSV-2"]).toMatchObject({ verdict: "ready", stackedOn: null, step: 1 });
  });

  it("waits for Loom to move a pull request whose parent merged while it still targets the parent's branch", () => {
    const parent = row("CSV-1", "done");
    const child = row("CSV-2", "pr_open", { deps: ["CSV-1"], pr_base: "loom/csv-1", checks: green, meta: approved });
    expect(byKey(mergeOrderOf(spec, [parent, child])!.entries)["CSV-2"]).toMatchObject({ verdict: "moving", step: 1, waitsOn: [] });
  });

  it("finds a pull request that merged into an open ticket's branch, done before the guard and blocked by it after", () => {
    const parent = row("CSV-1", "pr_open");
    const before = row("CSV-2", "done", { deps: ["CSV-1"], pr_base: "loom/csv-1" });
    const after = row("CSV-3", "blocked", { deps: ["CSV-1"], pr_base: "loom/csv-1", blocked_reason: "Its pull request merged into CSV-1's branch.", meta: { base: "loom/csv-1", state: "MERGED" } });
    const order = mergeOrderOf(spec, [parent, before, after])!;
    const entries = byKey(order.entries);
    expect(entries["CSV-2"]).toMatchObject({ verdict: "merged_elsewhere", mergedInto: "CSV-1", step: 0 });
    expect(entries["CSV-3"]).toMatchObject({ verdict: "merged_elsewhere", mergedInto: "CSV-1", step: 0, waitsOn: [] });
    expect(order.counts.wrong).toBe(2);
  });

  it("keeps a plain merged stack and other blocks as they are", () => {
    const parent = row("CSV-1", "done");
    const child = row("CSV-2", "done", { deps: ["CSV-1"], pr_base: "loom/csv-1" });
    const stuck = row("CSV-3", "blocked", { blocked_reason: "Its checks failed three times." });
    const entries = byKey(mergeOrderOf(spec, [parent, child, stuck])!.entries);
    expect(entries["CSV-2"]!.verdict).toBe("merged");
    expect(entries["CSV-3"]).toMatchObject({ verdict: "blocked", blockedReason: "Its checks failed three times.", step: 1 });
  });

  it("leaves cancelled tickets out and gives a ticket with no pull request yet its step", () => {
    const gone = row("CSV-1", "cancelled");
    const first = row("CSV-2", "pr_open", { checks: green, meta: approved });
    const later = row("CSV-3", "queued", { deps: ["CSV-2", "CSV-1"] });
    const order = mergeOrderOf(spec, [gone, first, later])!;
    expect(order.entries.map((entry) => entry.key)).toEqual(["CSV-2", "CSV-3"]);
    expect(byKey(order.entries)["CSV-3"]).toMatchObject({ step: 2, verdict: "after", prUrl: null });
    expect(order.counts).toEqual({ open: 1, first: 1, ready: 1, wrong: 0 });
  });

  it("calls a pull request ready only when its checks are read and passed and the forge says it is approved and no draft", () => {
    const unread = row("CSV-1", "pr_open", { meta: approved });
    const noReview = row("CSV-2", "pr_open", { checks: green, meta: { draft: false, review: null } });
    const draftUnknown = row("CSV-3", "pr_open", { checks: green, meta: { draft: null, review: "APPROVED" } });
    const entries = byKey(mergeOrderOf(spec, [unread, noReview, draftUnknown])!.entries);
    expect(entries["CSV-1"]).toMatchObject({ verdict: "first", holds: ["checks not read"] });
    expect(entries["CSV-2"]!.verdict).toBe("checks_pass");
    expect(entries["CSV-3"]!.verdict).toBe("checks_pass");
  });

  it("holds a pull request that targets a branch that is neither its base nor another ticket's", () => {
    const retargeted = row("CSV-1", "pr_open", { checks: green, meta: { ...approved, base: "release" } });
    expect(byKey(mergeOrderOf(spec, [retargeted])!.entries)["CSV-1"]).toMatchObject({ verdict: "first", elsewhere: "release", holds: ["targets release, not main"], stackedOn: null });
  });

  it("stops counting a merge into another ticket's branch as wrong once that ticket merged too, and says which state it is in", () => {
    const parent = row("CSV-1", "done", { pr_branch: "loom/csv-1" });
    const child = row("CSV-2", "blocked", { deps: ["CSV-1"], pr_base: "loom/csv-1", pushed_sha: null, meta: { base: "loom/csv-1", state: "MERGED" } });
    const order = mergeOrderOf(spec, [parent, child])!;
    expect(byKey(order.entries)["CSV-2"]).toMatchObject({ verdict: "merged_elsewhere", mergedInto: "CSV-1", mergedIntoState: "done", prOpen: false });
    expect(order.counts.wrong).toBe(0);
  });

  it("leaves out the closed pull request of a ticket requeued after it, until a new one opens", () => {
    const redone = row("CSV-1", "working", { pr_url: "https://github.com/acme/web/pull/12", pushed_sha: null });
    expect(byKey(mergeOrderOf(spec, [redone])!.entries)["CSV-1"]).toMatchObject({ prUrl: null, prNumber: null, verdict: "no_pr", prOpen: false });
  });

  it("does not count a pull request Loom let go of, such as a closed one, as open", () => {
    const closed = row("CSV-1", "blocked", { pushed_sha: null, pr_branch: null, meta: { state: "CLOSED" } });
    const live = row("CSV-2", "pr_open", { checks: green, meta: approved });
    const order = mergeOrderOf(spec, [closed, live])!;
    expect(order.entries.map((entry) => [entry.key, entry.prOpen])).toEqual([
      ["CSV-1", false],
      ["CSV-2", true],
    ]);
    expect(order.counts).toMatchObject({ open: 1, first: 1 });
  });
});
