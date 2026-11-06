import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { settleChecks, submit } from "../src/checks";
import type { ThreadRow } from "../src/db/store";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { askForPrTexts, handInPrText } from "../src/pull-requests";
import { maintainFinalReviews } from "../src/auto-merge";
import { SpawnRefusedError } from "../src/ports";
import { approve, requestChanges, settleReviews, spawnReviewers, type Finding } from "../src/review";
import { projectMetrics } from "../src/reports";
import { formatMetrics } from "../src/cli";
import { PR_TEXT_CORE } from "../src/prompts";
import { resumeEnding } from "../src/workers";
import { specOf } from "../src/ctx";
import { checkOutHead, makeCtx, makeEngine, seedMachineProject, seedProject, startWorker, ticketOf, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;
beforeEach(() => {
  h = makeCtx();
});

const URL = "https://github.com/acme/shop/pull/1";
const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const ticket = () => ticketOf(h, "CSV-1");
const pr = (more: Doc = {}) => (doc: Doc) => {
  doc.merge = { strategy: "pr", ...more };
};
type Spawn = { prompt: string; detail?: string; reasoningLevel?: string; title: string; hostId: string; workspace?: { path: string }; environment?: unknown };
const spawns = () => h.bb.callsTo("spawnThread").map(([args]) => args as Spawn);
const brief = () => {
  const last = spawns().at(-1)!;
  return `${last.prompt}\n${last.detail ?? ""}`;
};
const execs = () => h.host.callsTo("exec").length;
const reviewers = () => h.store.threads({ ticketId: ticket().id, role: "reviewer" });
const PROPOSED = { title: "Add order rows", body: "## Summary\nAdd order rows.\n\n**Why:** Support wants CSV exports." };
const textFinding: Finding = { severity: "blocking", kind: "text", title: "Names a ticket key", detail: "Name the other change by its pull request link." };
const codeFinding: Finding = { severity: "blocking", kind: "code", title: "Off by one", detail: "The last row is dropped.", file: "src/model/a.ts", line: 3 };

async function handIn(worker: ThreadRow, summary: string, a: { change?: boolean; pr?: { title?: string; body?: string } } = {}): Promise<void> {
  const worktree = h.host.worktree(`/wt/${worker.environment_id}`);
  if (a.change !== false) {
    worktree.dirty = true;
    worktree.changed = ["src/model/a.ts"];
  }
  submit(h.ctx, worker.thread_id!, summary, a.pr);
  await settleChecks(h.ctx);
}

/** Starts the round's next reviewer and returns it. `checkout` puts the reviewed work in its worktree, as a code reviewer must. */
async function nextReviewer(checkout = true): Promise<ThreadRow> {
  await spawnReviewers(h.ctx, project(), spec());
  const reviewer = reviewers().at(-1)!;
  if (checkout) checkOutHead(h, reviewer);
  return reviewer;
}

async function settle(): Promise<void> {
  await settleReviews(h.ctx);
}

async function openProposed(more: Doc = {}): Promise<ThreadRow> {
  await seedProject(h, pr(more));
  const worker = await startWorker(h);
  await handIn(worker, "Mapped every order.", { pr: PROPOSED });
  await approve(h.ctx, (await nextReviewer()).thread_id!, "Holds.");
  await settle();
  await askForPrTexts(h.ctx, project(), spec());
  handInPrText(h.ctx, worker.thread_id!, { commit_message: "Add the order row mapper" });
  await runMergeQueue(h.ctx, project(), spec());
  await settleMerges(h.ctx);
  expect(ticket().state).toBe("pr_open");
  return worker;
}

describe("a text-only fix round on an open pull request", () => {
  it("runs no checks and no code review: one short text review at low reasoning judges it, and its approval sets the text with nothing pushed", async () => {
    const worker = await openProposed();
    h.host.feedback.set(URL, { items: [{ key: "review:3:def", kind: "review", author: "bob", bot: false, body: "Please say how to verify it.", url: `${URL}#r3`, state: "changes_requested", path: null, line: null }] });
    h.clock.advance(5 * 60_000);
    await pollPullRequests(h.ctx, project());
    expect(ticket().state).toBe("working");

    const before = execs();
    const body = "## Summary\nAdd order rows.\n\n**Testing:** CI runs the unit suite.";
    await handIn(worker, "Said how to verify it.", { change: false, pr: { body } });
    expect(ticket().state).toBe("review");
    expect(execs()).toBe(before);

    const spawned = spawns().length;
    const reviewer = await nextReviewer(false);
    expect(spawns()).toHaveLength(spawned + 1);
    const spawn = spawns().at(-1)!;
    expect(spawn.reasoningLevel).toBe("low");
    expect(spawn.title).toBe("Text review CSV-1 · round 2");
    const text = brief();
    expect(text).toContain("Loom's text review");
    expect(text).toContain("src/a.ts | 2 +-");
    expect(text).not.toContain("diff --git");
    expect(text).not.toContain("loom_checkout");
    expect(text).toContain(body);
    expect(text).toContain(`Title: ${PROPOSED.title}`);
    expect(text).toContain("Please say how to verify it.");
    for (const rule of PR_TEXT_CORE) expect(text).toContain(rule);

    // A text reviewer needs no checkout.
    await approve(h.ctx, reviewer.thread_id!, "The text holds.");
    await settle();
    expect(ticket().state).toBe("approved");
    const pushes = h.host.callsTo("push").length;
    await runMergeQueue(h.ctx, project(), spec());
    await settleMerges(h.ctx);
    expect(ticket().state).toBe("pr_open");
    expect(h.host.callsTo("push")).toHaveLength(pushes);
    expect(h.host.callsTo("prEdit").at(-1)).toMatchObject({ url: URL, title: PROPOSED.title });
    expect(h.host.callsTo("prEdit").at(-1)!.body.startsWith(body)).toBe(true);
  });
});

describe("a round whose findings are all about the text", () => {
  it("goes back to the worker as a text-only round, whose submit skips the checks and the code review, and the pull request opens with the approved text", async () => {
    await seedProject(h, pr());
    const worker = await startWorker(h);
    await handIn(worker, "Mapped every order.", { pr: { title: "CSV-1: rows", body: "Implements CSV-1." } });
    const code = await nextReviewer();
    await requestChanges(h.ctx, code.thread_id!, "The code holds; the description does not.", [textFinding]);
    await settle();
    expect(ticket().state).toBe("working");
    const message = h.bb.sent(worker.thread_id!).at(-1)!;
    expect(message).toContain("only the pull request's title and description");
    expect(message).toContain("Change no files");
    expect(message).toContain("loom_submit({ summary, pr: { title, body } })");
    expect(message).toContain("Loom sets the text");
    expect(message).toContain("Do not call loom_block for it");

    const before = execs();
    await handIn(worker, "Rewrote the description.", { change: false, pr: PROPOSED });
    expect(ticket().state).toBe("review");
    expect(execs()).toBe(before);
    expect(h.store.posts(ticket().id).filter((post) => post.kind === "check").at(-1)!.body).toContain("No checks ran");
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("Loom's text review judges it now");

    const text = await nextReviewer(false);
    expect(spawns().at(-1)!.reasoningLevel).toBe("low");
    expect(brief()).toContain("Implements CSV-1.");
    await approve(h.ctx, text.thread_id!, "Reads well.");
    await settle();
    expect(ticket().state).toBe("approved");

    await askForPrTexts(h.ctx, project(), spec());
    handInPrText(h.ctx, worker.thread_id!, { commit_message: "Add the order row mapper" });
    await runMergeQueue(h.ctx, project(), spec());
    await settleMerges(h.ctx);
    expect(h.host.callsTo("prCreate")[0]).toMatchObject({ title: PROPOSED.title });
    expect(h.host.callsTo("prCreate")[0]!.body.startsWith(PROPOSED.body)).toBe(true);
  });

  it("goes back again as a text-only round when the text review asks for changes, whatever kind its findings name", async () => {
    await seedProject(h, pr());
    const worker = await startWorker(h);
    await handIn(worker, "Done.", { pr: { title: "T", body: "B" } });
    await requestChanges(h.ctx, (await nextReviewer()).thread_id!, "Text.", [textFinding]);
    await settle();
    await handIn(worker, "Rewrote it.", { change: false, pr: { body: "Still names CSV-2." } });
    await requestChanges(h.ctx, (await nextReviewer(false)).thread_id!, "Still a key.", [{ ...textFinding, kind: "code" }]);
    await settle();
    expect(ticket().state).toBe("working");
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("Change no files");
    const stored = JSON.parse(h.store.reviews(ticket().id).at(-1)!.findings_json) as Finding[];
    expect(stored.every((finding) => finding.kind === "text")).toBe(true);
    const before = execs();
    await handIn(worker, "Linked it.", { change: false, pr: { body: "Builds on https://github.com/acme/shop/pull/7." } });
    expect(execs()).toBe(before);
    expect(spawns().length).toBeGreaterThan(0);
  });

  it("waits for the code approvals the spec needs before it goes back as text, and a code finding from another reviewer makes it a normal round", async () => {
    await seedProject(h, (doc) => {
      pr()(doc);
      doc.review = { approvals: 2 };
    });
    const worker = await startWorker(h);
    await handIn(worker, "Done.", { pr: { title: "T", body: "B" } });
    await spawnReviewers(h.ctx, project(), spec());
    const [first, second] = reviewers();
    checkOutHead(h, first!);
    checkOutHead(h, second!);
    await requestChanges(h.ctx, first!.thread_id!, "Text only.", [textFinding]);
    await settle();
    expect(ticket().state).toBe("review");
    expect(h.store.thread(second!.id)!.state).toBe("active");
    await approve(h.ctx, second!.thread_id!, "Code holds.");
    await settle();
    expect(ticket().state).toBe("working");
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("Change no files");

    h = makeCtx();
    await seedProject(h, (doc) => {
      pr()(doc);
      doc.review = { approvals: 2 };
    });
    const other = await startWorker(h);
    await handIn(other, "Done.", { pr: { title: "T", body: "B" } });
    await spawnReviewers(h.ctx, project(), spec());
    const [a, b] = reviewers();
    checkOutHead(h, a!);
    checkOutHead(h, b!);
    await requestChanges(h.ctx, a!.thread_id!, "Text only.", [textFinding]);
    await requestChanges(h.ctx, b!.thread_id!, "A bug.", [codeFinding]);
    await settle();
    expect(ticket().state).toBe("working");
    const sent = h.bb.sent(other.thread_id!).at(-1)!;
    expect(sent).not.toContain("Change no files");
    expect(sent).toContain("Off by one");
    expect(sent).toContain("Names a ticket key");
  });
});

describe("the review round limit", () => {
  const limited = (doc: Doc) => {
    pr()(doc);
    doc.review = { max_rounds: 2 };
  };

  it("counts text-only rounds apart from code rounds, so text churn never uses up the code review's rounds", async () => {
    await seedProject(h, limited);
    const worker = await startWorker(h);
    await handIn(worker, "Done.", { pr: { title: "T", body: "B" } });
    await requestChanges(h.ctx, (await nextReviewer()).thread_id!, "Text.", [textFinding]);
    await settle();
    await handIn(worker, "Changed code too.", { pr: { body: "Better." } });
    await requestChanges(h.ctx, (await nextReviewer()).thread_id!, "A bug.", [codeFinding]);
    await settle();
    expect(ticket().state).toBe("working");
  });

  it("blocks once the text alone was sent back max_rounds times, saying it was the text", async () => {
    await seedProject(h, limited);
    const worker = await startWorker(h);
    await handIn(worker, "Done.", { pr: { title: "T", body: "B" } });
    await requestChanges(h.ctx, (await nextReviewer()).thread_id!, "Text.", [textFinding]);
    await settle();
    await handIn(worker, "Rewrote it.", { change: false, pr: { body: "Better." } });
    await requestChanges(h.ctx, (await nextReviewer(false)).thread_id!, "Still not.", [textFinding]);
    await settle();
    expect(ticket().state).toBe("blocked");
    expect(ticket().blocked_reason).toBe("review requested changes to the pull request's text in 2 rounds");
  });
});

describe("a mixed round", () => {
  it("goes through the checks and a code review, even when the worker changes only the text", async () => {
    await seedProject(h, pr());
    const worker = await startWorker(h);
    await handIn(worker, "Done.", { pr: { title: "T", body: "B" } });
    await requestChanges(h.ctx, (await nextReviewer()).thread_id!, "Both.", [textFinding, codeFinding]);
    await settle();
    expect(h.bb.sent(worker.thread_id!).at(-1)).not.toContain("Change no files");
    const before = execs();
    await handIn(worker, "Only the text.", { change: false, pr: { body: "Better." } });
    expect(execs()).toBeGreaterThan(before);
    expect(ticket().state).toBe("review");
    await nextReviewer();
    expect(spawns().at(-1)!.reasoningLevel).toBeUndefined();
    expect(brief()).toContain("diff --git");
    expect(brief()).toContain("Call loom_checkout first");
  });

  it("runs the checks when the worker of a text-only round changes files after all", async () => {
    await seedProject(h, pr());
    const worker = await startWorker(h);
    await handIn(worker, "Done.", { pr: { title: "T", body: "B" } });
    await requestChanges(h.ctx, (await nextReviewer()).thread_id!, "Text.", [textFinding]);
    await settle();
    const before = execs();
    await handIn(worker, "Changed code too.", { pr: { body: "Better." } });
    expect(execs()).toBeGreaterThan(before);
    await nextReviewer();
    expect(brief()).toContain("diff --git");
  });
});

describe("a text finding where the worker writes no text", () => {
  it("is an ordinary finding with describe = \"loom\", since the worker cannot propose text there", async () => {
    await seedProject(h, pr({ describe: "loom" }));
    const worker = await startWorker(h);
    await handIn(worker, "Done.");
    await requestChanges(h.ctx, (await nextReviewer()).thread_id!, "Text.", [textFinding]);
    await settle();
    expect(ticket().state).toBe("working");
    expect(h.bb.sent(worker.thread_id!).at(-1)).not.toContain("Change no files");
    expect(brief()).not.toContain('kind "text"');
  });
});

describe("the briefs", () => {
  it("give the worker the core rules for its pull request's text, the same rules the skill lists", async () => {
    await seedProject(h, pr());
    await startWorker(h);
    const worker = brief();
    expect(worker).toContain("## How to write the pull request's text");
    for (const rule of PR_TEXT_CORE) expect(worker).toContain(`- ${rule}`);
    const skill = readFileSync(new globalThis.URL("../skills/loom-pr-description/SKILL.md", import.meta.url), "utf8");
    const section = skill.split("## Core rules\n")[1]!.split("\n## ")[0]!;
    const listed = section.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
    expect(listed).toEqual([...PR_TEXT_CORE]);
    expect(PR_TEXT_CORE.join(" ")).not.toMatch(/shopify|world/i);
  });

  it("tell the code reviewer to tag findings by kind, and that the merge and deploy order is Loom's, a spec matter when it is wrong", async () => {
    await seedProject(h, pr());
    const worker = await startWorker(h);
    await handIn(worker, "Done.", { pr: PROPOSED });
    await nextReviewer();
    const text = brief();
    expect(text).toContain('kind "text"');
    expect(text).toContain('kind "code"');
    expect(text).toContain("The merge and deploy order, the prerequisites and the Rollout section are Loom's");
    expect(text).toContain("say so in your verdict's summary for the planner");
  });
});

describe("metrics", () => {
  it("count text reviews and text-only rounds apart from code reviews", async () => {
    await seedProject(h, pr());
    const worker = await startWorker(h);
    await handIn(worker, "Done.", { pr: { title: "T", body: "B" } });
    await requestChanges(h.ctx, (await nextReviewer()).thread_id!, "Text.", [textFinding]);
    await settle();
    await handIn(worker, "Rewrote it.", { change: false, pr: PROPOSED });
    await approve(h.ctx, (await nextReviewer(false)).thread_id!, "Good.");
    await settle();

    const metrics = projectMetrics(h.store, project(), h.clock.t);
    expect(metrics.textReviews).toEqual({ reviews: 1, approved: 1, changesRequested: 0, textOnlyRounds: 1 });
    expect(metrics.findings).toMatchObject({ total: 1, rounds: 1, changesRequested: 1 });
    expect(formatMetrics(metrics)).toContain("text reviews 1 (1 approved, 0 changes requested); 1 text-only round sent back to the worker");
  });
});

/** A ticket whose text-only round the text review approved: it waits for loom_pr. `opened`: on an open pull request, as a fix. */
async function textApproved(worker: ThreadRow, proposal: { title?: string; body?: string }): Promise<void> {
  await requestChanges(h.ctx, (await nextReviewer()).thread_id!, "Text.", [textFinding]);
  await settle();
  await handIn(worker, "Rewrote it.", { change: false, pr: proposal });
  await approve(h.ctx, (await nextReviewer(false)).thread_id!, "Good.");
  await settle();
  expect(ticket().state).toBe("approved");
  await askForPrTexts(h.ctx, project(), spec());
}

describe("loom_pr after the reviewers approved the text", () => {
  it("refuses a title or description the text review approved, saying to propose it with loom_submit's pr, and opens with the approved text", async () => {
    await seedProject(h, pr());
    const worker = await startWorker(h);
    await handIn(worker, "Done.", { pr: { title: "T", body: "Implements CSV-1." } });
    await textApproved(worker, { body: "Approved description." });
    expect(h.bb.sent(worker.thread_id!).at(-1)).not.toContain("given, they win");
    expect(() => handInPrText(h.ctx, worker.thread_id!, { body: "UNREVIEWED CSV-1 jargon", commit_message: "Add order rows" })).toThrow("propose it with loom_submit's pr");
    expect(() => handInPrText(h.ctx, worker.thread_id!, { title: "Other", commit_message: "Add order rows" })).toThrow("the reviewers approved");
    handInPrText(h.ctx, worker.thread_id!, { commit_message: "Add order rows" });
    await runMergeQueue(h.ctx, project(), spec());
    await settleMerges(h.ctx);
    expect(h.host.callsTo("prCreate")[0]).toMatchObject({ title: "T" });
    expect(h.host.callsTo("prCreate")[0]!.body.startsWith("Approved description.")).toBe(true);
  });

  it("refuses a field the code review approved, takes the one no one proposed, and keeps the no-proposal workflow", async () => {
    await seedProject(h, pr());
    const worker = await startWorker(h);
    await handIn(worker, "Done.", { pr: { body: "Reviewed body." } });
    await approve(h.ctx, (await nextReviewer()).thread_id!, "Holds.");
    await settle();
    await askForPrTexts(h.ctx, project(), spec());
    expect(() => handInPrText(h.ctx, worker.thread_id!, { title: "Add rows", body: "Other body", commit_message: "Add rows" })).toThrow("description");
    handInPrText(h.ctx, worker.thread_id!, { title: "Add rows", commit_message: "Add rows" });
    await runMergeQueue(h.ctx, project(), spec());
    await settleMerges(h.ctx);
    expect(h.host.callsTo("prCreate")[0]).toMatchObject({ title: "Add rows" });
    expect(h.host.callsTo("prCreate")[0]!.body.startsWith("Reviewed body.")).toBe(true);

    h = makeCtx();
    await seedProject(h, pr());
    const plain = await startWorker(h);
    await handIn(plain, "Done.");
    await approve(h.ctx, (await nextReviewer()).thread_id!, "Holds.");
    await settle();
    await askForPrTexts(h.ctx, project(), spec());
    handInPrText(h.ctx, plain.thread_id!, { title: "Add rows", body: "Why.", commit_message: "Add rows" });
    await runMergeQueue(h.ctx, project(), spec());
    await settleMerges(h.ctx);
    expect(h.host.callsTo("prCreate")[0]).toMatchObject({ title: "Add rows" });
  });

  it("takes only the commit message in a fix round, so a checked text round pushes the fix and sets the approved text", async () => {
    const worker = await openProposed();
    h.host.feedback.set(URL, { items: [{ key: "review:3:def", kind: "review", author: "bob", bot: false, body: "Fix the bug.", url: `${URL}#r3`, state: "changes_requested", path: null, line: null }] });
    h.clock.advance(5 * 60_000);
    await pollPullRequests(h.ctx, project());
    await handIn(worker, "Fixed it.");
    await textApproved(worker, { body: "Approved fix description." });
    expect(() => handInPrText(h.ctx, worker.thread_id!, { body: "UNREVIEWED", commit_message: "Fix" })).toThrow("propose it with loom_submit's pr");
    handInPrText(h.ctx, worker.thread_id!, { commit_message: "Fix" });
    const pushes = h.host.callsTo("push").length;
    await runMergeQueue(h.ctx, project(), spec());
    await settleMerges(h.ctx);
    expect(h.host.callsTo("push").length).toBeGreaterThan(pushes);
    expect(h.host.callsTo("prEdit").at(-1)!.body.startsWith("Approved fix description.")).toBe(true);
  });
});

describe("the text review's scratch directory", () => {
  const key = () => `loom-text-review-${reviewers().at(-1)!.id}`;

  async function toTextReview(): Promise<ThreadRow> {
    const worker = await startWorker(h);
    await handIn(worker, "Done.", { pr: { title: "T", body: "B" } });
    await requestChanges(h.ctx, (await nextReviewer()).thread_id!, "Text.", [textFinding]);
    await settle();
    await handIn(worker, "Rewrote it.", { change: false, pr: PROPOSED });
    return worker;
  }

  it("starts the text reviewer in an empty scratch directory on the project's machine, with no environment or machine, and removes it once the reviewer stops", async () => {
    await seedMachineProject(h, pr());
    await toTextReview();
    const reviewer = await nextReviewer(false);
    const spawn = spawns().at(-1)!;
    expect(spawn.title).toContain("Text review");
    expect(spawn.workspace).toEqual({ path: `/data/final-review/${key()}` });
    expect(spawn.environment).toBeUndefined();
    expect(spawn.hostId).toBe(project().host_id);
    expect(h.host.scratch.has(key())).toBe(true);
    const owned = key();
    await approve(h.ctx, reviewer.thread_id!, "Good.");
    await settle();
    expect(h.store.thread(reviewer.id)!.state).toBe("ended");
    expect(h.host.scratch.has(owned)).toBe(false);
  });

  it("refuses loom_checkout, which a text review never needs", async () => {
    await seedProject(h, pr());
    await toTextReview();
    const reviewer = await nextReviewer(false);
    const { checkOutReview } = await import("../src/review");
    await expect(checkOutReview(h.ctx, reviewer.thread_id!)).rejects.toThrow("needs no checkout");
  });

  it("blocks the ticket, and starts nothing in the checkout, when the machine has no scratch directory outside bb's data", async () => {
    await seedProject(h, pr());
    await toTextReview();
    const real = h.host.call.bind(h.host);
    h.host.call = (async (hostId: string, method: string, input: any) =>
      method === "finalScratch" && input.action === "create" ? { path: "", entries: [], refused: "every cache directory is inside bb's data directory" } : real(hostId, method as never, input as never)) as typeof h.host.call;
    const before = spawns().length;
    await spawnReviewers(h.ctx, project(), spec());
    await settle();
    expect(spawns()).toHaveLength(before);
    expect(ticket().state).toBe("blocked");
    expect(ticket().blocked_reason).toContain("every cache directory is inside bb's data directory");
  });

  it("blocks the ticket and removes the directory when bb refuses it as a workspace", async () => {
    await seedProject(h, pr());
    await toTextReview();
    h.bb.spawnError = (args) => (args.workspace !== undefined ? new SpawnRefusedError(400, "bb refused the workspace path") : null);
    await spawnReviewers(h.ctx, project(), spec());
    await settle();
    expect(ticket().state).toBe("blocked");
    expect(ticket().blocked_reason).toContain("bb refused the workspace path");
    expect([...h.host.scratch.keys()].filter((name) => name.startsWith("loom-text-review-"))).toEqual([]);
    expect(spawns().filter((spawn) => spawn.environment !== undefined && spawn.title.includes("Text review"))).toEqual([]);
  });

  it("is swept after a restart between making it and binding the reviewer's thread, which ends the row", async () => {
    const engine = makeEngine();
    h = engine;
    await seedProject(h, pr());
    await toTextReview();
    await nextReviewer(false);
    const row = reviewers().at(-1)!;
    const owned = key();
    h.store.updateThread(row.id, { state: "spawning", thread_id: null, spawn_token: "lost-token" });
    await maintainFinalReviews(h.ctx);
    h.clock.advance(31 * 60_000);
    await maintainFinalReviews(h.ctx);
    expect(h.host.scratch.has(owned)).toBe(true);
    await engine.engine.reconcile();
    expect(h.store.thread(row.id)!.state).toBe("ended");
    h.clock.advance(31 * 60_000);
    await maintainFinalReviews(h.ctx);
    expect(h.host.scratch.has(owned)).toBe(false);
  });

  it("is kept by the sweep while its reviewer lives, and swept once a restart left it without one", async () => {
    await seedProject(h, pr());
    await toTextReview();
    await nextReviewer(false);
    const live = key();
    h.host.scratch.set("loom-text-review-999", []);
    await maintainFinalReviews(h.ctx);
    h.clock.advance(31 * 60_000);
    await maintainFinalReviews(h.ctx);
    expect(h.host.scratch.has(live)).toBe(true);
    expect(h.host.scratch.has("loom-text-review-999")).toBe(false);
  });
});

describe("the text review's scratch directory while bb is unsure", () => {
  const scratchOf = (row: ThreadRow) => `loom-text-review-${row.id}`;
  async function ready(): Promise<void> {
    await seedProject(h, pr());
    const worker = await startWorker(h);
    await handIn(worker, "Done.", { pr: PROPOSED });
    await requestChanges(h.ctx, (await nextReviewer()).thread_id!, "Text.", [textFinding]);
    await settle();
    await handIn(worker, "Fixed text.", { change: false, pr: { body: "Approved description." } });
  }
  const sweep = async () => {
    await maintainFinalReviews(h.ctx);
    h.clock.advance(31 * 60_000);
    await maintainFinalReviews(h.ctx);
  };

  it("keeps the directory, and the row that owns it, past the ending limit while the reviewer is still stopping and archiving fails; removes it once bb says it stopped", async () => {
    await ready();
    const reviewer = await nextReviewer(false);
    const key = scratchOf(reviewer);
    h.bb.stopConfirms = false;
    const archive = h.bb.archive.bind(h.bb);
    h.bb.archive = async () => {
      throw new Error("archive unavailable");
    };
    await approve(h.ctx, reviewer.thread_id!, "Good.");
    await settle();
    expect(h.store.thread(reviewer.id)!.state).toBe("ending");
    await sweep();
    expect(h.host.scratch.has(key)).toBe(true);
    await resumeEnding(h.ctx, h.store.thread(reviewer.id)!);
    expect((await h.bb.getThread(reviewer.thread_id!))!.status).toBe("stopping");
    expect(h.host.scratch.has(key)).toBe(true);
    expect(h.store.thread(reviewer.id)!.state).toBe("ending");
    await sweep();
    expect(h.host.scratch.has(key)).toBe(true);

    h.bb.stopConfirms = true;
    h.bb.archive = archive;
    h.clock.advance(6 * 60_000);
    await resumeEnding(h.ctx, h.store.thread(reviewer.id)!);
    expect(h.store.thread(reviewer.id)!.state).toBe("ended");
    expect(h.host.scratch.has(key)).toBe(false);
  });

  it("keeps the row, its token and its directory when the token lookup fails too, and adopts the thread once a later lookup finds it", async () => {
    await ready();
    const realSpawn = h.bb.spawnThread.bind(h.bb);
    const lookup = h.bb.findSpawnedThread.bind(h.bb);
    let accepted: string | undefined;
    h.bb.spawnThread = async (args) => {
      const result = await realSpawn(args);
      accepted = result.threadId;
      throw new Error("spawn reply lost");
    };
    h.bb.findSpawnedThread = async () => {
      throw new Error("thread lookup temporarily unavailable");
    };
    await spawnReviewers(h.ctx, project(), spec());
    h.bb.spawnThread = realSpawn;
    const row = reviewers().at(-1)!;
    const key = scratchOf(row);
    expect(row.state).toBe("spawning");
    expect(h.host.scratch.has(key)).toBe(true);
    await sweep();
    expect(h.host.scratch.has(key)).toBe(true);
    h.clock.advance(6 * 60_000);
    await spawnReviewers(h.ctx, project(), spec());
    expect(h.store.thread(row.id)!.state).toBe("spawning");

    h.bb.findSpawnedThread = lookup;
    expect(await lookup(row.spawn_token!)).toBe(accepted);
    expect((await h.bb.getThread(accepted!))!.status).toBe("active");
    await sweep();
    expect(h.host.scratch.has(key)).toBe(true);
    h.clock.advance(6 * 60_000);
    await spawnReviewers(h.ctx, project(), spec());
    expect(h.store.thread(row.id)).toMatchObject({ state: "active", thread_id: accepted, spawn_token: row.spawn_token });
    expect(h.host.scratch.has(key)).toBe(true);
    expect(spawns().filter((spawn) => spawn.title.includes("Text review"))).toHaveLength(1);
  });

  it("keeps an unresolved row through a restart whose lookup fails, and adopts its thread on a later pass", async () => {
    const engine = makeEngine();
    h = engine;
    await ready();
    const lookup = h.bb.findSpawnedThread.bind(h.bb);
    await nextReviewer(false);
    const row = reviewers().at(-1)!;
    const accepted = row.thread_id!;
    h.store.updateThread(row.id, { state: "spawning", thread_id: null });
    h.bb.findSpawnedThread = async () => {
      throw new Error("thread lookup temporarily unavailable");
    };
    await engine.engine.reconcile();
    expect(h.store.thread(row.id)!.state).toBe("spawning");
    expect(h.host.scratch.has(scratchOf(row))).toBe(true);
    h.bb.findSpawnedThread = lookup;
    h.clock.advance(6 * 60_000);
    await spawnReviewers(h.ctx, project(), spec());
    expect(h.store.thread(row.id)).toMatchObject({ state: "active", thread_id: accepted });
  });

  it("ends the row and removes the directory once a later lookup succeeds and finds no thread", async () => {
    await ready();
    const realSpawn = h.bb.spawnThread.bind(h.bb);
    const lookup = h.bb.findSpawnedThread.bind(h.bb);
    h.bb.spawnThread = async () => {
      throw new Error("bb went away");
    };
    h.bb.findSpawnedThread = async () => {
      throw new Error("thread lookup temporarily unavailable");
    };
    await spawnReviewers(h.ctx, project(), spec());
    const row = reviewers().at(-1)!;
    expect(h.store.thread(row.id)!.state).toBe("spawning");
    h.bb.findSpawnedThread = lookup;
    h.bb.spawnThread = realSpawn;
    h.clock.advance(6 * 60_000);
    await spawnReviewers(h.ctx, project(), spec());
    expect(h.store.thread(row.id)!.state).toBe("ended");
    expect(h.host.scratch.has(scratchOf(row))).toBe(false);
  });

  it("adopts the reviewer bb started when the answer to its spawn is lost, and keeps its directory", async () => {
    await ready();
    const real = h.bb.spawnThread.bind(h.bb);
    let accepted: string | undefined;
    h.bb.spawnThread = async (args) => {
      const result = await real(args);
      accepted = result.threadId;
      throw new Error("spawn reply lost");
    };
    await spawnReviewers(h.ctx, project(), spec());
    h.bb.spawnThread = real;
    const row = reviewers().at(-1)!;
    expect((await h.bb.getThread(accepted!))!.status).toBe("active");
    expect(row).toMatchObject({ state: "active", thread_id: accepted });
    expect(h.host.scratch.has(scratchOf(row))).toBe(true);
    await approve(h.ctx, accepted!, "Good.");
    await settle();
    expect(ticket().state).toBe("approved");
    expect(h.host.scratch.has(scratchOf(row))).toBe(false);
  });
});
