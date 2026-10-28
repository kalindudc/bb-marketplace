import { beforeEach, describe, expect, it } from "vitest";
import { settleChecks, submit } from "../src/checks";
import type { ThreadRow } from "../src/db/store";
import { REPLY_MARK, type HostOutput } from "../src/host-contract";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { applyPrText, askForPrTexts, globMatch, handInPrText, keptChecks, replyToItem } from "../src/pull-requests";
import { approve, requestChanges, settleReviews, spawnReviewers } from "../src/review";
import { markLiveByHuman } from "../src/rollout-live";
import { repoCheckout } from "../src/checkouts";
import { blockTicket, requeueTicket, specOf } from "../src/workers";
import { checkOutHead, makeCtx, seedProject, startWorker, ticketOf, type Doc, type EngineHarness } from "./helpers";

type Feedback = Partial<Extract<HostOutput<"prFeedback">, { outcome: "ok" }>>;

let h: EngineHarness;
beforeEach(() => {
  h = makeCtx();
});

const URL = "https://github.com/acme/shop/pull/1";
const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const ticket = () => ticketOf(h, "CSV-1");
const outcomes = (outcome: string) => h.store.posts(ticket().id).filter((post) => post.kind === "merge" && (JSON.parse(post.data_json) as { outcome?: string }).outcome === outcome).map((post) => ({ post, data: JSON.parse(post.data_json) as Record<string, any> }));
const pr = (more: Doc = {}) => (doc: Doc) => {
  doc.merge = { strategy: "pr", ...more };
  if (more.forge?.kind === "none" || (more.forge?.kind === "command" && more.forge.feedback === undefined)) doc.checks.ci = false;
};
const ask = () => askForPrTexts(h.ctx, project(), spec());
const queue = async () => {
  await runMergeQueue(h.ctx, project(), spec());
  await settleMerges(h.ctx);
};
const poll = async () => {
  h.clock.advance(5 * 60_000);
  await pollPullRequests(h.ctx, project());
};
const briefs = () => h.bb.callsTo("spawnThread").map(([args]) => `${(args as { prompt: string }).prompt}\n${(args as { detail?: string }).detail ?? ""}`);
const PROPOSED = { title: "Add order rows", body: "## Why\nSupport wants CSV exports.\n\n## Deploy\nShips dark." };
const block = (key = "CSV-1") => `<!-- loom:begin -->\nOpened by Loom for ${key}.\n<!-- loom:end -->`;
const thread = { key: "thread:PRRT_1:9:abc", kind: "thread" as const, author: "alice", bot: false, body: "alice: The description should say how to roll back.", url: `${URL}#discussion_r9`, state: null, path: "src/model/a.ts", line: 4 };
const review = { key: "review:3:def", kind: "review" as const, author: "bob", bot: false, body: "Please describe the rollback.\nAnd the flag.", url: `${URL}#pullrequestreview-3`, state: "changes_requested", path: null, line: null };

/** Submits the worktree with a changed file, or as it is, and lets the checks run. */
async function handIn(worker: ThreadRow, summary: string, a: { change?: boolean; pr?: { title?: string; body?: string } } = {}): Promise<void> {
  const worktree = h.host.worktree(`/wt/${worker.environment_id}`);
  if (a.change !== false) {
    worktree.dirty = true;
    worktree.changed = ["src/model/a.ts"];
  }
  submit(h.ctx, worker.thread_id!, summary, a.pr);
  await settleChecks(h.ctx);
}

async function approveRound(summary = "Every criterion holds."): Promise<void> {
  await spawnReviewers(h.ctx, project(), spec());
  const reviewer = h.store.threads({ ticketId: ticket().id, role: "reviewer" }).at(-1)!;
  checkOutHead(h, reviewer);
  await approve(h.ctx, reviewer.thread_id!, summary);
  await settleReviews(h.ctx);
}

/** The pull request opened with the proposed text, after review; the worker gave only the commit message. */
async function openProposed(more: Doc = {}): Promise<ThreadRow> {
  await seedProject(h, pr(more));
  const worker = await startWorker(h);
  await handIn(worker, "Mapped every order.", { pr: PROPOSED });
  await approveRound();
  await ask();
  handInPrText(h.ctx, worker.thread_id!, { commit_message: "Add the order row mapper" });
  await queue();
  return worker;
}

async function fixRound(feedback: Feedback): Promise<void> {
  h.host.feedback.set(URL, feedback);
  await poll();
  expect(ticket().state).toBe("working");
}

describe("the pull request's text as reviewed work", () => {
  it("shows the reviewers the proposed text, opens the pull request with it and asks loom_pr only for the commit message", async () => {
    await seedProject(h, pr());
    const worker = await startWorker(h);
    await handIn(worker, "Mapped every order.", { pr: PROPOSED });
    expect(ticket().state).toBe("review");
    expect(JSON.parse(ticket().pr_proposal_json!)).toEqual({ head: ticket().head_sha, ...PROPOSED, at: h.clock.t });
    expect(h.store.posts(ticket().id).find((post) => post.kind === "submit")!.body).toBe(`Mapped every order.\n\nProposed pull request title: ${PROPOSED.title}\nProposed pull request description:\n${PROPOSED.body}`);

    await spawnReviewers(h.ctx, project(), spec());
    const brief = briefs().at(-1)!;
    expect(brief).toContain(`## The pull request as it will open\nThe worker proposes this title and description; Loom opens the pull request with them once the reviewers approve.\nTitle: ${PROPOSED.title}\nDescription:\n${PROPOSED.body}\nJudge this text as you judge the code`);
    const reviewer = h.store.threads({ ticketId: ticket().id, role: "reviewer" }).at(-1)!;
    checkOutHead(h, reviewer);
    await approve(h.ctx, reviewer.thread_id!, "Holds.");
    await settleReviews(h.ctx);

    await ask();
    const asked = h.bb.sent(worker.thread_id!).at(-1)!;
    expect(asked).toContain("Loom opens its pull request with the title and description the reviewers approved; write the commit message and hand it in with loom_pr({ commit_message })");
    expect(handInPrText(h.ctx, worker.thread_id!, { commit_message: "Add the order row mapper" })).toContain("Loom opens the pull request now with the title and description the reviewers approved, so end your turn.");
    await queue();
    expect(h.host.callsTo("prCreate")[0]).toMatchObject({ title: PROPOSED.title, body: `${PROPOSED.body}\n\n${block()}` });
    expect(h.host.callsTo("prCommit")[0]!.message).toBe("Add the order row mapper");
    expect(JSON.parse(ticket().pr_applied_json!)).toEqual({ title: PROPOSED.title, body: PROPOSED.body, live: [], at: h.clock.t });
  });

  it("lets loom_pr's title and body win, asks for the field the worker did not propose, and keeps the earlier proposal's other field", async () => {
    await seedProject(h, pr());
    const worker = await startWorker(h);
    await handIn(worker, "First try.", { pr: { body: "First body" } });
    expect(JSON.parse(ticket().pr_proposal_json!)).toMatchObject({ title: null, body: "First body" });
    h.store.setTicketState(ticket().id, "working", "test");
    await handIn(worker, "Second try.", { pr: { title: "A title" } });
    expect(JSON.parse(ticket().pr_proposal_json!)).toMatchObject({ title: "A title", body: "First body" });
    h.store.setTicketState(ticket().id, "working", "test");
    await handIn(worker, "Third try.", { pr: { body: "Second body" } });
    await approveRound();
    await ask();
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("Loom opens its pull request with the title and description the reviewers approved");
    handInPrText(h.ctx, worker.thread_id!, { title: "A better title", commit_message: "Subject" });
    await queue();
    expect(h.host.callsTo("prCreate")[0]).toMatchObject({ title: "A better title", body: `Second body\n\n${block()}` });

    h = makeCtx();
    await seedProject(h, pr());
    const other = await startWorker(h);
    await handIn(other, "Done.", { pr: { body: "Only a body" } });
    await approveRound();
    await ask();
    expect(h.bb.sent(other.thread_id!).at(-1)).toContain("hand it in with loom_pr({ title, commit_message })");
    expect(() => handInPrText(h.ctx, other.thread_id!, { commit_message: "Subject" })).toThrow("You proposed only a body with loom_submit, so give the title here.");
  });

  it("refuses pr on the integration strategy, with describe = \"loom\", and with a blank field", async () => {
    await seedProject(h);
    const worker = await startWorker(h);
    expect(() => submit(h.ctx, worker.thread_id!, "Done", { title: "T" })).toThrow("opens no pull request for each, so leave pr out");

    h = makeCtx();
    await seedProject(h, pr({ describe: "loom" }));
    const loom = await startWorker(h);
    expect(() => submit(h.ctx, loom.thread_id!, "Done", { title: "T" })).toThrow('merge.describe = "loom"');

    h = makeCtx();
    await seedProject(h, pr());
    const blank = await startWorker(h);
    expect(() => submit(h.ctx, blank.thread_id!, "Done", { title: " ", body: "B" })).toThrow("A field of pr is blank");
    expect(() => submit(h.ctx, blank.thread_id!, "Done", {})).toThrow("pr is empty");
    expect(ticket().state).toBe("working");
  });

  it("tells the reviewers to ask for a proposal when the worker gave none", async () => {
    await seedProject(h, pr());
    const worker = await startWorker(h);
    await handIn(worker, "Done.");
    await spawnReviewers(h.ctx, project(), spec());
    expect(briefs().at(-1)).toContain("The worker proposed no title or description; it writes them after approval, unreviewed. If the rubric asks something of the pull request's description, request changes so the worker proposes it with loom_submit's pr.");
  });
});

describe("a fix round that changes the pull request's text", () => {
  it("sends a fix that changes only the text through review, then sets it and pushes nothing", async () => {
    const worker = await openProposed();
    await fixRound({ items: [thread] });
    const execs = h.host.callsTo("exec").length;
    await handIn(worker, "Added the rollback to the description.", { change: false, pr: { body: "## Why\nSupport.\n\n## Rollback\nRevert the commit." } });
    expect(ticket().state).toBe("review");
    expect(h.host.callsTo("exec")).toHaveLength(execs);
    expect(h.store.posts(ticket().id).filter((post) => post.kind === "check").at(-1)!.body).toContain("No checks ran: the work is the commit the pull request has");
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("your fix changes only the pull request's proposed text, so no checks ran");

    await spawnReviewers(h.ctx, project(), spec());
    const brief = briefs().at(-1)!;
    expect(brief).toContain(`## The pull request's text\nLoom last set:\nTitle: ${PROPOSED.title}\nDescription:\n${PROPOSED.body}\n\nThe worker proposes:\nTitle: ${PROPOSED.title}\nDescription:\n## Why\nSupport.\n\n## Rollback\nRevert the commit.\nOnce the reviewers approve, Loom sets the proposed text on the pull request.`);
    expect(brief).toContain("## Pull request feedback");
    const reviewer = h.store.threads({ ticketId: ticket().id, role: "reviewer" }).at(-1)!;
    checkOutHead(h, reviewer);
    await approve(h.ctx, reviewer.thread_id!, "The rollback is described.");
    await settleReviews(h.ctx);

    const sent = h.bb.sent(worker.thread_id!).length;
    await ask();
    expect(h.bb.sent(worker.thread_id!)).toHaveLength(sent);
    const pushes = h.host.callsTo("push").length;
    await queue();
    expect(h.host.callsTo("push")).toHaveLength(pushes);
    expect(ticket().state).toBe("pr_open");
    expect(outcomes("pr_unchanged").at(-1)!.post.body).toBe(`Fix round 1 changes only the pull request's text, so Loom pushed nothing to ${URL}.`);
    expect(h.host.callsTo("prEdit")).toEqual([{ repo: "/repo", url: URL, title: PROPOSED.title, body: `## Why\nSupport.\n\n## Rollback\nRevert the commit.\n\n${block()}`, forge: { kind: "gh" } }]);
    expect(outcomes("pr_edited")[0]!.post.body).toBe(`Set the title and description of ${URL} to the ones the reviewers approved.`);
    expect(JSON.parse(ticket().pr_applied_json!)).toMatchObject({ title: PROPOSED.title, body: "## Why\nSupport.\n\n## Rollback\nRevert the commit." });

    // Applied: the next fix round that changes nothing goes straight back to pr_open again.
    await fixRound({ head: "sq1", items: [{ ...thread, key: "thread:PRRT_1:10:x" }] });
    await handIn(worker, "Nothing to change.", { change: false });
    expect(ticket().state).toBe("pr_open");
    expect(h.host.callsTo("prEdit")).toHaveLength(1);
  });

  it("pushes a fix with code and text, then sets the text; loom_pr's title wins", async () => {
    const worker = await openProposed();
    await fixRound({ items: [review] });
    await handIn(worker, "Renamed it and described the rollback.", { pr: { body: "With rollback" } });
    expect(ticket().state).toBe("review");
    await approveRound();
    await ask();
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("then sets the title and description you proposed with loom_submit, which the reviewers approved");
    expect(handInPrText(h.ctx, worker.thread_id!, { title: "Add order rows, with rollback", commit_message: "Rename" })).toContain("then sets the pull request's new title and description");
    await queue();
    expect(h.host.callsTo("push")).toHaveLength(2);
    expect(h.host.callsTo("prEdit")).toEqual([expect.objectContaining({ title: "Add order rows, with rollback", body: `With rollback\n\n${block()}` })]);
    const order = h.store.posts(ticket().id).map((post) => (JSON.parse(post.data_json) as { outcome?: string }).outcome);
    expect(order.indexOf("pr_edited")).toBeGreaterThan(order.indexOf("pr_pushed"));
  });

  it("posts the text for the human on a forge that cannot edit, and carries on", async () => {
    const worker = await openProposed({ forge: { kind: "command", open: "review open", state: "review state", feedback: "review feedback" } });
    await fixRound({ items: [review] });
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("since this forge cannot change the pull request's text, Loom posts it on the ticket for the human to set");
    await handIn(worker, "Described the rollback.", { change: false, pr: { body: "With rollback" } });
    await spawnReviewers(h.ctx, project(), spec());
    expect(briefs().at(-1)).toContain("This forge cannot change the pull request's text, so once the reviewers approve, Loom posts the proposed text on the ticket for the human to set.");
    const reviewer = h.store.threads({ ticketId: ticket().id, role: "reviewer" }).at(-1)!;
    checkOutHead(h, reviewer);
    await approve(h.ctx, reviewer.thread_id!, "Holds.");
    await settleReviews(h.ctx);
    await queue();
    expect(ticket().state).toBe("pr_open");
    expect(h.host.callsTo("prEdit")).toEqual([]);
    expect(outcomes("pr_text_by_hand")[0]!.post.body).toBe(`Loom cannot change a pull request's text through this forge, so set this title and description on ${URL} by hand:\n\nTitle: ${PROPOSED.title}\n\nDescription:\nWith rollback`);
    expect(JSON.parse(ticket().pr_applied_json!)).toMatchObject({ body: "With rollback", byHand: true });
  });

  it("edits through a command forge's edit command", async () => {
    const worker = await openProposed({ forge: { kind: "command", open: "review open", state: "review state", feedback: "review feedback", edit: "review edit" } });
    await fixRound({ items: [review] });
    await handIn(worker, "Described the rollback.", { change: false, pr: { title: "New title" } });
    await approveRound();
    await queue();
    expect(h.host.callsTo("prEdit")).toEqual([{ repo: "/repo", url: URL, title: "New title", body: `${PROPOSED.body}\n\n${block()}`, forge: { kind: "command", edit: "review edit" } }]);
  });

  it("waits out an edit that failed with a temporary error and sets the text on a later read; posts any other failure and keeps the pull request as it is", async () => {
    const worker = await openProposed();
    await fixRound({ items: [review] });
    await handIn(worker, "Described it.", { change: false, pr: { body: "Second" } });
    await approveRound();
    h.host.scripted.prEdit = [{ outcome: "unavailable", message: "gh pr edit failed: HTTP 502", transient: "server" }];
    await queue();
    expect(ticket().state).toBe("pr_open");
    expect(project().state).toBe("running");
    expect(outcomes("pr_edit_waits")[0]!.post.body).toContain("Loom could not set the pull request's title and description with what looks like a temporary error: gh pr edit failed: HTTP 502.");
    expect(JSON.parse(ticket().pr_applied_json!)).toMatchObject({ body: PROPOSED.body, want: { title: PROPOSED.title, body: "Second" }, wait: { failures: 1 } });
    h.host.feedback.set(URL, { head: "sq1" });
    await poll();
    expect(h.host.callsTo("prEdit")).toHaveLength(2);
    expect(JSON.parse(ticket().pr_applied_json!)).toEqual(expect.objectContaining({ body: "Second" }));
    expect(JSON.parse(ticket().pr_applied_json!)).not.toHaveProperty("want");

    await fixRound({ head: "sq1", items: [{ ...review, key: "review:4:x" }] });
    await handIn(worker, "Again.", { change: false, pr: { body: "Third" } });
    await approveRound();
    h.host.scripted.prEdit = [{ outcome: "unavailable", message: "gh pr edit failed: GraphQL: Resource not accessible by integration" }];
    await queue();
    expect(outcomes("pr_edit_failed")[0]!.post.body).toContain(`The pull request keeps its text, so set this title and description on ${URL} by hand:\n\nTitle: Add order rows\n\nDescription:\nThird`);
    expect(JSON.parse(ticket().pr_applied_json!)).toMatchObject({ body: "Third", byHand: true });
    await poll();
    expect(h.host.callsTo("prEdit")).toHaveLength(3);
  });

  it("asks the worker in a fix round's message to propose the text with loom_submit and to reply with loom_pr_reply, by each item's key", async () => {
    const worker = await openProposed();
    await fixRound({ items: [thread, review] });
    const message = h.bb.sent(worker.thread_id!).at(-1)!;
    expect(message).toContain(`- Review thread on src/model/a.ts:4, last from alice (${URL}#discussion_r9), key \`thread:PRRT_1:9:abc\`:`);
    expect(message).toContain("When the feedback asks for a new title or description, pass pr = { title, body } to loom_submit with what it should read");
    expect(message).toContain("never with the forge's CLI");
  });
});

describe("loom_pr_reply", () => {
  it("replies in a review thread through the forge on the project's machine, signed and marked, resolves it, and posts the reply on the ticket", async () => {
    h.ctx.commentSignature = () => "Posted by Loom";
    const worker = await openProposed();
    await fixRound({ items: [thread, review] });
    const answer = await replyToItem(h.ctx, worker.thread_id!, { item: thread.key, text: "Added a Rollback section.", resolve: true });
    expect(answer).toBe(`Replied to the review thread on src/model/a.ts:4 by alice (${URL}#reply) and resolved the thread.`);
    expect(h.host.callsTo("prReply")).toEqual([{ repo: "/repo", url: URL, key: thread.key, kind: "thread", body: `Added a Rollback section.\n\nPosted by Loom\n${REPLY_MARK}`, resolve: true, forge: { kind: "gh" } }]);
    expect(outcomes("pr_reply")[0]).toMatchObject({ post: { author_kind: "worker", body: "The worker replied to the review thread on src/model/a.ts:4 by alice and resolved it:\n\nAdded a Rollback section." }, data: { round: 1, item: thread.key, ok: true, resolved: true } });

    await replyToItem(h.ctx, worker.thread_id!, { item: review.key, text: "Done.", resolve: true });
    expect(h.host.callsTo("prReply").at(-1)).toMatchObject({ kind: "review", resolve: false, body: `> Please describe the rollback.\n\nIn reply to ${review.url}\n\nDone.\n\nPosted by Loom\n${REPLY_MARK}` });
  });

  it("refuses an unknown key, a call outside a fix round, more than 30 a round, and a forge without a reply command", async () => {
    const worker = await openProposed();
    await expect(replyToItem(h.ctx, worker.thread_id!, { item: thread.key, text: "x" })).rejects.toThrow("no fix round is open now");
    await fixRound({ items: [thread] });
    await expect(replyToItem(h.ctx, worker.thread_id!, { item: "thread:nope", text: "x" })).rejects.toThrow("No item `thread:nope` in the feedback Loom sent you");
    await expect(replyToItem(h.ctx, "thr_other", { item: thread.key, text: "x" })).rejects.toThrow("for a Loom worker thread");
    for (let index = 0; index < 30; index += 1) await replyToItem(h.ctx, worker.thread_id!, { item: thread.key, text: `Reply ${index}` });
    await expect(replyToItem(h.ctx, worker.thread_id!, { item: thread.key, text: "One more" })).rejects.toThrow("You posted 30 replies in this fix round");

    h = makeCtx();
    const command = await openProposed({ forge: { kind: "command", open: "o", state: "s", feedback: "f" } });
    await fixRound({ items: [thread] });
    await expect(replyToItem(h.ctx, command.thread_id!, { item: thread.key, text: "x" })).rejects.toThrow("Loom cannot reply on this pull request through its forge");
    expect(h.bb.sent(command.thread_id!).at(-1)).toContain("Loom cannot reply on this pull request through its forge, so say in your loom_submit summary what you would answer");
  });

  it("returns the forge's error and posts it, and a command forge's reply runs its reply command", async () => {
    const worker = await openProposed({ forge: { kind: "command", open: "o", state: "s", feedback: "f", reply: "review reply" } });
    await fixRound({ items: [thread] });
    h.host.scripted.prReply = [{ outcome: "unavailable", message: "The forge's reply command failed (exit 1): denied" }];
    await expect(replyToItem(h.ctx, worker.thread_id!, { item: thread.key, text: "x" })).rejects.toThrow("The forge did not take the reply: The forge's reply command failed (exit 1): denied");
    expect(outcomes("pr_reply")[0]).toMatchObject({ post: { body: expect.stringContaining("did not go out") }, data: { ok: false } });
    await replyToItem(h.ctx, worker.thread_id!, { item: thread.key, text: "Done." });
    expect(h.host.callsTo("prReply").at(-1)).toMatchObject({ kind: "thread", body: `Done.\n\nPosted by Loom\n${REPLY_MARK}`, forge: { kind: "command", reply: "review reply" } });
  });

  it("never reads the worker's replies as new feedback, also from a command forge that does not say who wrote the pull request", async () => {
    const worker = await openProposed({ forge: { kind: "command", open: "o", state: "s", feedback: "f", reply: "r" } });
    await fixRound({ author: "", items: [thread] });
    await handIn(worker, "Nothing to change.", { change: false });
    expect(ticket().state).toBe("pr_open");
    const ours = { ...thread, key: "thread:PRRT_1:11:mine", author: "", body: `alice: Why?\n\nkalindudc: Because.\n\nPosted by Loom\n${REPLY_MARK}` };
    h.host.feedback.set(URL, { author: "", items: [thread, ours] });
    await poll();
    expect(ticket()).toMatchObject({ state: "pr_open", pr_rounds: 1 });
    expect(JSON.parse(ticket().pr_seen_json)).toContain(ours.key);
  });
});

describe("the forge's after_push and ignore_checks", () => {
  it("runs after_push after a fix round's push with the branch, URL, number and commit, and posts a failure without blocking", async () => {
    const worker = await openProposed({ forge: { kind: "gh", after_open: ["ci open"], after_push: ["ci start", "ci notify"] } });
    expect(h.host.callsTo("exec").filter((call) => call.command.startsWith("ci "))).toEqual([expect.objectContaining({ command: "ci open" })]);
    await fixRound({ items: [review] });
    await handIn(worker, "Renamed it.");
    await approveRound();
    await ask();
    handInPrText(h.ctx, worker.thread_id!, { commit_message: "Rename" });
    h.host.onExec = (input) => {
      if (input.command === "ci start") h.host.execResults.unshift({ exitCode: 3, output: "no runner" });
    };
    await queue();
    const hooks = h.host.callsTo("exec").filter((call) => call.command === "ci start" || call.command === "ci notify");
    expect(hooks).toEqual([
      { cwd: "/repo", command: "ci start", timeoutMs: 300_000, env: { LOOM_URL: URL, LOOM_PR_NUMBER: "1", LOOM_HEAD: ticket().pr_branch, LOOM_BASE: "main", LOOM_SHA: "sq2" } },
      { cwd: "/repo", command: "ci notify", timeoutMs: 300_000, env: { LOOM_URL: URL, LOOM_PR_NUMBER: "1", LOOM_HEAD: ticket().pr_branch, LOOM_BASE: "main", LOOM_SHA: "sq2" } },
    ]);
    expect(ticket().state).toBe("pr_open");
    expect(outcomes("after_push_failed")[0]!.post.body).toBe(`The after_push command \`ci start\` failed (exit 3)\n\nno runner\n\nThe pull request ${URL} has the push; nothing else changed.`);
  });

  it("runs no after_push for a fix round that pushed nothing", async () => {
    const worker = await openProposed({ forge: { kind: "gh", after_push: ["ci start"] } });
    await fixRound({ items: [review] });
    await handIn(worker, "Text only.", { change: false, pr: { body: "New" } });
    await approveRound();
    await queue();
    expect(h.host.callsTo("exec").filter((call) => call.command === "ci start")).toEqual([]);
  });

  it("drops the checks ignore_checks names from the counts and from the fix round, and keeps the rest", async () => {
    await openProposed({ forge: { kind: "gh", ignore_checks: ["Review Bot*", "*(advisory)"] } });
    h.host.feedback.set(URL, {
      checks: [
        { key: "status:Review Bot Comments Addressed:FAILURE:sq1", name: "Review Bot Comments Addressed", state: "failed", url: null },
        { key: "check:2", name: "lint (advisory)", state: "failed", url: null },
        { key: "check:3", name: "test", state: "passed", url: null },
      ],
    });
    h.clock.advance(31 * 60_000);
    await poll();
    expect(ticket()).toMatchObject({ state: "pr_open", pr_rounds: 0 });
    expect(JSON.parse(ticket().pr_status_json!)).toMatchObject({ passed: 1, failed: 0, pending: 0 });
    h.host.feedback.set(URL, { checks: [{ key: "check:4", name: "build", state: "failed", url: null }] });
    await poll();
    expect(ticket()).toMatchObject({ state: "working", pr_rounds: 1 });
  });
});

describe("refreshing the pull request's Rollout section", () => {
  const rollout = (more: Doc = {}) => (doc: Doc) => {
    pr(more)(doc);
    doc.rollout = { milestone: [{ ref: "traffic-low", title: "Old traffic is near zero" }] };
    doc.ticket[0].rollout = { requires_live: ["traffic-low"] };
  };
  const section = (status: string) =>
    `## Rollout\n\nStage: none.\nLive first:\n- traffic-low: Old traffic is near zero. ${status}\nMerging does not deploy it; it deploys the way its repo does.\n\nLoom tracks this order on the project's Rollout tab. It is advice: Loom holds no merge or deploy for it.`;
  const blockWith = (status: string) => `<!-- loom:begin -->\n${section(status)}\n\nOpened by Loom for CSV-1.\n<!-- loom:end -->`;

  async function openWithRollout(more: Doc = {}): Promise<void> {
    await seedProject(h, rollout(more));
    const worker = await startWorker(h);
    await handIn(worker, "Done.", { pr: PROPOSED });
    await approveRound();
    await ask();
    handInPrText(h.ctx, worker.thread_id!, { commit_message: "Subject" });
    await queue();
    expect(h.host.callsTo("prCreate")[0]!.body).toBe(`${PROPOSED.body}\n\n${blockWith("It does not hold yet.")}`);
  }

  it("replaces only what lies between Loom's markers once a requirement goes live, and says so on the ticket", async () => {
    await openWithRollout();
    await poll();
    expect(h.host.callsTo("prEdit")).toEqual([]);
    // Someone edited the description on the forge; Loom keeps that.
    h.host.texts.set(URL, { title: "Renamed by hand", body: `Edited by hand.\n\n${blockWith("It does not hold yet.")}\n\nA footer.` });
    markLiveByHuman(h.ctx, "csv", "traffic-low", {}, "human");
    await poll();
    expect(h.host.callsTo("prEdit")).toEqual([{ repo: "/repo", url: URL, title: "Renamed by hand", body: `Edited by hand.\n\n${blockWith("It holds.")}\n\nA footer.`, forge: { kind: "gh" } }]);
    expect(outcomes("rollout_refreshed")[0]!.post.body).toBe(`Refreshed the Rollout section of ${URL}: traffic-low is live now.`);
    expect(JSON.parse(ticket().pr_applied_json!)).toMatchObject({ title: PROPOSED.title, live: ["traffic-low"] });
    await poll();
    expect(h.host.callsTo("prEdit")).toHaveLength(1);
  });

  it("reads the body with the poll's light read too, when Loom follows no feedback", async () => {
    await openWithRollout({ max_fix_rounds: 0 });
    markLiveByHuman(h.ctx, "csv", "traffic-low", {}, "human");
    await poll();
    expect(h.host.callsTo("prBatch").at(-1)).toMatchObject({ feedback: false });
    expect(h.host.callsTo("prEdit")).toHaveLength(1);
  });

  it("says once that it cannot refresh a description with no markers, or one the forge does not give", async () => {
    await openWithRollout();
    h.host.texts.set(URL, { title: "T", body: "A description from before Loom's markers." });
    markLiveByHuman(h.ctx, "csv", "traffic-low", {}, "human");
    await poll();
    markLiveByHuman(h.ctx, "csv", "traffic-low", { undo: true }, "human");
    await poll();
    expect(h.host.callsTo("prEdit")).toEqual([]);
    const notes = outcomes("rollout_not_refreshed");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.post.body).toBe(`The Rollout section of ${URL} is out of date: traffic-low is live now, but its description has no Loom markers (<!-- loom:begin --> and <!-- loom:end -->) around the part Loom may replace. The project's Rollout tab has the order as it is now.`);

    h = makeCtx();
    await openWithRollout({ forge: { kind: "command", open: "o", state: "s", feedback: "f", edit: "e" } });
    h.host.texts.delete(URL);
    markLiveByHuman(h.ctx, "csv", "traffic-low", {}, "human");
    await poll();
    expect(h.host.callsTo("prEdit")).toEqual([]);
    expect(outcomes("rollout_not_refreshed")[0]!.data).toMatchObject({ reason: "body", live: ["traffic-low"] });
  });

  it("waits out a refresh that failed with a temporary error, and tries again on a later read", async () => {
    await openWithRollout();
    markLiveByHuman(h.ctx, "csv", "traffic-low", {}, "human");
    h.host.scripted.prEdit = [{ outcome: "unavailable", message: "gh pr edit failed: HTTP 503", transient: "server" }];
    await poll();
    expect(outcomes("pr_edit_waits")).toHaveLength(1);
    expect(JSON.parse(ticket().pr_applied_json!)).toMatchObject({ live: [], wait: { failures: 1 } });
    await poll();
    expect(h.host.callsTo("prEdit")).toHaveLength(2);
    expect(outcomes("rollout_refreshed")).toHaveLength(1);
  });

  it("leaves the pull request alone while the project is paused", async () => {
    await openWithRollout();
    markLiveByHuman(h.ctx, "csv", "traffic-low", {}, "human");
    h.store.setProjectState(project().id, "paused", "human");
    await poll();
    expect(h.host.callsTo("prEdit")).toEqual([]);
  });
});

describe("request changes on the pull request's text", () => {
  it("sends the reviewer's findings on the text back to the worker, who proposes it again", async () => {
    await seedProject(h, pr());
    const worker = await startWorker(h);
    await handIn(worker, "Done.", { pr: { title: "T", body: "No rollback." } });
    await spawnReviewers(h.ctx, project(), spec());
    const reviewer = h.store.threads({ ticketId: ticket().id, role: "reviewer" }).at(-1)!;
    checkOutHead(h, reviewer);
    await requestChanges(h.ctx, reviewer.thread_id!, "The description lacks a rollback.", [{ severity: "blocking", title: "No rollback", detail: "Say how to roll back." }]);
    await settleReviews(h.ctx);
    expect(ticket().state).toBe("working");
    await handIn(worker, "Described it.", { change: false, pr: { body: "Rollback: revert." } });
    expect(JSON.parse(ticket().pr_proposal_json!)).toMatchObject({ title: "T", body: "Rollback: revert." });
  });
});

describe("ignore_checks globs", () => {
  it("match whole names, case-sensitively: * is any run of characters, ? one, and the rest is literal", () => {
    expect(globMatch("Review Bot*", "Review Bot Comments Addressed")).toBe(true);
    expect(globMatch("Review Bot*", "review bot comments")).toBe(false);
    expect(globMatch("*(advisory)", "lint (advisory)")).toBe(true);
    expect(globMatch("lint", "lint (advisory)")).toBe(false);
    expect(globMatch("t?st", "test")).toBe(true);
    expect(globMatch("t?st", "tst")).toBe(false);
    expect(globMatch("(a+)+$", "(a+)+$")).toBe(true);
    expect(globMatch("(a+)+$", "aaaa")).toBe(false);
    expect(globMatch("a.c", "abc")).toBe(false);
    expect(globMatch("*", "")).toBe(true);
    expect(globMatch("**", "anything")).toBe(true);
    expect(globMatch("?", "é")).toBe(true);
    expect(globMatch("build *", "build 🚀")).toBe(true);
    expect(keptChecks({ kind: "gh", ignore_checks: ["Review Bot*"] }, [{ name: "Review Bot Comments Addressed" }, { name: "test" }])).toEqual({ kept: [{ name: "test" }], ignored: [{ name: "Review Bot Comments Addressed" }] });
  });

  it("stay fast on names and patterns built to make a matcher backtrack", () => {
    const started = performance.now();
    expect(globMatch("*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b", "a".repeat(10_000))).toBe(false);
    expect(globMatch(`${"*".repeat(199)}!`, "a".repeat(10_000))).toBe(false);
    expect(globMatch("*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a", "a".repeat(10_000))).toBe(true);
    const checks = Array.from({ length: 200 }, (_, index) => ({ name: `${"a".repeat(500)}${index}` }));
    const ignore = Array.from({ length: 20 }, () => `${"*a".repeat(99)}!`);
    expect(keptChecks({ kind: "gh", ignore_checks: ignore }, checks).kept).toHaveLength(200);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("Loom's own sections in the worker's text", () => {
  const fake = "<!-- loom:begin -->\nStacked on nothing.\n<!-- loom:end -->";

  it("takes Loom's markers, and what lies between them, out of a proposal and loom_pr's body, so the pull request has one block", async () => {
    await seedProject(h, pr());
    const worker = await startWorker(h);
    expect(() => submit(h.ctx, worker.thread_id!, "Done.", { body: fake })).toThrow("once Loom's own sections");
    await handIn(worker, "Done.", { pr: { title: "T", body: `Why\n\n${fake}\n\nTail <!-- loom:end -->` } });
    expect(JSON.parse(ticket().pr_proposal_json!)).toMatchObject({ body: "Why\n\n\n\nTail" });
    await approveRound();
    await ask();
    handInPrText(h.ctx, worker.thread_id!, { body: `Better\n${fake}`, commit_message: "Subject" });
    await queue();
    const body = h.host.callsTo("prCreate")[0]!.body;
    expect(body).toBe(`Better\n\n${block()}`);
  });

  it("refreshes only a description with exactly one block of Loom's, and says once when it has several", async () => {
    await seedProject(h, (doc) => {
      pr()(doc);
      doc.rollout = { milestone: [{ ref: "traffic-low", title: "Old traffic is near zero" }] };
      doc.ticket[0].rollout = { requires_live: ["traffic-low"] };
    });
    const worker = await startWorker(h);
    await handIn(worker, "Done.", { pr: PROPOSED });
    await approveRound();
    await ask();
    handInPrText(h.ctx, worker.thread_id!, { commit_message: "Subject" });
    await queue();
    const opened = h.host.texts.get(URL)!.body!;
    h.host.texts.set(URL, { title: "T", body: `${opened}\n\n${fake}` });
    markLiveByHuman(h.ctx, "csv", "traffic-low", {}, "human");
    await poll();
    markLiveByHuman(h.ctx, "csv", "traffic-low", { undo: true }, "human");
    await poll();
    expect(h.host.callsTo("prEdit")).toEqual([]);
    expect(outcomes("rollout_not_refreshed").map((each) => each.data.reason)).toEqual(["blocks"]);
    expect(outcomes("rollout_not_refreshed")[0]!.post.body).toContain("its description has Loom's markers more than once, so Loom cannot tell which part is its own");
  });
});

describe("descriptions near the forge's limit", () => {
  const rollout = (doc: Doc) => {
    pr()(doc);
    doc.rollout = { milestone: [{ ref: "traffic-low", title: "Old traffic is near zero" }] };
    doc.ticket[0].rollout = { requires_live: ["traffic-low"] };
  };
  async function opened(): Promise<string> {
    await seedProject(h, rollout);
    const worker = await startWorker(h);
    await handIn(worker, "Done.", { pr: PROPOSED });
    await approveRound();
    await ask();
    handInPrText(h.ctx, worker.thread_id!, { commit_message: "Subject" });
    await queue();
    const body = h.host.texts.get(URL)!.body!;
    return body.slice(body.indexOf("<!-- loom:begin -->"));
  }

  it("never cuts a description short when it refreshes the Rollout section, and leaves one that would be too long alone, saying why once", async () => {
    const own = await opened();
    const human = "h".repeat(61_000);
    h.host.texts.set(URL, { title: "T", body: `${human}\n\n${own}\n\nFooter by hand.` });
    markLiveByHuman(h.ctx, "csv", "traffic-low", {}, "human");
    await poll();
    const edited = h.host.callsTo("prEdit")[0]!.body;
    expect(edited.startsWith(human)).toBe(true);
    expect(edited.endsWith("\n\nFooter by hand.")).toBe(true);
    expect(edited).toContain("It holds.");

    h = makeCtx();
    const again = await opened();
    h.host.texts.set(URL, { title: "T", body: `${"h".repeat(66_000)}\n\n${again}` });
    markLiveByHuman(h.ctx, "csv", "traffic-low", {}, "human");
    await poll();
    markLiveByHuman(h.ctx, "csv", "traffic-low", { undo: true }, "human");
    await poll();
    expect(h.host.callsTo("prEdit")).toEqual([]);
    expect(outcomes("rollout_not_refreshed")).toHaveLength(1);
    expect(outcomes("rollout_not_refreshed")[0]).toMatchObject({ data: { reason: "size" }, post: { body: expect.stringContaining("over the 65536 a pull request takes, and Loom never cuts one short") } });
  });

  it("posts a text that would make the description too long for the human instead of cutting it", async () => {
    await opened();
    const checkout = await repoCheckout(h.ctx, project(), spec(), null);
    await applyPrText(h.ctx, spec(), ticket(), checkout, { title: "T", body: "b".repeat(70_000) });
    expect(h.host.callsTo("prEdit")).toEqual([]);
    expect(outcomes("pr_edit_failed")[0]!.post.body).toContain("over the 65536 a pull request takes, and Loom never cuts one short. The pull request keeps its text, so set this title and description");
    expect(JSON.parse(ticket().pr_applied_json!)).toMatchObject({ byHand: true });
  });
});

describe("a proposal once its text is set", () => {
  it("is consumed, so an earlier proposal never undoes a later loom_pr text", async () => {
    const worker = await openProposed();
    expect(ticket().pr_proposal_json).toBeNull();
    await fixRound({ items: [review] });
    await handIn(worker, "Renamed it.", { pr: { body: "First proposal" } });
    await approveRound();
    await ask();
    handInPrText(h.ctx, worker.thread_id!, { body: "The body loom_pr gave", commit_message: "Rename" });
    await queue();
    expect(h.host.callsTo("prEdit").map((call) => call.body)).toEqual([`The body loom_pr gave\n\n${block()}`]);
    expect(ticket().pr_proposal_json).toBeNull();

    await fixRound({ head: "sq2", items: [{ ...review, key: "review:9:z" }] });
    await handIn(worker, "Nothing to change.", { change: false });
    expect(ticket().state).toBe("pr_open");
    await poll();
    expect(h.host.callsTo("prEdit")).toHaveLength(1);
  });
});

describe("review again as is with a proposed text", () => {
  const again = () => requeueTicket(h.ctx, "CSV-1", { note: "", actor: "human", author: "human", review: true });
  const branchAt = (sha: string) => h.host.refs.set(`refs/heads/${ticket().branch}`, sha);

  it("sets a text the reviewers approved but Loom had not set yet, on the way back to pr_open, with nothing pushed", async () => {
    const worker = await openProposed();
    await fixRound({ items: [review] });
    await handIn(worker, "Described the rollback.", { change: false, pr: { body: "With rollback" } });
    await approveRound();
    expect(ticket().state).toBe("approved");
    await blockTicket(h.ctx, ticket(), { reason: "Hold on", needs: "", actor: "human" });
    expect(ticket().state).toBe("blocked");
    branchAt(ticket().head_sha!);
    const pushes = h.host.callsTo("push").length;
    expect(await again()).toMatchObject({ state: "pr_open" });
    expect(h.host.callsTo("push")).toHaveLength(pushes);
    expect(h.host.callsTo("prEdit")).toEqual([expect.objectContaining({ body: `With rollback\n\n${block()}` })]);
    expect(outcomes("pr_unchanged").at(-1)!.post.body).toContain("It sets the title and description the reviewers approved.");
    expect(ticket().pr_proposal_json).toBeNull();
  });

  it("sends a proposed text no reviewer approved yet back to review", async () => {
    const worker = await openProposed();
    await fixRound({ items: [review] });
    await handIn(worker, "Described the rollback.", { change: false, pr: { body: "With rollback" } });
    expect(ticket().state).toBe("review");
    await blockTicket(h.ctx, ticket(), { reason: "Reviewers are down", needs: "", actor: "human" });
    branchAt(ticket().head_sha!);
    expect(await again()).toMatchObject({ state: "review" });
    expect(h.host.callsTo("prEdit")).toEqual([]);
    await spawnReviewers(h.ctx, project(), spec());
    expect(briefs().at(-1)).toContain("The worker proposes:");
  });
});

describe("after_push once per push", () => {
  const ELSEWHERE = "loom/csv/elsewhere";
  /** A fix round approved and ready to push as sq2, on a pull request Loom must also move from ELSEWHERE to main. */
  async function pushAndMove(): Promise<void> {
    const worker = await openProposed({ forge: { kind: "gh", after_push: ["ci start"] } });
    await fixRound({ items: [review] });
    await handIn(worker, "Renamed it.");
    await approveRound();
    await ask();
    handInPrText(h.ctx, worker.thread_id!, { commit_message: "Rename" });
    h.store.updateTicket(ticket().id, { pr_base: ELSEWHERE });
  }
  const hooks = () => h.host.callsTo("exec").filter((call) => call.command === "ci start");
  const runs = () => h.store.ticketEvents(ticket().id, ["ticket.after_push"]).map((event) => JSON.parse(event.data_json));

  it("runs for the push at once, on the base it has, when the move waits, and once more for the move when it succeeds later", async () => {
    await pushAndMove();
    h.host.scripted.prRetarget = [{ outcome: "unavailable", message: "gh pr edit failed: HTTP 502", transient: "server" }];
    await queue();
    expect(ticket()).toMatchObject({ state: "merging", pr_base: ELSEWHERE });
    expect(hooks()).toEqual([expect.objectContaining({ env: expect.objectContaining({ LOOM_SHA: "sq2", LOOM_BASE: ELSEWHERE }) })]);
    h.clock.advance(2 * 60_000);
    await queue();
    expect(ticket()).toMatchObject({ state: "pr_open", pr_base: "main" });
    expect(h.host.callsTo("push").map((call) => call.src)).toEqual(["sq1", "sq2", "sq2"]);
    expect(hooks().map((call) => call.env!.LOOM_BASE)).toEqual([ELSEWHERE, "main"]);
    await queue();
    expect(hooks()).toHaveLength(2);
    expect(runs()).toEqual([
      { sha: "sq2", url: URL, branch: ticket().pr_branch, base: ELSEWHERE, pushed: true, moved: false },
      { sha: "sq2", url: URL, branch: ticket().pr_branch, base: "main", pushed: false, moved: true },
    ]);
  });

  it("runs once, after the move, on the new base, when the push and the move both succeed", async () => {
    await pushAndMove();
    await queue();
    expect(ticket()).toMatchObject({ state: "pr_open", pr_base: "main" });
    expect(hooks().map((call) => call.env!.LOOM_BASE)).toEqual(["main"]);
    expect(runs()).toEqual([{ sha: "sq2", url: URL, branch: ticket().pr_branch, base: "main", pushed: true, moved: true }]);
  });

  it("keeps the push's run when the pull request merges while the merge waits to move it", async () => {
    await pushAndMove();
    h.host.scripted.prRetarget = [{ outcome: "unavailable", message: "gh pr edit failed: HTTP 502", transient: "server" }];
    await queue();
    h.host.prStates.set(URL, "MERGED");
    h.clock.advance(2 * 60_000);
    await queue();
    expect(ticket().state).toBe("done");
    expect(hooks()).toEqual([expect.objectContaining({ env: expect.objectContaining({ LOOM_SHA: "sq2", LOOM_BASE: ELSEWHERE }) })]);
    expect(runs()).toEqual([expect.objectContaining({ sha: "sq2", pushed: true, moved: false })]);
  });

  it("runs for the push on the base it has when gh cannot move the pull request and the project pauses", async () => {
    await pushAndMove();
    h.host.scripted.prRetarget = [{ outcome: "unavailable", message: "gh pr edit failed: HTTP 422: base branch is not valid" }];
    await queue();
    expect(h.store.projectBySlug("csv")!.state).toBe("paused");
    expect(ticket()).toMatchObject({ state: "merging", pr_base: ELSEWHERE });
    expect(hooks()).toEqual([expect.objectContaining({ env: expect.objectContaining({ LOOM_BASE: ELSEWHERE }) })]);
    expect(runs()).toEqual([expect.objectContaining({ base: ELSEWHERE, pushed: true, moved: false })]);
  });
});

describe("the reply cap", () => {
  it("holds for replies sent at once", async () => {
    const worker = await openProposed();
    await fixRound({ items: [thread] });
    const results = await Promise.allSettled(Array.from({ length: 31 }, (_, index) => replyToItem(h.ctx, worker.thread_id!, { item: thread.key, text: `Reply ${index}` })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(30);
    expect(results.filter((result) => result.status === "rejected").map((result) => String((result as PromiseRejectedResult).reason))).toEqual([expect.stringContaining("You posted 30 replies in this fix round")]);
    expect(h.host.callsTo("prReply")).toHaveLength(30);
  });
});

describe("a newer proposal while an edit waits", () => {
  /** A text-only fix approved, and its edit waiting after a temporary failure; then a new fix round starts on the same read. */
  async function waiting(): Promise<ThreadRow> {
    const worker = await openProposed();
    await fixRound({ items: [review] });
    await handIn(worker, "Described it.", { change: false, pr: { body: "Second" } });
    await approveRound();
    h.host.scripted.prEdit = [{ outcome: "unavailable", message: "gh pr edit failed: HTTP 503", transient: "server" }];
    await queue();
    expect(JSON.parse(ticket().pr_applied_json!)).toMatchObject({ body: PROPOSED.body, want: { body: "Second" } });
    await fixRound({ head: "sq1", items: [{ ...review, key: "review:7:keep" }] });
    return worker;
  }

  it("drops the waiting edit when the newer approved text is the one the pull request has, so the older edit never lands", async () => {
    const worker = await waiting();
    await handIn(worker, "Keep the original description.", { change: false, pr: { body: PROPOSED.body } });
    expect(ticket().state).toBe("review");
    await spawnReviewers(h.ctx, project(), spec());
    expect(briefs().at(-1)).toContain("An approved text Loom has not set yet, after a failed edit, which it sets unless a newer approved text replaces it:\nTitle: Add order rows\nDescription:\nSecond");
    const reviewer = h.store.threads({ ticketId: ticket().id, role: "reviewer" }).at(-1)!;
    checkOutHead(h, reviewer);
    await approve(h.ctx, reviewer.thread_id!, "Keeping it is right.");
    await settleReviews(h.ctx);
    await queue();
    expect(ticket().state).toBe("pr_open");
    expect(h.host.callsTo("prEdit")).toHaveLength(1);
    expect(outcomes("pr_edit_superseded")[0]!.post.body).toBe(`Dropped the edit of ${URL} that waited to be tried again: the newest approved title and description are the ones the pull request has.`);
    expect(JSON.parse(ticket().pr_applied_json!)).toMatchObject({ body: PROPOSED.body });
    expect(JSON.parse(ticket().pr_applied_json!)).not.toHaveProperty("want");
    expect(ticket().pr_proposal_json).toBeNull();
    h.host.feedback.set(URL, { head: "sq1" });
    await poll();
    expect(h.host.callsTo("prEdit")).toHaveLength(1);
    expect(h.host.texts.get(URL)!.body).toBe(`${PROPOSED.body}\n\n${block()}`);
  });

  it("sets a newer proposal instead of the waiting edit", async () => {
    const worker = await waiting();
    await handIn(worker, "A better description.", { change: false, pr: { body: "Third" } });
    await approveRound();
    await queue();
    expect(h.host.callsTo("prEdit").map((call) => call.body)).toEqual([`Second\n\n${block()}`, `Third\n\n${block()}`]);
    expect(JSON.parse(ticket().pr_applied_json!)).toMatchObject({ body: "Third" });
    expect(JSON.parse(ticket().pr_applied_json!)).not.toHaveProperty("want");
    h.host.feedback.set(URL, { head: "sq1" });
    await poll();
    expect(h.host.callsTo("prEdit")).toHaveLength(2);
    expect(h.host.texts.get(URL)!.body).toBe(`Third\n\n${block()}`);
  });

  it("goes straight back to pr_open for a proposal of the waiting text, and a later read sets it", async () => {
    const worker = await waiting();
    await handIn(worker, "Same as approved.", { change: false, pr: { body: "Second" } });
    expect(ticket().state).toBe("pr_open");
    h.host.feedback.set(URL, { head: "sq1" });
    await poll();
    expect(h.host.texts.get(URL)!.body).toBe(`Second\n\n${block()}`);
  });

  it("keeps a newer proposal when a read retries the waiting edit", async () => {
    const worker = await openProposed();
    await fixRound({ items: [review] });
    await handIn(worker, "Described it.", { change: false, pr: { body: "Second" } });
    await approveRound();
    h.host.scripted.prEdit = [{ outcome: "unavailable", message: "gh pr edit failed: HTTP 503", transient: "server" }];
    await queue();
    expect(ticket().state).toBe("pr_open");
    h.store.updateTicket(ticket().id, { pr_proposal_json: JSON.stringify({ head: ticket().head_sha, title: null, body: "Newer", at: h.clock.t }) });
    h.host.feedback.set(URL, { head: "sq1" });
    await poll();
    expect(h.host.texts.get(URL)!.body).toBe(`Second\n\n${block()}`);
    expect(JSON.parse(ticket().pr_proposal_json!)).toMatchObject({ body: "Newer" });
  });
});

describe("the text of a stacked pull request Loom opens again after the forge closed it", () => {
  const URL2 = "https://github.com/acme/shop/pull/2";
  const second = () => ticketOf(h, "CSV-2");
  const APPROVED = { title: "Approved export title", body: "Streams the file." };
  const FIXED = "Streams the file.\n\n## Rollback\nRevert the commit.";

  async function approveTicket(key: string): Promise<void> {
    await spawnReviewers(h.ctx, project(), spec());
    const reviewer = h.store.threads({ ticketId: ticketOf(h, key).id, role: "reviewer" }).at(-1)!;
    checkOutHead(h, reviewer);
    await approve(h.ctx, reviewer.thread_id!, "Holds.");
    await settleReviews(h.ctx);
  }

  /** CSV-2's pull request opened on CSV-1's branch with the text the reviewers approved, and a reviewed fix changed only its description; `editFails` leaves that edit waiting. */
  async function stackedWithFixedText(editFails = false): Promise<void> {
    await seedProject(h, pr());
    const first = await startWorker(h, "CSV-1");
    await handIn(first, "Mapped every order.", { pr: PROPOSED });
    await approveTicket("CSV-1");
    await ask();
    handInPrText(h.ctx, first.thread_id!, { commit_message: "Add the order row mapper" });
    await queue();
    const worker = await startWorker(h, "CSV-2");
    await handIn(worker, "Exported.", { pr: APPROVED });
    await approveTicket("CSV-2");
    await ask();
    handInPrText(h.ctx, worker.thread_id!, { commit_message: "Add the export endpoint" });
    await queue();
    expect(second()).toMatchObject({ state: "pr_open", pr_url: URL2, pr_base: ticket().pr_branch });
    expect(h.host.callsTo("prCreate").at(-1)).toMatchObject({ title: APPROVED.title });

    h.host.feedback.set(URL2, { items: [{ ...thread, key: "thread:PRRT_2:1:a", url: `${URL2}#discussion_r1` }] });
    await poll();
    expect(second().state).toBe("working");
    await handIn(worker, "Described the rollback.", { change: false, pr: { body: FIXED } });
    await approveTicket("CSV-2");
    if (editFails) h.host.scripted.prEdit = [{ outcome: "unavailable", message: "gh pr edit failed: HTTP 502", transient: "server" }];
    await queue();
    expect(second().state).toBe("pr_open");
    expect(JSON.parse(second().pr_text_json!)).toMatchObject({ title: null, body: null });
    expect(JSON.parse(second().pr_applied_json!)).toMatchObject(editFails ? { body: APPROVED.body, want: { title: APPROVED.title, body: FIXED } } : { title: APPROVED.title, body: FIXED });
  }

  /** CSV-1's pull request merged and its branch went away, so the forge closed CSV-2's, which kept `kept`, and the merge queue opens a new one on main. */
  async function reopened(kept: { title: string; body: string | null } = { title: APPROVED.title, body: FIXED }): Promise<void> {
    h.host.prStates.set(URL, "MERGED");
    h.host.prStates.set(URL2, "CLOSED");
    h.host.remoteBranches.delete(ticket().pr_branch!);
    await poll();
    expect(second()).toMatchObject({ state: "pr_open", pr_url: null });
    expect(JSON.parse(second().pr_applied_json!)).toEqual({ ...kept, live: [], at: h.clock.t });
    h.host.remoteBase = "base001";
    await queue();
    expect(second()).toMatchObject({ state: "pr_open", pr_url: "https://github.com/acme/shop/pull/3", pr_base: "main" });
  }

  it("opens the new one with the title and description the reviewers approved last, and Loom's own sections as they are now", async () => {
    await stackedWithFixedText();
    await reopened();
    expect(h.host.callsTo("prCreate").at(-1)).toMatchObject({ base: "main", title: APPROVED.title, body: `${FIXED}\n\n${block("CSV-2")}` });
    expect(JSON.parse(second().pr_applied_json!)).toEqual({ title: APPROVED.title, body: FIXED, live: [], at: h.clock.t });
  });

  it("opens it with an approved text whose edit was still waiting to be tried again", async () => {
    await stackedWithFixedText(true);
    await reopened();
    expect(h.host.callsTo("prCreate").at(-1)).toMatchObject({ title: APPROVED.title, body: `${FIXED}\n\n${block("CSV-2")}` });
    expect(JSON.parse(second().pr_applied_json!)).not.toHaveProperty("want");
  });

  it("keeps Loom's template field by field: a kept title with the template's description", async () => {
    await stackedWithFixedText();
    h.store.updateTicket(second().id, { pr_applied_json: JSON.stringify({ title: APPROVED.title, body: null, live: [], at: 0 }) });
    await reopened({ title: APPROVED.title, body: null });
    const created = h.host.callsTo("prCreate").at(-1)!;
    expect(created.title).toBe(APPROVED.title);
    expect(created.body).toContain("Opened by Loom for CSV-2.");
    expect(created.body).not.toContain(FIXED);
  });
});
