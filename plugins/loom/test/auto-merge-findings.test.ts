// Regressions for the independent review of Loom 0.32.0's auto-merge and reviewer requests: each test names its finding.
import { beforeEach, describe, expect, it } from "vitest";
import { attemptState, MERGE_ATTEMPT, setAutoMerge } from "../src/auto-merge";
import { Store, type ThreadRow } from "../src/db/store";
import type { HostOutput } from "../src/host-contract";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { askForPrTexts, handInPrText } from "../src/pull-requests";
import { pickReviewers, REVIEWERS_REQUESTED } from "../src/review-requests";
import { markLiveByHuman } from "../src/rollout-live";
import { parseSpec } from "../src/spec";
import { blockTicket } from "../src/workers";
import { requeueTicket } from "../src/requeue";
import { specOf, type EngineCtx } from "../src/ctx";
import { makeCtx, reachApproved, seedProject, specToml, ticketOf, type Doc, type EngineHarness } from "./helpers";

type Item = Extract<HostOutput<"prFeedback">, { outcome: "ok" }>["items"][number];

let h: EngineHarness & { db: ReturnType<typeof makeCtx>["db"] };
beforeEach(() => {
  h = makeCtx();
});

const URL = "https://github.com/acme/shop/pull/1";
const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const ticket = () => ticketOf(h, "CSV-1");
const posts = () => h.store.posts(ticket().id);
const dataOf = (outcome: string) => posts().filter((post) => (JSON.parse(post.data_json) as { outcome?: string }).outcome === outcome).map((post) => ({ post, data: JSON.parse(post.data_json) as Record<string, any> }));
const merges = () => h.host.callsTo("prMerge");
const poll = async (ctx: EngineCtx = h.ctx) => {
  h.clock.advance(5 * 60_000);
  await pollPullRequests(ctx, ctx.store.projectBySlug("csv")!);
};
const TEXT = { title: "Add order rows", body: "## Why\nSupport wants CSV exports.", commit_message: "Add the order row mapper" };

async function openPr(more: Doc = {}, edit?: (doc: Doc) => void): Promise<ThreadRow> {
  await seedProject(h, (doc) => {
    doc.merge = { strategy: "pr", draft: false, ...more };
    edit?.(doc);
  });
  const worker = await reachApproved(h);
  await askForPrTexts(h.ctx, project(), spec());
  handInPrText(h.ctx, worker.thread_id!, TEXT);
  await runMergeQueue(h.ctx, project(), spec());
  await settleMerges(h.ctx);
  expect(ticket().state).toBe("pr_open");
  return worker;
}
const approved = (more: Record<string, unknown> = {}) => h.host.prMeta.set(URL, { ...h.host.prMeta.get(URL), draft: false, review: "APPROVED", ...more });
const comment = (id: number, body: string, a: { at?: number; edit?: string } = {}): Item =>
  ({ key: `comment:${id}:${a.edit ?? "v1"}`, stableId: `comment:${id}`, createdAt: a.at ?? null, kind: "comment", author: "merge-service", bot: true, body, url: `${URL}#c${id}`, state: null, path: null, line: null }) as Item;
const COMMENT = { kind: "gh", auto_merge: { mode: "auto", method: "comment", comment: "/merge", rejected: ["❌*"] } };
const COMMAND = { kind: "command", open: "pr open", state: "pr state", feedback: "pr feedback", merge: "pr merge", auto_merge: { mode: "auto", method: "command", rejected: ["❌*"] } };
const TIMED_OUT = { outcome: "unavailable", message: "The forge's merge command took longer than 5 minutes", transient: "server" } as const;

/** Runs `during` inside the second projectCheckout of the next poll: the first is the poll's own read, the second auto-merge's. */
function duringMergeLookup(during: () => void): void {
  const real = h.bb.projectCheckout.bind(h.bb);
  let calls = 0;
  h.bb.projectCheckout = async (id: string, host: string) => {
    calls += 1;
    if (calls === 2) during();
    return real(id, host);
  };
}

describe("finding 1: an ambiguous answer from a comment or command merge keeps its attempt open", () => {
  it("does not post /merge again after gh answers a comment with a server error", async () => {
    await openPr({ forge: COMMENT });
    approved();
    h.host.scripted.prMerge = [{ outcome: "unavailable", message: "HTTP 502: Bad Gateway", transient: "server" }];
    await poll();
    await poll();
    await poll();
    expect(merges()).toHaveLength(1);
    expect(attemptState(h.store, ticket().id)).toMatchObject({ used: 1, open: expect.objectContaining({ n: 1 }) });
    expect(dataOf("auto_merge_unknown")).toHaveLength(1);
  });

  it("does not run a merge command again after it timed out, and max_attempts bounds the commands it runs", async () => {
    await openPr({ forge: { ...COMMAND, auto_merge: { ...COMMAND.auto_merge, max_attempts: 2 } } });
    h.host.feedback.set(URL, { draft: false, review: "APPROVED" });
    h.host.scripted.prMerge = [TIMED_OUT, TIMED_OUT, TIMED_OUT];
    await poll();
    await poll();
    expect(merges()).toHaveLength(1);
    setAutoMerge(h.store, project(), "retry", ticket());
    await poll();
    expect(merges()).toHaveLength(2);
    await poll();
    setAutoMerge(h.store, project(), "retry", ticket());
    await poll();
    await poll();
    // A cleared attempt does not count, so the human may clear and ask again; Loom alone never sends more than one per attempt.
    expect(merges().map((call) => call.attempt)).toEqual([1, 1, 1]);
  });

  it("still asks again after a temporary failure of an idempotent gh merge, which cannot merge twice", async () => {
    await openPr({ forge: { kind: "gh", auto_merge: { mode: "auto", method: "squash" } } });
    approved();
    h.host.scripted.prMerge = [{ outcome: "unavailable", message: "HTTP 502", transient: "server" }];
    await poll();
    await poll();
    expect(merges()).toHaveLength(2);
  });
});

describe("finding 2: what changes while Loom looks up the checkout stops the merge", () => {
  const cases: Array<[string, () => void]> = [
    ["the human pauses the project", () => h.store.setProjectState(project().id, "paused", "human")],
    ["the human turns auto-merge off for the project", () => void setAutoMerge(h.store, project(), "off", null)],
    ["the human turns auto-merge off for the ticket", () => void setAutoMerge(h.store, project(), "off", ticket())],
    ["the ticket is cancelled", () => h.store.setTicketState(ticket().id, "cancelled", "human", {})],
    ["a new commit is pushed", () => h.store.updateTicket(ticket().id, { pushed_sha: "sq-new" })],
    ["the forge withdraws its approval", () => h.store.updateTicket(ticket().id, { pr_meta_json: JSON.stringify({ ...JSON.parse(ticket().pr_meta_json!), review: "CHANGES_REQUESTED" }) })],
  ];
  it.each(cases)("sends nothing when %s during the lookup", async (_name, during) => {
    await openPr({ forge: { kind: "gh", auto_merge: { mode: "auto", method: "squash" } } });
    approved();
    duringMergeLookup(during);
    await poll();
    expect(merges()).toEqual([]);
    expect(h.store.ticketEvents(ticket().id, [MERGE_ATTEMPT])).toEqual([]);
  });
});

describe("finding 3: an old removal from the merge queue never settles a newer attempt", () => {
  it("keeps merging after the human turns it on again, while GitHub still shows the old manual removal", async () => {
    await openPr({ forge: { kind: "gh", auto_merge: { mode: "auto", method: "queue" } } });
    approved();
    await poll();
    // The removal lands 10 seconds before the attempt Loom makes once the human turns it on again, two polls from now.
    const old = { at: h.clock.now() + 10 * 60_000 - 10_000, reason: "manual" };
    h.host.queues.set(URL, { queued: false, auto: false, removed: old });
    await poll();
    expect(attemptState(h.store, ticket().id).off).toBe(true);
    setAutoMerge(h.store, project(), "on", ticket());
    await poll();
    expect(merges()).toHaveLength(2);
    h.host.queues.set(URL, { queued: true, auto: false, removed: old });
    await poll();
    await poll();
    expect(attemptState(h.store, ticket().id)).toMatchObject({ off: false, open: expect.objectContaining({ n: 1 }) });
    expect(dataOf("auto_merge_stopped")).toHaveLength(1);
  });

  it("does not let a removal override a pull request that is in the queue now", async () => {
    await openPr({ forge: { kind: "gh", auto_merge: { mode: "auto", method: "queue" } } });
    approved();
    await poll();
    h.host.queues.set(URL, { queued: true, auto: false, removed: { at: h.clock.now() + 1000, reason: "failed_checks" } });
    await poll();
    expect(ticket().state).toBe("pr_open");
    expect(attemptState(h.store, ticket().id).open).not.toBeNull();
  });
});

describe("finding 4: reviewers are asked only once the forge says the pull request is not a draft", () => {
  it("asks no one while a command forge's feedback leaves draft out", async () => {
    await openPr({ forge: { kind: "command", open: "o", state: "s", feedback: "f", request_reviews: "ask", reviewers: [{ users: ["alice"] }] } });
    h.host.feedback.set(URL, { author: "kalindudc" });
    await poll();
    expect(h.host.callsTo("prRequestReview")).toEqual([]);
    h.host.feedback.set(URL, { author: "kalindudc", draft: false });
    await poll();
    expect(h.host.callsTo("prRequestReview")).toHaveLength(1);
  });

  it("refuses reviewers on a command forge without a feedback command, which could never say", () => {
    const errors = parseSpec(specToml((doc) => void (doc.merge = { strategy: "pr", forge: { kind: "command", open: "o", state: "s", request_reviews: "ask", reviewers: [{ users: ["alice"] }] } }))).errors.join("\n");
    expect(errors).toContain("merge.forge.reviewers: Loom asks for reviews once the forge says the pull request is not a draft");
  });
});

describe("finding 5: at most 20 reviewers per pull request, and posts say only what was asked", () => {
  it("refuses rules that could pick more than 20 people", () => {
    const users = Array.from({ length: 25 }, (_, index) => `user${index}`);
    const errors = parseSpec(specToml((doc) => void (doc.merge = { strategy: "pr", forge: { kind: "gh", reviewers: [{ users }] } }))).errors.join("\n");
    expect(errors).toContain("merge.forge.reviewers: these rules may ask up to 25 people to review one pull request, and Loom asks at most 20");
    expect(parseSpec(specToml((doc) => void (doc.merge = { strategy: "pr", forge: { kind: "gh", reviewers: [{ users, count: 10 }, { team: "acme/edge", count: 10 }] } }))).errors).toEqual([]);
  });

  it("names someone the forge refused as not asked", async () => {
    await openPr({ forge: { kind: "gh", reviewers: [{ users: ["alice", "carol"] }] } });
    h.host.scripted.prRequestReview = [{ outcome: "ok", requested: ["alice"], failed: [{ login: "carol", message: "not a collaborator" }] }];
    await poll();
    const { post, data } = dataOf("reviewers_requested")[0]!;
    expect(data.requested).toEqual(["alice"]);
    expect(post.body).not.toMatch(/asked (alice and carol|carol and alice)/);
    expect(post.body).toContain("Loom could not ask carol: not a collaborator");
  });
});

describe("finding 6: the pull request's author never counts as one of its reviewers", () => {
  it("gives the author no credit for a review of their own pull request", () => {
    const pool = ["bob", "carol", "dave"].map((login) => ({ login, bot: false }));
    expect(pickReviewers(URL, pool, 1, { exclude: new Set(["bob"]), already: new Set(["bob"]) })).toMatchObject({ kept: [], short: 0, picked: [expect.not.stringMatching(/^bob$/)] });
  });

  it("asks someone else when the author reviewed their own pull request", async () => {
    await openPr({ forge: { kind: "gh", reviewers: [{ users: ["kalindudc", "alice"], count: 1 }] } });
    h.host.reviewState.set(URL, { author: "kalindudc", requested: [], reviewed: ["kalindudc"] });
    await poll();
    expect(h.host.callsTo("prRequestReview")[0]!.reviewers).toEqual(["alice"]);
  });
});

describe("finding 7: a command forge's review request runs at most once", () => {
  const FORGE = { kind: "command", open: "o", state: "s", feedback: "f", request_reviews: "ask", reviewers: [{ users: ["alice"] }] };

  it("does not run request_reviews again after its answer was lost", async () => {
    await openPr({ forge: FORGE });
    h.host.feedback.set(URL, { draft: false });
    h.host.scripted.prRequestReview = [Object.assign(new Error("Plugin RPC request failed"), { code: "transport_error" })];
    await poll();
    await poll();
    expect(h.host.callsTo("prRequestReview")).toHaveLength(1);
    expect(dataOf("reviewers_unknown")).toHaveLength(1);
  });

  it("does not run it again after it timed out", async () => {
    await openPr({ forge: FORGE });
    h.host.feedback.set(URL, { draft: false });
    h.host.scripted.prRequestReview = [{ outcome: "unknown", message: "The forge's request_reviews command took longer than 2 minutes" }];
    await poll();
    await poll();
    expect(h.host.callsTo("prRequestReview")).toHaveLength(1);
  });

  it("does not run it again after a restart between the send and its answer", async () => {
    await openPr({ forge: FORGE });
    h.host.feedback.set(URL, { draft: false });
    // A restart: the request was recorded and sent, and the process died before the answer came back.
    h.store.event(project().id, ticket().id, "ticket.reviewers_asking", "loom", { url: URL, reviewers: ["alice"] });
    const restarted: EngineCtx = { ...h.ctx, store: new Store(h.db, h.clock.now) };
    await poll(restarted);
    expect(h.host.callsTo("prRequestReview")).toEqual([]);
    expect(dataOf("reviewers_unknown")).toHaveLength(1);
  });

  it("tries a definite failure again, at most three times", async () => {
    await openPr({ forge: FORGE });
    h.host.feedback.set(URL, { draft: false });
    const failed = { outcome: "unavailable", message: "The forge's request_reviews command failed (exit 1): no such user" } as const;
    h.host.scripted.prRequestReview = [failed, failed, failed, failed];
    for (let index = 0; index < 5; index += 1) await poll();
    expect(h.host.callsTo("prRequestReview")).toHaveLength(3);
    expect(h.store.ticketEvents(ticket().id, [REVIEWERS_REQUESTED])).toHaveLength(1);
  });
});

describe("finding 8: only a comment made after the attempt rejects it", () => {
  it("is not turned away by an old failure comment someone edits", async () => {
    await openPr({ forge: COMMENT });
    approved();
    const before = h.clock.now() - 3_600_000;
    h.host.feedback.set(URL, { items: [comment(1, "❌ **Merge conflict** from yesterday", { at: before })] });
    await poll();
    expect(merges()).toHaveLength(1);
    h.host.feedback.set(URL, { items: [comment(1, "❌ **Merge conflict** from yesterday (edited)", { at: before, edit: "v2" })] });
    await poll();
    expect(ticket().state).toBe("pr_open");
    h.host.feedback.set(URL, { items: [comment(1, "❌ **Merge conflict** from yesterday (edited)", { at: before, edit: "v2" }), comment(2, "❌ **CI failure**", { at: h.clock.now() })] });
    await poll();
    expect(ticket().state).toBe("working");
  });

  it("is not turned away by a comment Merge Garden-like services post on their way: enqueued or waiting", async () => {
    await openPr({ forge: COMMENT });
    approved();
    await poll();
    h.host.feedback.set(URL, { items: [comment(3, "✅ **Pull request enqueued successfully**", { at: h.clock.now() }), comment(4, "👀 **Waiting for CI**", { at: h.clock.now() })] });
    await poll();
    expect(ticket().state).toBe("pr_open");
    expect(attemptState(h.store, ticket().id).open).not.toBeNull();
  });
});

describe("finding 9: a fresh budget applies to an attempt that was in flight when it was reset", () => {
  it("after on for the ticket, a rejection of the attempt in flight is a fix round, not the last attempt", async () => {
    await openPr({ forge: { kind: "gh", auto_merge: { mode: "auto", method: "queue", max_attempts: 2 } } });
    approved();
    await poll();
    // Attempt 1 never shows up in the queue, so it goes unconfirmed and attempt 2 is the last of the budget.
    h.clock.advance(20 * 60_000);
    await poll();
    await poll();
    expect(attemptState(h.store, ticket().id)).toMatchObject({ used: 2, open: expect.objectContaining({ n: 2 }) });
    setAutoMerge(h.store, project(), "on", ticket());
    h.host.queues.set(URL, { queued: false, auto: false, removed: { at: h.clock.now() + 60_000, reason: "failed_checks" } });
    await poll();
    expect(ticket().state).toBe("working");
    expect(dataOf("auto_merge_rejected")[0]!.post.body).toContain("an attempt from before its attempts were counted afresh");
  });

  it("after a block and a requeue back to the pull request, the same", async () => {
    await openPr({ forge: { ...COMMENT, auto_merge: { ...COMMENT.auto_merge, max_attempts: 1 } } });
    approved();
    await poll();
    await blockTicket(h.ctx, ticket(), { reason: "Waiting for a freeze", needs: "", actor: "human" });
    h.host.refs.set(`refs/heads/${ticket().branch}`, ticket().head_sha!);
    await requeueTicket(h.ctx, "CSV-1", { note: "", actor: "human", author: "human", review: true });
    expect(ticket().state).toBe("pr_open");
    h.host.feedback.set(URL, { items: [comment(6, "❌ **Merge conflict**", { at: h.clock.now() + 1000 })] });
    await poll();
    expect(ticket().state).toBe("working");
  });
});

describe("require_live, through the rollout's own transitions", () => {
  it("merges once a milestone the ticket requires is marked live", async () => {
    await openPr({ forge: { kind: "gh", auto_merge: { mode: "auto", method: "squash", require_live: true } } }, (doc) => {
      doc.ticket[0].rollout = { requires_live: ["schema-ready"] };
      doc.rollout = { milestone: [{ ref: "schema-ready", title: "The schema is migrated" }] };
    });
    approved();
    await poll();
    expect(merges()).toEqual([]);
    markLiveByHuman(h.ctx, "csv", "schema-ready", {}, "human");
    await poll();
    expect(merges()).toHaveLength(1);
  });

  it("waits for a milestone that gates the ticket's stage, which the ticket does not name", async () => {
    await openPr({ forge: { kind: "gh", auto_merge: { mode: "auto", method: "squash", require_live: true } } }, (doc) => {
      doc.ticket[0].rollout = { stage: "contract" };
      doc.rollout = { stage: [{ name: "contract", goal: "Only the new header is left" }], milestone: [{ ref: "old-zero", title: "Old traffic is zero", stage: "contract" }] };
    });
    approved();
    await poll();
    expect(merges()).toEqual([]);
    markLiveByHuman(h.ctx, "csv", "old-zero", {}, "human");
    await poll();
    expect(merges()).toHaveLength(1);
  });

  it("is not held by a required ticket that was cancelled", async () => {
    await openPr({ forge: { kind: "gh", auto_merge: { mode: "auto", method: "squash", require_live: true } } }, (doc) => {
      doc.ticket[1].depends_on = [];
      doc.ticket[0].rollout = { requires_live: ["csv-export"] };
    });
    approved();
    await poll();
    expect(merges()).toEqual([]);
    h.store.setTicketState(ticketOf(h, "CSV-2").id, "cancelled", "human", {});
    await poll();
    expect(merges()).toHaveLength(1);
  });
});

describe("a restart between recording an attempt and its answer", () => {
  it("never asks a merge service again from a fresh process", async () => {
    await openPr({ forge: COMMENT });
    approved();
    // The process died after recording the attempt and before the answer came back.
    h.store.event(project().id, ticket().id, MERGE_ATTEMPT, "loom", { url: URL, sha: ticket().pushed_sha, method: "comment", n: 1, known: [] });
    const restarted: EngineCtx = { ...h.ctx, store: new Store(h.db, h.clock.now) };
    await poll(restarted);
    await poll(restarted);
    expect(merges()).toEqual([]);
  });
});

describe("re-review 1: an answer that comes back after the human cleared its attempt", () => {
  it("does not throw on a late fixable rejection, and says on the ticket that Loom does not act on it", async () => {
    await openPr({ forge: COMMAND });
    h.host.feedback.set(URL, { draft: false, review: "APPROVED" });
    const real = h.host.call.bind(h.host);
    h.host.call = (async (hostId: string, method: string, input: unknown) => {
      if (method === "prMerge") {
        await real(hostId, method as never, input as never);
        setAutoMerge(h.store, project(), "retry", ticket());
        return { outcome: "rejected", fix: true, message: "Merge conflict in src/model/a.ts" };
      }
      return real(hostId, method as never, input as never);
    }) as typeof h.host.call;
    await expect(poll()).resolves.toBeUndefined();
    expect(ticket().state).toBe("pr_open");
    const late = dataOf("auto_merge_late");
    expect(late).toHaveLength(1);
    expect(late[0]!.post.body).toContain("Merge conflict in src/model/a.ts");
    expect(late[0]!.post.body).toContain("after it was cleared");
    expect(attemptState(h.store, ticket().id)).toMatchObject({ open: null, last: { outcome: "cleared" } });
  });
});

describe("re-review 3: a comment or command attempt a restart left with no answer", () => {
  it("is never sent again, and gets one post with the retry instruction", async () => {
    await openPr({ forge: COMMENT });
    approved();
    h.store.event(project().id, ticket().id, MERGE_ATTEMPT, "loom", { url: URL, sha: ticket().pushed_sha, method: "comment", n: 1, known: [] });
    const restarted: EngineCtx = { ...h.ctx, store: new Store(h.db, h.clock.now) };
    await poll(restarted);
    h.clock.advance(86_400_000);
    await poll(restarted);
    await poll(restarted);
    expect(merges()).toEqual([]);
    const unknown = dataOf("auto_merge_unknown");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.post.body).toContain("bb loom auto-merge csv retry --ticket CSV-1");
  });

  it("posts nothing extra for an attempt whose answer this process recorded", async () => {
    await openPr({ forge: COMMENT });
    approved();
    await poll();
    await poll();
    await poll();
    expect(dataOf("auto_merge_asked")).toHaveLength(1);
    expect(dataOf("auto_merge_unknown")).toEqual([]);
  });
});

describe("re-review 2: a request_reviews command stopped after it started", () => {
  it("is an unknown outcome, which Loom does not send again", async () => {
    await openPr({ forge: { kind: "command", open: "o", state: "s", feedback: "f", request_reviews: "ask", reviewers: [{ users: ["alice"] }] } });
    h.host.feedback.set(URL, { draft: false });
    h.host.scripted.prRequestReview = [{ outcome: "unknown", message: "The forge's request_reviews command was stopped before it finished: review assignment accepted" }];
    await poll();
    await poll();
    expect(h.host.callsTo("prRequestReview")).toHaveLength(1);
    expect(dataOf("reviewers_unknown")).toHaveLength(1);
  });
});
