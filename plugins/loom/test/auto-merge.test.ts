import { beforeEach, describe, expect, it } from "vitest";
import { attemptState, MERGE_ATTEMPT, setAutoMerge } from "../src/auto-merge";
import type { ThreadRow } from "../src/db/store";
import type { HostOutput } from "../src/host-contract";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { askForPrTexts, handInPrText } from "../src/pull-requests";
import { pickReviewers, REVIEWERS_REQUESTED } from "../src/review-requests";
import { parseSpec, specHash } from "../src/spec";
import { specOf } from "../src/ctx";
import { makeCtx, reachApproved, seedProject, ticketOf, type Doc, type EngineHarness, specToml } from "./helpers";

type Item = Extract<HostOutput<"prFeedback">, { outcome: "ok" }>["items"][number];

let h: EngineHarness;
beforeEach(() => {
  h = makeCtx();
});

const URL = "https://github.com/acme/shop/pull/1";
const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const ticket = () => ticketOf(h, "CSV-1");
const posts = () => h.store.posts(ticket().id);
const outcomes = () => posts().map((post) => (JSON.parse(post.data_json) as { outcome?: string }).outcome).filter((outcome) => outcome !== undefined);
const dataOf = (outcome: string) => posts().filter((post) => (JSON.parse(post.data_json) as { outcome?: string }).outcome === outcome).map((post) => ({ post, data: JSON.parse(post.data_json) as Record<string, any> }));
const merges = () => h.host.callsTo("prMerge");
const pr = (more: Doc = {}) => (doc: Doc) => {
  doc.merge = { strategy: "pr", draft: false, ...more };
};
const poll = async () => {
  h.clock.advance(5 * 60_000);
  await pollPullRequests(h.ctx, project());
};
const TEXT = { title: "Add order rows", body: "## Why\nSupport wants CSV exports.", commit_message: "Add the order row mapper" };

async function openPr(more: Doc = {}, edit?: (doc: Doc) => void): Promise<ThreadRow> {
  await seedProject(h, (doc) => {
    pr(more)(doc);
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
const comment = (key: string, body: string, author = "merge-service"): Item => ({ key, kind: "comment", author, bot: true, body, url: `${URL}#${key}`, state: null, path: null, line: null });
const squash = { kind: "gh", auto_merge: { mode: "auto", method: "squash" } };

describe("auto-merge in the spec", () => {
  it("hashes a spec without the new settings exactly as Loom 0.31.1 did", () => {
    // These change only with the schema's defaults, as when checks.timeout_minutes and agents.ticket_timeout_minutes moved to 25 and 180; a forge key with a default would change them.
    const hashes: Array<[string, (doc: Doc) => void, string]> = [
      ["integration", () => undefined, "ec4db17c8f33d8784e27bedf73090eea62eb910519cf218d0e15f22dd1ad1a06"],
      ["pr", (doc) => void (doc.merge = { strategy: "pr" }), "83bdaed517e78f6b9f00f34d3e747a918b94b279b17626c3dceb7cde68225bec"],
      ["gh forge", (doc) => void (doc.merge = { strategy: "pr", forge: { kind: "gh", after_push: ["ci run"], ignore_checks: ["Bot*"] } }), "97017015fbb619977de7cb29f42305eb4a2b50bc0fd51c668ccb98769dca0bc2"],
      ["command forge", (doc) => void (doc.merge = { strategy: "pr", forge: { kind: "command", open: "pr open", state: "pr state", feedback: "pr feedback", retarget: "pr retarget" } }), "2187177dc9ce30728795ad977b0c24369212cb04c0c40fe265084de376176561"],
    ];
    for (const [name, edit, hash] of hashes) {
      const parsed = parseSpec(specToml(edit));
      expect(parsed.errors, name).toEqual([]);
      expect(specHash(parsed.spec!), name).toBe(hash);
      expect(parsed.spec!.merge.forge?.auto_merge, name).toBeUndefined();
      expect(parsed.spec!.merge.forge?.reviewers, name).toBeUndefined();
    }
  });

  it("takes each method on the forge it belongs to, and leaves its unset keys unset", () => {
    for (const forge of [
      { kind: "gh", auto_merge: { method: "squash" } },
      { kind: "gh", auto_merge: { method: "queue", require_live: true, max_attempts: 5 } },
      { kind: "gh", auto_merge: { method: "comment", comment: "/merge", rejected: ["Merge failed*"] } },
      { kind: "command", open: "o", state: "s", feedback: "f", merge: "m", auto_merge: { method: "command", rejected: ["x*"] } },
    ]) {
      const parsed = parseSpec(specToml(pr({ forge })));
      expect(parsed.errors, JSON.stringify(forge)).toEqual([]);
      expect(parsed.spec!.merge.forge!.auto_merge).toEqual(forge.auto_merge);
    }
  });

  it("refuses a method, a key or a forge that cannot merge, and warns when a merge service's refusal cannot be seen", () => {
    const errors = (forge: Doc, more: Doc = {}) => parseSpec(specToml(pr({ forge, ...more }))).errors.join("\n");
    expect(errors({ kind: "gh", auto_merge: { method: "command" } })).toContain('"command" runs a kind = "command" forge\'s merge command');
    expect(errors({ kind: "gh", auto_merge: { method: "comment" } })).toContain("auto_merge.comment: is required with method = \"comment\"");
    expect(errors({ kind: "gh", auto_merge: { method: "squash", comment: "/merge" } })).toContain("only method = \"comment\" posts it");
    expect(errors({ kind: "gh", auto_merge: { method: "queue", rejected: ["x"] } })).toContain("merge queue says itself");
    expect(errors({ kind: "gh", merge: "x", auto_merge: { method: "squash" } })).toContain('merge.forge.merge: only kind = "command" runs it');
    expect(errors({ kind: "command", open: "o", state: "s", feedback: "f", auto_merge: { method: "squash" } })).toContain('Use method = "command"');
    expect(errors({ kind: "command", open: "o", state: "s", feedback: "f", auto_merge: { method: "command" } })).toContain("merge.forge.merge: is required with auto_merge");
    expect(errors({ kind: "command", open: "o", state: "s", merge: "m", auto_merge: { method: "command" } }, {})).toContain("no feedback command to say so");
    expect(errors({ kind: "command", open: "o", state: "s", feedback: "f", merge: "m" })).toContain("only auto_merge runs it");
    expect(errors({ kind: "none", auto_merge: { method: "squash" } })).toContain('kind = "none" opens no pull request, so there is nothing to merge');
    expect(errors({ kind: "gh", auto_merge: { method: "squash" } }, { max_fix_rounds: 0 })).toContain("merge.max_fix_rounds is 0");
    const integration = parseSpec(specToml((doc) => void (doc.merge = { strategy: "integration", forge: { kind: "gh", auto_merge: { method: "squash" }, reviewers: [{ users: ["alice"] }] } }))).errors.join("\n");
    expect(integration).toContain('merge.forge.auto_merge: it merges the pull request Loom opens for each ticket, but merge.strategy is "integration"');
    expect(integration).toContain("merge.forge.reviewers: it asks for reviews of the pull request");
    const warned = parseSpec(specToml(pr({ forge: { kind: "gh", auto_merge: { method: "comment", comment: "/merge" } } })));
    expect(warned.errors).toEqual([]);
    expect(warned.warnings.join("\n")).toContain("merge.forge.auto_merge.rejected: unset");
  });

  it("refuses a reviewer rule without users, a team and team_members, and a command forge that cannot ask", () => {
    const errors = (forge: Doc) => parseSpec(specToml(pr({ forge }))).errors.join("\n");
    const why = "Loom no longer reads this key. A reviewers rule names its people in users, with an optional count to pick from them: remove the key.";
    expect(errors({ kind: "gh", reviewers: [{ count: 1 }] })).toContain("merge.forge.reviewers[0].users: is required. Add it.");
    expect(errors({ kind: "gh", reviewers: [{ team: "acme/a", users: ["bob"], count: 1 }] })).toBe(`merge.forge.reviewers[0].team: ${why}`);
    expect(errors({ kind: "command", open: "o", state: "s", feedback: "f", request_reviews: "r", team_members: "t", reviewers: [{ users: ["bob"] }] })).toBe(`merge.forge.team_members: ${why}`);
    expect(errors({ kind: "gh", reviewers: [{ users: ["a", "b"], count: 3 }] })).toContain("3 is more than the 2 logins in users");
    expect(errors({ kind: "command", open: "o", state: "s", feedback: "f", reviewers: [{ users: ["bob"] }] })).toContain("request_reviews: is required with reviewers");
    expect(errors({ kind: "gh", reviewers: [{ users: ["alice@example.com", "bob"], count: 1 }] })).toBe("");
  });
});

describe("merging a ready pull request", () => {
  it("squash-merges once Ready to merge holds, on the pushed commit, and the next read completes the ticket", async () => {
    await openPr({ forge: squash });
    await poll();
    expect(merges()).toEqual([]);
    approved();
    await poll();
    const t = ticket();
    expect(merges()).toEqual([expect.objectContaining({ url: URL, sha: t.pushed_sha, head: t.pr_branch, base: "main", attempt: 1, forge: { kind: "gh", method: "squash" } })]);
    expect(dataOf("auto_merge_asked")[0]!.post.body).toContain("squash-merged it");
    expect(t.pr_checked_at).toBeNull();
    h.host.prStates.set(URL, "MERGED");
    await pollPullRequests(h.ctx, project());
    expect(ticket().state).toBe("done");
    expect(merges()).toHaveLength(1);
  });

  it("never merges a draft, one the forge has not approved, or one whose checks fail", async () => {
    await openPr({ forge: squash, draft: true });
    approved({ draft: true });
    await poll();
    approved({ review: "REVIEW_REQUIRED" });
    await poll();
    approved({ draft: null });
    await poll();
    approved();
    h.host.feedback.set(URL, { checks: [{ key: "c1", name: "test", state: "pending", url: null }] });
    await poll();
    expect(merges()).toEqual([]);
  });

  it("asks for no merge while the branch has commits someone else pushed, which Loom has not reviewed", async () => {
    await openPr({ forge: { kind: "gh", auto_merge: { mode: "auto", method: "comment", comment: "/merge" } } });
    approved();
    h.host.feedback.set(URL, { head: "someone-else" });
    await poll();
    expect(merges()).toEqual([]);
    h.host.feedback.set(URL, { head: ticket().pushed_sha! });
    await poll();
    expect(merges()).toHaveLength(1);
  });

  it("merges only once the forge says it is approved, and refuses auto_merge.approval", async () => {
    await openPr({ forge: squash });
    approved({ review: null });
    await poll();
    expect(merges()).toEqual([]);
    expect(parseSpec(specToml(pr({ forge: { kind: "gh", auto_merge: { method: "squash", approval: "loom" } } }))).errors).toEqual([
      "merge.forge.auto_merge.approval: Loom no longer reads this key. Loom merges only once the forge says a person approved the pull request: remove the key.",
    ]);
  });

  it("waits out a freeze window, saying so once per commit", async () => {
    await openPr({ forge: squash }, (doc) => void (doc.rollout = { window: [{ title: "New Year freeze", from: "2027-01-01", to: "2027-01-31" }] }));
    approved();
    await poll();
    await poll();
    expect(merges()).toEqual([]);
    expect(dataOf("auto_merge_held").map(({ data }) => data.holds)).toEqual([["the New Year freeze window is on until 2027-01-31"]]);
  });

  it("with require_live waits until what the ticket's rollout requires is live", async () => {
    await openPr({ forge: { kind: "gh", auto_merge: { mode: "auto", method: "squash", require_live: true } } }, (doc) => {
      doc.ticket[0].rollout = { requires_live: ["schema-ready"] };
      doc.rollout = { milestone: [{ ref: "schema-ready", title: "The schema is migrated" }] };
    });
    approved();
    await poll();
    expect(merges()).toEqual([]);
    expect(dataOf("auto_merge_held")[0]!.data.holds).toEqual(["schema-ready is not live yet"]);
  });

  it("asks a merge service once per attempt, and a new comment it rejects with starts a fix round with its words", async () => {
    const worker = await openPr({ forge: { kind: "gh", auto_merge: { mode: "auto", method: "comment", comment: "/merge", rejected: ["❌*"] } } });
    h.host.feedback.set(URL, { items: [comment("comment:1", "❌ **CI failure** from an older attempt")] });
    approved();
    await poll();
    expect(merges()).toEqual([expect.objectContaining({ forge: { kind: "gh", method: "comment", comment: "/merge" } })]);
    await poll();
    expect(merges()).toHaveLength(1);
    expect(ticket().state).toBe("pr_open");
    h.host.feedback.set(URL, { items: [comment("comment:1", "❌ **CI failure** from an older attempt"), comment("comment:2", "❌ **Merge conflict**\n\nThis PR conflicts with `main`.")] });
    await poll();
    expect(ticket().state).toBe("working");
    expect(outcomes()).toContain("auto_merge_rejected");
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("This PR conflicts with `main`.");
    expect(attemptState(h.store, ticket().id)).toMatchObject({ used: 1, open: null, last: { outcome: "rejected" } });
  });

  it("blocks once a rejection uses up the last attempt", async () => {
    await openPr({ forge: { kind: "gh", auto_merge: { mode: "auto", method: "comment", comment: "/merge", rejected: ["Merge failed*"], max_attempts: 1 } } });
    approved();
    await poll();
    h.host.feedback.set(URL, { items: [comment("comment:7", "Merge failed: the queue's CI failed.")] });
    await poll();
    expect(ticket().state).toBe("blocked");
    expect(ticket().blocked_reason).toContain("last allowed attempt (attempt 1 of 1)");
  });

  it("follows GitHub's merge queue: a removal for failed checks is a fix round, and a person's removal turns it off", async () => {
    await openPr({ forge: { kind: "gh", auto_merge: { mode: "auto", method: "queue" } } });
    approved();
    await poll();
    expect(merges()).toEqual([expect.objectContaining({ forge: { kind: "gh", method: "queue" } })]);
    expect(h.host.callsTo("prBatch").at(-1)).toMatchObject({ queue: true });
    h.host.queues.set(URL, { queued: true, auto: false, removed: null });
    await poll();
    expect(ticket().state).toBe("pr_open");
    h.host.queues.set(URL, { queued: false, auto: false, removed: { at: h.clock.now(), reason: "failed_checks" } });
    await poll();
    expect(ticket().state).toBe("working");
    expect(dataOf("auto_merge_rejected")[0]!.post.body).toContain("GitHub's merge queue removed the pull request: failed checks.");
  });

  it("stops when a person takes the pull request out of the merge queue, until the human turns it on again", async () => {
    await openPr({ forge: { kind: "gh", auto_merge: { mode: "auto", method: "queue" } } });
    approved();
    await poll();
    h.host.queues.set(URL, { queued: false, auto: false, removed: { at: h.clock.now(), reason: "manual" } });
    await poll();
    expect(outcomes()).toContain("auto_merge_stopped");
    h.host.queues.set(URL, { queued: false, auto: false, removed: null });
    await poll();
    expect(merges()).toHaveLength(1);
    setAutoMerge(h.store, project(), "on", ticket());
    await poll();
    expect(merges()).toHaveLength(2);
  });

  it("runs a command forge's merge: exit 3's words start a fix round, and exit 4's block the ticket", async () => {
    const forge = { kind: "command", open: "pr open", state: "pr state", feedback: "pr feedback", merge: "pr merge", auto_merge: { mode: "auto", method: "command" } };
    await openPr({ forge });
    h.host.feedback.set(URL, { draft: false, review: "APPROVED" });
    h.host.scripted.prMerge = [{ outcome: "rejected", fix: true, message: "Merge conflict in src/model/a.ts" }];
    await poll();
    expect(merges()).toEqual([expect.objectContaining({ forge: { kind: "command", merge: "pr merge" } })]);
    expect(ticket().state).toBe("working");

    h = makeCtx();
    await openPr({ forge });
    h.host.feedback.set(URL, { draft: false, review: "APPROVED" });
    h.host.scripted.prMerge = [{ outcome: "rejected", fix: false, message: "The base branch is frozen." }];
    await poll();
    expect(ticket().state).toBe("blocked");
    expect(ticket().blocked_reason).toContain("The base branch is frozen.");
  });

  it("never posts a merge comment twice when its answer was lost, until the human clears the attempt", async () => {
    await openPr({ forge: { kind: "gh", auto_merge: { mode: "auto", method: "comment", comment: "/merge", rejected: ["❌*"] } } });
    approved();
    h.host.scripted.prMerge = [Object.assign(new Error("Plugin RPC request failed"), { code: "transport_error" })];
    await poll();
    expect(outcomes()).toContain("auto_merge_unknown");
    await poll();
    await poll();
    expect(merges()).toHaveLength(1);
    expect(setAutoMerge(h.store, project(), "retry", ticket())).toContain("Cleared CSV-1's merge attempt 1");
    await poll();
    expect(merges()).toHaveLength(2);
    expect(merges()[1]!.attempt).toBe(1);
  });

  it("asks again after a temporary failure without using up an attempt, and says so once", async () => {
    await openPr({ forge: squash });
    approved();
    h.host.scripted.prMerge = [{ outcome: "unavailable", message: "HTTP 502", transient: "server" }, { outcome: "unavailable", message: "HTTP 502", transient: "server" }];
    await poll();
    await poll();
    await poll();
    expect(merges().map((call) => call.attempt)).toEqual([1, 1, 1]);
    expect(dataOf("auto_merge_failed")).toHaveLength(1);
    expect(h.store.ticketEvents(ticket().id, [MERGE_ATTEMPT])).toHaveLength(3);
  });

  it("merges nothing while the human has it off for the project or the ticket, or the project is paused", async () => {
    await openPr({ forge: squash });
    approved();
    setAutoMerge(h.store, project(), "off", null);
    await poll();
    setAutoMerge(h.store, project(), "on", null);
    setAutoMerge(h.store, project(), "off", ticket());
    await poll();
    h.store.setProjectState(project().id, "paused", "human");
    setAutoMerge(h.store, project(), "on", ticket());
    await poll();
    expect(merges()).toEqual([]);
    h.store.setProjectState(project().id, "running", "human");
    await poll();
    expect(merges()).toHaveLength(1);
  });

  it("holds a pull request whose merge_after ticket has not merged", async () => {
    await seedProject(h, (doc) => {
      pr({ forge: squash, stack: false })(doc);
      doc.ticket[1].depends_on = [];
      doc.ticket[0].merge_after = ["csv-export"];
    });
    const worker = await reachApproved(h);
    await askForPrTexts(h.ctx, project(), spec());
    handInPrText(h.ctx, worker.thread_id!, TEXT);
    await runMergeQueue(h.ctx, project(), spec());
    await settleMerges(h.ctx);
    approved();
    await poll();
    expect(merges()).toEqual([]);
  });
});

describe("asking for reviews", () => {
  const people = (...logins: string[]) => logins.map((login) => ({ login, bot: login.endsWith("[bot]") }));

  it("picks the same people for a pull request whatever order the pool comes in, never its author, a bot or someone already asked", () => {
    const pool = people("alice", "bob", "carol", "dave", "erin", "kalindudc", "ci[bot]");
    const one = pickReviewers(URL, pool, 2, { exclude: new Set(["kalindudc"]), already: new Set() });
    expect(one.picked).toHaveLength(2);
    expect(pickReviewers(URL, [...pool].reverse(), 2, { exclude: new Set(["kalindudc"]), already: new Set() })).toEqual(one);
    expect(one.picked).not.toContain("kalindudc");
    expect(one.picked).not.toContain("ci[bot]");
    const kept = pickReviewers(URL, pool, 2, { exclude: new Set(["kalindudc"]), already: new Set(["bob"]) });
    expect(kept.kept).toEqual(["bob"]);
    expect(kept.picked).toHaveLength(1);
    expect(kept.picked).not.toContain("bob");
    expect(pickReviewers(URL, people("alice"), 2, { exclude: new Set(), already: new Set() })).toEqual({ kept: [], picked: ["alice"], short: 1 });
  });

  it("asks two of a rule's users once the pull request is not a draft, once, and says who and why", async () => {
    // Held as a draft, so Loom does not mark it ready itself; someone marks it ready on the forge.
    await openPr({ draft: true, forge: { kind: "gh", reviewers: [{ users: ["alice", "bob", "carol", "kalindudc"], count: 2 }, { users: ["zoe"] }] } }, (doc) => void (doc.ticket[0].keep_draft = true));
    h.host.reviewState.set(URL, { author: "kalindudc", requested: ["bob"], reviewed: [] });
    await poll();
    expect(h.host.callsTo("prRequestReview")).toEqual([]);
    h.host.prMeta.set(URL, { ...h.host.prMeta.get(URL), draft: false });
    await poll();
    await poll();
    const asked = h.host.callsTo("prRequestReview");
    expect(asked).toHaveLength(1);
    const expected = pickReviewers(URL, people("alice", "bob", "carol", "kalindudc"), 2, { exclude: new Set(["kalindudc"]), already: new Set(["bob"]) }).picked;
    expect(asked[0]!.reviewers).toEqual([...expected, "zoe"]);
    expect(asked[0]).not.toHaveProperty("forge");
    const post = dataOf("reviewers_requested")[0]!;
    expect(post.data.requested).toEqual([...expected, "zoe"]);
    expect(post.post.body).toContain("2 of alice, bob, carol and kalindudc: asked");
    expect(post.post.body).toContain("bob was already asked or reviewing");
    expect(h.store.ticketEvents(ticket().id, [REVIEWERS_REQUESTED])).toHaveLength(1);
  });

  it("asks through a command forge's request_reviews", async () => {
    await openPr({ forge: { kind: "command", open: "o", state: "s", feedback: "f", request_reviews: "ask-cli", reviewers: [{ users: ["alice@example.com"], count: 1 }] } });
    h.host.feedback.set(URL, { draft: false, author: "kalindudc" });
    await poll();
    expect(h.host.callsTo("prReviewState")).toEqual([]);
    expect(h.host.callsTo("prRequestReview")).toEqual([expect.objectContaining({ reviewers: ["alice@example.com"], forge: { kind: "command", request_reviews: "ask-cli" } })]);
  });

  it("tries again at the next read after a failure worth waiting out", async () => {
    await openPr({ forge: { kind: "gh", reviewers: [{ users: ["alice"] }] } });
    h.host.scripted.prRequestReview = [{ outcome: "unavailable", message: "HTTP 502", transient: "server" }];
    await poll();
    expect(dataOf("reviewers_requested")).toEqual([]);
    await poll();
    expect(dataOf("reviewers_requested")[0]!.data.requested).toEqual(["alice"]);
  });
});
