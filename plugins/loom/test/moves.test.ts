import { beforeEach, describe, expect, it } from "vitest";
import { Store, StoreError, type TicketRow } from "../src/db/store";
import { MOVES, canTake, moveTicket, movesFrom, patchOf, tryMoveTicket, type MoveName } from "../src/moves";
import { canMoveTicket, type TicketState } from "../src/states";
import { Clock, makeDb } from "./helpers";

// Every ticket.state move a live database recorded, from 2,400 moves over seven projects.
const OBSERVED: Array<[TicketState, TicketState]> = [
  ["working", "checking"], ["queued", "working"], ["checking", "review"], ["review", "approved"], ["approved", "merging"],
  ["merging", "pr_open"], ["pr_open", "working"], ["working", "queued"], ["blocked", "queued"], ["checking", "pr_open"],
  ["working", "blocked"], ["review", "working"], ["checking", "working"], ["merging", "done"], ["pr_open", "merging"],
  ["merging", "working"], ["pr_open", "done"], ["review", "blocked"], ["pr_open", "queued"], ["pr_open", "blocked"],
  ["blocked", "cancelled"], ["queued", "cancelled"], ["blocked", "pr_open"], ["blocked", "review"], ["pr_open", "cancelled"],
  ["merging", "blocked"], ["merging", "cancelled"], ["merging", "queued"],
];

const names = Object.keys(MOVES) as MoveName[];

describe("the move table", () => {
  it("names a move for every move the live database recorded", () => {
    for (const [from, to] of OBSERVED) expect(names.filter((name) => MOVES[name].to === to && canTake(name, from)), `${from} to ${to}`).not.toEqual([]);
  });

  it("leaves only the states canMoveTicket lets go to its target", () => {
    for (const name of names) for (const from of movesFrom(name)) expect(canMoveTicket(from, MOVES[name].to), `${name} from ${from}`).toBe(true);
  });

  it("resets what a requeue, a review again, a block and a cancel let go of", () => {
    expect(patchOf({ name: "requeue" })).toEqual({
      worker_thread_id: null, environment_id: null, failures: 0, check_failures: 0, blocked_reason: null,
      pr_ask_json: null, pr_text_json: null, handback_json: null, start_wait_json: null, retry_json: null,
    });
    expect(patchOf({ name: "review_again" })).toEqual({ worker_thread_id: null, environment_id: null, failures: 0, check_failures: 0, blocked_reason: null, pr_ask_json: null, handback_json: null, start_wait_json: null, retry_json: null });
    expect(patchOf({ name: "pr_again" })).toMatchObject({ pr_text_json: null, retry_json: null, pr_checked_at: null, blocked_reason: null });
    expect(patchOf({ name: "human_block" })).toEqual({});
    expect(patchOf({ name: "cancel" })).toEqual({ worker_thread_id: null, environment_id: null });
    expect(patchOf({ name: "block_unreachable" })).toEqual({ worker_thread_id: null, environment_id: null, handback_json: null });
    expect(patchOf({ name: "block_pr_closed" })).toMatchObject({ pr_branch: null, pushed_sha: null, pr_seen_json: "[]", pr_rounds: 0, pr_applied_json: null, worker_thread_id: null });
  });

  it("lets what a move sets win over what it resets", () => {
    expect(patchOf({ name: "start_failed", set: { start_wait_json: "{}" } })).toMatchObject({ start_wait_json: "{}", worker_thread_id: null });
  });
});

describe("moving a ticket", () => {
  let store: Store;
  let ticket: TicketRow;
  beforeEach(() => {
    store = new Store(makeDb(), new Clock().now);
    const project = store.createProject({ slug: "csv", name: "CSV", key: "CSV", bb_project_id: "proj_1" }, "human");
    ticket = store.createTicket({ project_id: project.id, seq: 1, key: "CSV-1", ref: "one", title: "One", body: "Do it.", acceptance_json: "[]", verify_json: "[]", scope_json: "[]", deps_json: "[]", priority: 2 }, "human");
  });

  it("writes the state, the resets and the event, and flags triage for a block", () => {
    store.updateTicket(ticket.id, { worker_thread_id: "thr_1", environment_id: "env_1" });
    expect(tryMoveTicket(store, ticket.id, { name: "start" })).toBe(true);
    expect(store.ticket(ticket.id)).toMatchObject({ state: "working", worker_thread_id: null, environment_id: null });
    store.updateTicket(ticket.id, { worker_thread_id: "thr_2" });
    expect(tryMoveTicket(store, ticket.id, { name: "block", set: { failures: 3, blocked_reason: "why" } }, "loom", { reason: "why" })).toBe(true);
    expect(store.ticket(ticket.id)).toMatchObject({ state: "blocked", worker_thread_id: null, failures: 3, blocked_reason: "why" });
    expect(JSON.parse(store.events(ticket.project_id).at(-1)!.data_json)).toEqual({ from: "working", to: "blocked", reason: "why", failures: 3 });
    expect(store.project(ticket.project_id)!.triage_pending).toBe(1);
  });

  it("refuses a move from a state it does not leave, and writes nothing", () => {
    expect(tryMoveTicket(store, ticket.id, { name: "approve" })).toBe(false);
    expect(store.ticket(ticket.id)!.state).toBe("queued");
    expect(() => moveTicket(store, ticket.id, { name: "approve" })).toThrow(StoreError);
  });
});
