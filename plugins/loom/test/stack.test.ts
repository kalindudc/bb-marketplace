import { describe, expect, it } from "vitest";
import type { TicketRow } from "../src/db/store";
import { conflictWaits, holdOf, prBaseOf, restackOf, syncWanted, type Stack } from "../src/stack";
import type { TicketState } from "../src/states";

let seq = 0;
function row(key: string, state: TicketState, over: Partial<TicketRow> & { deps?: string[]; stack?: Partial<Stack> } = {}): TicketRow {
  seq += 1;
  const { deps = [], stack, ...rest } = over;
  return {
    id: seq,
    project_id: 1,
    seq,
    key,
    ref: key.toLowerCase(),
    title: key,
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
    pr_deliver_json: null,
    stack_json: stack === undefined ? null : JSON.stringify({ deps: {}, base: null, synced: 0, cross: {}, ...stack }),
    pr_base: null,
    start_wait_json: null,
    environment_json: null,
    created_by: "human",
    created_at: 0,
    updated_at: 0,
    state_at: 0,
    ...rest,
  };
}
const open = (key: string, sha: string, over: Parameters<typeof row>[2] = {}) => row(key, "pr_open", { pushed_sha: sha, pr_branch: `wt-${key}`, pr_url: `https://github.com/acme/shop/pull/${key}`, ...over });

describe("holdOf", () => {
  it("holds a pull request while two dependencies in its repo are open", () => {
    const a = open("A", "a1");
    const b = open("B", "b1");
    const c = row("C", "approved", { deps: ["A", "B"], stack: { deps: { A: "a1", B: "b1" }, base: "st1" } });
    expect(holdOf([a, b, c], c)).toEqual({ why: "merge", keys: ["A", "B"] });
  });

  it("holds it while its one open dependency has no pull request, and not for dependencies in other repos", () => {
    const a = row("A", "blocked", { repo: "web" });
    const b = open("B", "b1", { repo: "api" });
    const c = row("C", "approved", { repo: "web", deps: ["A", "B"] });
    expect(holdOf([a, b, c], c)).toEqual({ why: "push", keys: ["A"] });
  });

  it("holds it on the one open dependency until that branch took the base branch after a sibling merged", () => {
    const a = open("A", "a1", { stack: { synced: 100 } });
    const b = row("B", "done", { state_at: 200 });
    const c = row("C", "approved", { deps: ["A", "B"], stack: { deps: { A: "a1", B: "b1" }, base: "st1" } });
    expect(holdOf([a, b, c], c)).toEqual({ why: "sync", keys: ["A"] });
    expect(syncWanted([a, b, c], a)).toBe(true);

    const synced = { ...a, stack_json: JSON.stringify({ deps: {}, base: "tip", synced: 300, cross: {} }) };
    expect(holdOf([synced, b, c], c)).toBeNull();
    expect(syncWanted([synced, b, c], synced)).toBe(false);
  });

  it("does not hold a ticket with one open dependency and nothing merged", () => {
    const a = open("A", "a1");
    const c = row("C", "approved", { deps: ["A"], stack: { deps: { A: "a1" }, base: "a1" } });
    expect(holdOf([a, c], c)).toBeNull();
  });
});

describe("restackOf", () => {
  it("is null while the branch has each open dependency's newest commit", () => {
    const a = open("A", "a1");
    const c = open("C", "c1", { deps: ["A"], stack: { deps: { A: "a1" }, base: "a1" } });
    expect(restackOf([a, c], c)).toBeNull();
  });

  it("takes a dependency's new commit after a fix round", () => {
    const a = open("A", "a2");
    const c = open("C", "c1", { deps: ["A"], stack: { deps: { A: "a1" }, base: "a1" } });
    expect(restackOf([a, c], c)).toEqual({ deps: { A: "a2" }, commits: ["a2"], withBase: false });
  });

  it("takes the base branch once a dependency it is stacked on merged", () => {
    const a = row("A", "done", { pushed_sha: "a2" });
    const c = open("C", "c1", { deps: ["A"], stack: { deps: { A: "a2" }, base: "a2" } });
    expect(restackOf([a, c], c)).toEqual({ deps: {}, commits: [], withBase: true });
  });

  it("takes the base branch when a dependent waits for it, even with no dependency of its own", () => {
    const a = open("A", "a1");
    const b = row("B", "done", { state_at: 50 });
    const c = row("C", "approved", { deps: ["A", "B"], stack: { deps: { A: "a1", B: "b1" }, base: "st1" } });
    expect(restackOf([a, b, c], a)).toEqual({ deps: {}, commits: [], withBase: true });
  });

  it("leaves a ticket alone whose dependencies conflicted at these commits, and a ticket that never stacked", () => {
    const a = open("A", "a2");
    const b = open("B", "b1");
    const c = open("C", "c1", { deps: ["A", "B"], stack: { deps: { A: "a1", B: "b1" }, base: "st1", conflict: { on: { A: "a2", B: "b1" }, files: ["x.ts"] } } });
    expect(restackOf([a, b, c], c)).toBeNull();
    expect(conflictWaits([a, b, c], c)).toBe(true);
    expect(conflictWaits([{ ...a, pushed_sha: "a3" }, b, c], c)).toBe(false);
    const legacy = open("D", "d1", { deps: ["A"] });
    expect(restackOf([a, legacy], legacy)).toBeNull();
  });
});

describe("prBaseOf", () => {
  it("is the one open dependency's branch, else the base", () => {
    const a = open("A", "a1");
    const b = row("B", "done");
    const c = row("C", "approved", { deps: ["A", "B"] });
    expect(prBaseOf([a, b, c], c, "main")).toBe("wt-A");
    expect(prBaseOf([{ ...a, state: "done" }, b, c], c, "main")).toBe("main");
  });
});
