import { beforeEach, describe, expect, it } from "vitest";
import { settleChecks, submit } from "../src/checks";
import type { PostRow, ReviewRow, ThreadRow } from "../src/db/store";
import { SpawnRefusedError, type SpawnArgs } from "../src/ports";
import { afterMergeFailedText, changesRequestedText, conflictText, heldCheckResult, landBody, prBody, reviewerBrief, reviewerNudgeText } from "../src/prompts";
import { approve, onReviewerGone, onReviewerIdle, requestChanges, settleReviews, spawnReviewers, type Finding } from "../src/review";
import { endThread, requeueTicket, specOf } from "../src/workers";
import { checkOutHead, makeCtx, reachReview, seedProject, seedRepoProject, startWorker, ticketOf, withDocsTicket, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;

beforeEach(() => {
  h = makeCtx();
});

const findings: Finding[] = [
  { severity: "blocking", title: "Off by one", detail: "The loop skips the last order.", file: "src/model/a.ts", line: 12 },
  { severity: "should-fix", title: "Name is unclear", detail: "Rename `m` to `mapper`." },
];

async function readyTicket(edit?: (doc: Doc) => void) {
  const project = await seedProject(h, edit);
  const ticket = h.store.ticket(ticketOf(h, "CSV-1").id)!;
  h.store.updateTicket(ticket.id, { head_sha: "abc1234", review_round: 1 });
  const spec = JSON.parse(h.store.specVersion(project.id, project.approved_version!)!.spec_json);
  return { project, spec, ticket: h.store.ticket(ticket.id)! };
}

const checkPost = (over: Partial<PostRow> = {}): PostRow => ({
  id: 7,
  project_id: 1,
  ticket_id: 1,
  parent_id: null,
  author_kind: "loom",
  author_thread_id: null,
  kind: "check",
  body: "Checks passed (1 command).\npass npm test (exit 0, 1.2s)\n\nOutside the ticket's scope (scope.enforce is \"warn\"): docs/x.md",
  data_json: JSON.stringify({ passed: true, runs: [], outside: ["docs/x.md"], protectedHits: [] }),
  at: 0,
  ...over,
});

describe("reviewerBrief", () => {
  it("names the ticket, numbers the criteria, and tells the reviewer to check out head_sha first", async () => {
    const { project, spec, ticket } = await readyTicket((doc) => (doc.review = { rubric: ["Every public function has a test"] }));
    const brief = reviewerBrief({ project, spec, ticket, round: 1, diff: { stat: " src/a.ts | 2 +-", patch: "diff --git a/src/a.ts b/src/a.ts\n+x", truncated: false }, checkPost: checkPost(), earlierReviews: [] });
    expect(brief).toContain("You are a Loom reviewer for CSV-1, round 1");
    expect(brief).toContain("git checkout --detach abc1234");
    expect(brief).toContain('CSV-1 · "Order rows"');
    expect(brief).toContain("1. WHEN an order is mapped THE SYSTEM SHALL return one row");
    expect(brief).toContain('- "Every public function has a test"');
    expect(brief).toContain("Outside the ticket's scope");
    expect(brief).toContain("docs/x.md");
    expect(brief).toContain("pass npm test (exit 0");
    expect(brief).toContain(" src/a.ts | 2 +-");
    expect(brief).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(brief).not.toContain("Earlier rounds");
  });

  it("states the rules in full", async () => {
    const { project, spec, ticket } = await readyTicket();
    const brief = reviewerBrief({ project, spec, ticket, round: 2, diff: { stat: "", patch: "", truncated: false }, checkPost: null, earlierReviews: [] });
    expect(brief).toContain(
      "read and run anything, change nothing, commit nothing; judge each acceptance criterion; approve only when every one holds and no blocking finding remains; call exactly one verdict tool, then end your turn",
    );
    expect(brief).toContain("loom_approve");
    expect(brief).toContain("loom_request_changes");
    expect(brief).toContain("- none");
  });

  it("clips the patch at 60,000 characters and says so, and carries the findings of earlier rounds", async () => {
    const { project, spec, ticket } = await readyTicket();
    const earlier: ReviewRow[] = [
      { id: 1, ticket_id: ticket.id, round: 1, thread_row_id: 2, verdict: "changes_requested", summary: "Needs a fix", findings_json: JSON.stringify(findings), at: 0 },
      { id: 2, ticket_id: ticket.id, round: 1, thread_row_id: 3, verdict: "approved", summary: "Looks fine", findings_json: "[]", at: 0 },
    ];
    const brief = reviewerBrief({ project, spec, ticket, round: 2, diff: { stat: " big | 9 +", patch: "p".repeat(70_000), truncated: true }, checkPost: checkPost(), earlierReviews: earlier });
    expect(brief).not.toContain("p".repeat(60_001));
    expect(brief).toContain("clipped");
    expect(brief).toContain("Earlier rounds");
    expect(brief).toContain("Round 1 · changes requested: Needs a fix");
    expect(brief).toContain("1. [blocking] Off by one (src/model/a.ts:12)");
    expect(brief).toContain("Round 1 · approved: Looks fine");
  });

  it("names the ticket's repo, its bb project and that repo's checks on a multi-repo project", async () => {
    const project = await seedRepoProject(h);
    const spec = specOf(h.store, project);
    const brief = (key: string) => reviewerBrief({ project, spec, ticket: ticketOf(h, key), round: 1, diff: { stat: "", patch: "", truncated: false }, checkPost: null, earlierReviews: [] });
    expect(brief("CSV-1")).toContain(
      [
        "## Repository",
        'This ticket is in the repo "web", the bb project proj_web, and this worktree is a checkout of it. The changes, the scope report and the check results below are about this repo only.',
        "The checks of this repo, which ran after the ticket's verify commands:",
        '- "npm run web-test"',
        "",
        "## Rubric",
      ].join("\n"),
    );
    expect(brief("CSV-1")).not.toContain('"npm test"');
    expect(brief("CSV-2")).toContain('This ticket is in the repo "api", the bb project proj_api,');
    expect(brief("CSV-2")).toContain("which ran after the ticket's verify commands:\n- \"npm test\"\n");
  });

  it("has no repository section on a single-repo project", async () => {
    const { project, spec, ticket } = await readyTicket();
    const brief = reviewerBrief({ project, spec, ticket, round: 1, diff: { stat: "", patch: "", truncated: false }, checkPost: null, earlierReviews: [] });
    expect(brief).not.toContain("## Repository");
    expect(brief).toContain("1. WHEN an order is mapped THE SYSTEM SHALL return one row\n\n## Rubric");
  });
});

describe("review and merge texts", () => {
  it("changesRequestedText puts the numbered findings in the agent-only detail", () => {
    const text = changesRequestedText("CSV-1", 2, "Needs a fix", findings);
    expect(text.summary).toBe("[loom] CSV-1: review round 2 asked for changes (2 findings). Fix them and call loom_submit again.");
    expect(text.detail).toContain("Needs a fix");
    expect(text.detail).toContain("1. [blocking] Off by one (src/model/a.ts:12)\n   The loop skips the last order.");
    expect(text.detail).toContain("2. [should-fix] Name is unclear\n   Rename `m` to `mapper`.");
  });

  it("conflictText names the branch and every conflicting file", () => {
    const text = conflictText("CSV-2", "loom/csv", ["src/a.ts", "src/b.ts"]);
    expect(text.summary).toContain("[loom] CSV-2");
    expect(text.summary).toContain("loom/csv");
    expect(text.detail).toContain("- src/a.ts\n- src/b.ts");
    expect(text.detail).toContain("git merge loom/csv");
    expect(text.detail).toContain("loom_submit");
  });

  it("afterMergeFailedText names the command, how it failed and the output tail", () => {
    const text = afterMergeFailedText("CSV-1", { command: "npm run e2e", exitCode: 2, timedOut: false, durationMs: 5, output: `${"x".repeat(5000)}\nFAILED e2e` });
    expect(text.summary).toContain('"npm run e2e" exited with 2');
    expect(text.summary).toContain("rolled back");
    expect(text.detail.endsWith("FAILED e2e")).toBe(true);
    expect(text.detail.length).toBeLessThan(4300);
    expect(afterMergeFailedText("CSV-1", { command: "c", exitCode: null, timedOut: true, durationMs: 5, output: "" }).summary).toContain("timed out");
  });

  it("prBody carries the ticket body, the numbered criteria and the review summaries", async () => {
    const { ticket } = await readyTicket();
    const approvals: ReviewRow[] = [{ id: 1, ticket_id: ticket.id, round: 1, thread_row_id: 2, verdict: "approved", summary: "All criteria hold.", findings_json: "[]", at: 0 }];
    const body = prBody({ ticket, approvals });
    expect(body).toContain("Build the row mapper.");
    expect(body).toContain("1. WHEN an order is mapped THE SYSTEM SHALL return one row");
    expect(body).toContain("All criteria hold.");
    expect(body).toContain("CSV-1");
  });

  it("landBody carries the goal and one line per done ticket", async () => {
    const { project, spec } = await readyTicket();
    const body = landBody({ project, spec, done: [ticketOf(h, "CSV-1"), ticketOf(h, "CSV-2")] });
    expect(body).toContain("Let people export their orders as a CSV file");
    expect(body).toContain("- CSV-1 Order rows\n- CSV-2 Export endpoint");
  });

  it("reviewerNudgeText asks for exactly one verdict", () => {
    expect(reviewerNudgeText("CSV-1", 1)).toMatch(/CSV-1.*without a verdict.*loom_approve.*loom_request_changes/s);
  });
});

// ---------------------------------------------------------------- reviewers

const project = () => h.store.projectBySlug("csv")!;
const reviewers = (key = "CSV-1") => h.store.threads({ ticketId: ticketOf(h, key).id, role: "reviewer" });
const reviewsOf = (key = "CSV-1", round?: number) => h.store.reviews(ticketOf(h, key).id, round);
const spawn = () => spawnReviewers(h.ctx, project(), specOf(h.store, project()));
const spawnArgs = (n: number) => h.bb.callsTo("spawnThread")[n]![0] as SpawnArgs;
const postsOf = (key = "CSV-1") => h.store.posts(ticketOf(h, key).id);
const archived = () => h.bb.callsTo("archive").map(([id]) => id);

async function resubmit(worker: ThreadRow) {
  h.host.worktree(`/wt/${worker.environment_id}`).dirty = true;
  submit(h.ctx, worker.thread_id!, "Again");
  await settleChecks(h.ctx);
}

/** The reviewer of CSV-1 whose worktree is on the reviewed commit, so its verdict tools accept it. */
async function reviewerReady(edit?: (doc: Doc) => void) {
  await seedProject(h, edit);
  const worker = await reachReview(h);
  await spawn();
  const [reviewer] = reviewers();
  checkOutHead(h, reviewer!);
  return { worker, reviewer: reviewer! };
}

describe("spawnReviewers", () => {
  it("starts `approvals` reviewers with their own review rows, on agents.reviewer's model, from the ticket's branch", async () => {
    await seedProject(h, (doc) => (doc.review = { approvals: 2 }));
    await reachReview(h);
    expect(await spawn()).toBe(2);
    const ticket = ticketOf(h, "CSV-1");
    const [first, second] = reviewers();
    expect(spawnArgs(1)).toMatchObject({
      bbProjectId: "proj_1",
      hostId: "host_1",
      baseBranch: ticket.branch,
      title: "Review CSV-1 · round 1",
      sectionId: "sec_1",
      providerId: "codex",
      model: "gpt",
      permissionMode: "full",
      metadata: { project: "csv", role: "reviewer", ticket: "CSV-1", round: "1", spawnToken: first!.spawn_token },
    });
    expect(spawnArgs(2).metadata).toMatchObject({ role: "reviewer", round: "1", spawnToken: second!.spawn_token });
    expect(spawnArgs(1).prompt).toContain("You are a Loom reviewer for CSV-1, round 1");
    expect(spawnArgs(1).prompt).toContain("git checkout --detach c1");
    expect(spawnArgs(1).prompt).toContain("src/a.ts | 2 +-");
    expect(spawnArgs(1).prompt).toContain("npm test (exit 0");
    expect(h.host.callsTo("diff")).toEqual([{ repo: "/repo", base: "loom/csv", head: "c1", maxBytes: 60_000 }]);
    expect([first, second]).toMatchObject([
      { role: "reviewer", state: "active", review_round: 1, thread_id: "thr_w2" },
      { role: "reviewer", state: "active", review_round: 1, thread_id: "thr_w3" },
    ]);
    expect(reviewsOf().map((review) => [review.round, review.verdict, review.thread_row_id])).toEqual([
      [1, "pending", first!.id],
      [1, "pending", second!.id],
    ]);
    expect(await spawn()).toBe(0);
    expect(reviewers()).toHaveLength(2);
  });

  it("reserves the row and the review before it calls bb", async () => {
    await seedProject(h);
    await reachReview(h);
    let during: unknown;
    h.bb.spawnError = (args) => {
      const row = h.store.threadBySpawnToken(args.metadata.spawnToken!);
      during = { state: row?.state, thread: row?.thread_id, reviews: reviewsOf().map((review) => review.thread_row_id === row?.id) };
      return null;
    };
    await spawn();
    expect(during).toEqual({ state: "spawning", thread: null, reviews: [true] });
  });

  it("never runs more than max_reviewers at once across the project, and starts the rest as slots free up", async () => {
    await seedProject(h, (doc) => {
      withDocsTicket(doc);
      doc.agents.max_reviewers = 1;
    });
    await reachReview(h, "CSV-1");
    await reachReview(h, "CSV-3");
    expect(await spawn()).toBe(1);
    expect(reviewers("CSV-1")).toHaveLength(1);
    expect(reviewers("CSV-3")).toHaveLength(0);
    expect(await spawn()).toBe(0);

    checkOutHead(h, reviewers("CSV-1")[0]!);
    await approve(h.ctx, "thr_w3", "Fine");
    await settleReviews(h.ctx);
    expect(await spawn()).toBe(1);
    expect(reviewers("CSV-3")).toHaveLength(1);
  });

  it("starts nothing for a project that is not running", async () => {
    await seedProject(h);
    await reachReview(h);
    h.store.setProjectState(project().id, "paused", "human");
    expect(await spawn()).toBe(0);
    expect(h.bb.callsTo("spawnThread")).toHaveLength(1);
  });

  it("ends only the row when a spawn fails, leaves the review pending, and blocks the ticket after approvals + 2 reviewers ended without a verdict", async () => {
    await seedProject(h);
    const worker = await reachReview(h);
    h.bb.spawnError = (args) => (args.metadata.role === "reviewer" ? new Error("provider is down") : null);
    for (let attempt = 0; attempt < 3; attempt++) expect(await spawn()).toBe(0);
    expect(reviewers().map((row) => [row.state, row.end_reason])).toEqual([["ended", "failed"], ["ended", "failed"], ["ended", "failed"]]);
    expect(reviewsOf().every((review) => review.verdict === "pending")).toBe(true);
    expect(ticketOf(h, "CSV-1").state).toBe("review");
    expect(postsOf().some((post) => post.kind === "system" && post.body.includes("provider is down"))).toBe(true);

    await spawn();
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", blocked_reason: "reviewers ended without a verdict", worker_thread_id: null });
    expect(h.store.thread(worker.id)).toMatchObject({ state: "ended", end_reason: "blocked" });
    expect(project().triage_pending).toBe(1);
    expect(postsOf().at(-1)).toMatchObject({ kind: "block", body: "reviewers ended without a verdict" });
  });

  it("blocks the ticket at once, ending its worker, when bb refuses a reviewer", async () => {
    await seedProject(h, (doc) => (doc.review = { approvals: 2 }));
    const worker = await reachReview(h);
    h.bb.spawnError = (args) => (args.metadata.role === "reviewer" ? new SpawnRefusedError(400, "HTTP 400: Provider pi only supports full permission mode.") : null);
    expect(await spawn()).toBe(0);
    expect(h.bb.callsTo("spawnThread").filter(([args]) => (args as SpawnArgs).metadata.role === "reviewer")).toHaveLength(1);
    const reason = "bb refused to start a reviewer: HTTP 400: Provider pi only supports full permission mode.";
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", blocked_reason: reason, worker_thread_id: null });
    expect(h.store.thread(worker.id)).toMatchObject({ state: "ended", end_reason: "blocked" });
    expect(postsOf().at(-1)).toMatchObject({ kind: "block", body: reason });
    expect(project().triage_pending).toBe(1);
  });

  it("pauses the project, with the reason, when the diff cannot be read", async () => {
    await seedProject(h);
    await reachReview(h);
    h.host.scripted.diff = [new Error("host disconnected")];
    expect(await spawn()).toBe(0);
    expect(project()).toMatchObject({ state: "paused", system_reason: expect.stringContaining("Could not read the diff of CSV-1 for review: host disconnected") });
    expect(reviewers()).toHaveLength(0);
  });

  it("pauses the project, naming its repository and the command that clones it, when the bb project has no checkout on the machine", async () => {
    await seedProject(h);
    await reachReview(h);
    h.bb.checkout = null;
    expect(await spawn()).toBe(0);
    expect(project()).toMatchObject({
      state: "paused",
      system_reason:
        "Could not read the diff of CSV-1 for review: The project's repository (bb project proj_1) has no checkout on the machine host_1 that this Loom project uses. Clone it there with `bb project source add proj_1 --clone --machine host_1`, then resume.",
    });
    expect(h.host.callsTo("diff")).toEqual([]);
  });

  it("reads the diff against the remote base, and starts a reviewer without a branch from it, on the pr strategy", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr" }));
    await reachReview(h);
    h.store.updateTicket(ticketOf(h, "CSV-1").id, { branch: null });
    expect(await spawn()).toBe(1);
    expect(h.host.callsTo("diff")).toEqual([{ repo: "/repo", base: "origin/main", head: "c1", maxBytes: 60_000 }]);
    expect(spawnArgs(1)).toMatchObject({ bbProjectId: "proj_1", hostId: "host_1", baseBranch: "origin/main" });
  });

  it("ends active reviewers of a round that is over, and starts reviewers for the new round", async () => {
    await seedProject(h, (doc) => (doc.review = { approvals: 2 }));
    const worker = await reachReview(h);
    await spawn();
    const old = reviewers();
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "working", "loom");
    await resubmit(worker);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "review", review_round: 2 });

    expect(await spawn()).toBe(2);
    expect(old.map((row) => h.store.thread(row.id)!.end_reason)).toEqual(["superseded", "superseded"]);
    expect(archived()).toEqual(expect.arrayContaining(["thr_w2", "thr_w3"]));
    expect(reviewsOf("CSV-1", 2)).toHaveLength(2);
    expect(reviewsOf("CSV-1", 1).every((review) => review.verdict === "pending")).toBe(true);
    expect(spawnArgs(3).metadata.round).toBe("2");
  });
});

describe("reviewers on a multi-repo project", () => {
  it("reads the diff from the ticket's repo checkout and starts the reviewers in that repo's bb project, from the ticket's branch", async () => {
    await seedRepoProject(h);
    await reachReview(h, "CSV-1");
    expect(await spawn()).toBe(1);
    expect(h.bb.callsTo("projectCheckout").at(-1)).toEqual(["proj_web", "host_1"]);
    expect(h.host.calls.filter((call) => call.method === "diff")).toEqual([{ hostId: "host_1", method: "diff", input: { repo: "/src/web", base: "loom/csv", head: "c1", maxBytes: 60_000 } }]);
    expect(spawnArgs(1)).toMatchObject({ bbProjectId: "proj_web", hostId: "host_1", baseBranch: ticketOf(h, "CSV-1").branch, metadata: { role: "reviewer", ticket: "CSV-1" } });
    expect(spawnArgs(1).prompt).toContain('This ticket is in the repo "web", the bb project proj_web,');
  });

  it("uses the repo's remote base for the diff, for a reviewer without a branch and for the verdict's worktree check, on the pr strategy", async () => {
    await seedRepoProject(h, (doc) => (doc.merge = { strategy: "pr" }));
    await reachReview(h, "CSV-2");
    h.store.updateTicket(ticketOf(h, "CSV-2").id, { branch: null });
    expect(await spawn()).toBe(1);
    expect(h.host.callsTo("diff")).toEqual([{ repo: "/src/api", base: "upstream/trunk", head: "c1", maxBytes: 60_000 }]);
    expect(spawnArgs(1)).toMatchObject({ bbProjectId: "proj_api", hostId: "host_1", baseBranch: "upstream/trunk" });

    const reviewer = reviewers("CSV-2")[0]!;
    checkOutHead(h, reviewer);
    await approve(h.ctx, reviewer.thread_id!, "ok");
    expect(h.host.callsTo("worktreeState").at(-1)).toEqual({ worktree: `/wt/${reviewer.environment_id}`, base: "upstream/trunk" });
    expect(reviewsOf("CSV-2")[0]!.verdict).toBe("approved");
  });

  it("pauses the project, naming the repo and the command that clones it, when the ticket's repo has no checkout on the project's machine", async () => {
    await seedRepoProject(h);
    await reachReview(h, "CSV-1");
    h.bb.checkouts.set("proj_web", {});
    expect(await spawn()).toBe(0);
    expect(project()).toMatchObject({
      state: "paused",
      system_reason:
        'Could not read the diff of CSV-1 for review: Repo "web" (bb project proj_web) has no checkout on the machine host_1 that this Loom project uses. Clone it there with `bb project source add proj_web --clone --machine host_1`, then resume.',
    });
    expect(h.host.callsTo("diff")).toEqual([]);
    expect(reviewers()).toHaveLength(0);
  });
});

describe("verdicts", () => {
  const findings: Finding[] = [
    { severity: "blocking", title: "Off by one", detail: "The loop skips the last order.", file: "src/model/a.ts", line: 12 },
    { severity: "should-fix", title: "Name is unclear", detail: "Rename m." },
  ];

  it("approving at the required count moves the ticket to approved, stores the review post and ends the reviewer", async () => {
    const { reviewer } = await reviewerReady();
    const reply = await approve(h.ctx, reviewer.thread_id!, " All criteria hold. ");
    expect(reply).toContain("CSV-1");
    await settleReviews(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("approved");
    expect(reviewsOf()[0]).toMatchObject({ verdict: "approved", summary: "All criteria hold." });
    expect(postsOf().at(-1)).toMatchObject({ kind: "review", author_kind: "reviewer", author_thread_id: reviewer.thread_id, body: "Approved (round 1): All criteria hold." });
    expect(h.store.thread(reviewer.id)).toMatchObject({ state: "ended", end_reason: "verdict" });
    expect(archived()).toContain(reviewer.thread_id);
    const move = h.store.ticketEvents(ticketOf(h, "CSV-1").id, ["ticket.state"]).at(-1)!;
    expect(JSON.parse(move.data_json)).toMatchObject({ from: "review", to: "approved", round: 1, approvals: 1 });
  });

  it("waits for every required approval", async () => {
    const { reviewer } = await reviewerReady((doc) => (doc.review = { approvals: 2 }));
    const second = reviewers()[1]!;
    checkOutHead(h, second);
    await approve(h.ctx, reviewer.thread_id!, "One");
    await settleReviews(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("review");
    expect(await spawn()).toBe(0);
    await approve(h.ctx, second.thread_id!, "Two");
    await settleReviews(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("approved");
  });

  it("sends requested changes to the live worker with the findings, and restarts the worker's clock", async () => {
    const { worker, reviewer } = await reviewerReady();
    h.clock.advance(10 * 60_000);
    await requestChanges(h.ctx, reviewer.thread_id!, "Two things to fix", findings);
    await settleReviews(h.ctx);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", worker_thread_id: worker.thread_id });
    expect(h.store.thread(worker.id)).toMatchObject({ clock_at: h.clock.t, idle_count: 0, state: "active" });
    const sent = h.bb.callsTo("send").filter(([id]) => id === worker.thread_id).at(-1)![1] as { summary: string; detail: string };
    expect(sent.summary).toBe("[loom] CSV-1: review round 1 asked for changes (2 findings). Fix them and call loom_submit again.");
    expect(sent.detail).toContain("Two things to fix");
    expect(sent.detail).toContain("1. [blocking] Off by one (src/model/a.ts:12)");
    const post = postsOf().at(-1)!;
    expect(post).toMatchObject({ kind: "review", author_kind: "reviewer" });
    expect(post.body).toContain("Changes requested (round 1): Two things to fix");
    expect(post.body).toContain("2. [should-fix] Name is unclear\n   Rename m.");
    expect(JSON.parse(post.data_json)).toMatchObject({ round: 1, verdict: "changes_requested", findings });
    expect(h.store.thread(reviewer.id)).toMatchObject({ state: "ended", end_reason: "verdict" });
  });

  it("stops and archives the other reviewers of a round that one reviewer decided", async () => {
    const { reviewer } = await reviewerReady((doc) => (doc.review = { approvals: 2 }));
    const other = reviewers()[1]!;
    await requestChanges(h.ctx, reviewer.thread_id!, "No", findings);
    await settleReviews(h.ctx);
    expect(h.store.thread(other.id)).toMatchObject({ state: "ended", end_reason: "superseded" });
    expect(h.bb.callsTo("stop").map(([id]) => id)).toContain(other.thread_id);
    expect(archived()).toContain(other.thread_id);
  });

  it("does not message a worker while the project is paused, and the held findings reach it on resume", async () => {
    const { worker, reviewer } = await reviewerReady();
    h.store.setProjectState(project().id, "paused", "human");
    await requestChanges(h.ctx, reviewer.thread_id!, "Fix it", findings);
    await settleReviews(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("working");
    expect(h.bb.sent(worker.thread_id!).filter((text) => text.includes("asked for changes"))).toEqual([]);
    expect(heldCheckResult(postsOf())).toMatchObject({ kind: "review" });
  });

  it("puts the ticket back in the queue when the worker is gone, and the next brief carries the review", async () => {
    const { worker, reviewer } = await reviewerReady();
    await endThread(h.ctx, worker, "gone", { commit: false });
    expect(ticketOf(h, "CSV-1").state).toBe("review");
    await requestChanges(h.ctx, reviewer.thread_id!, "Fix it", findings);
    await settleReviews(h.ctx);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "queued", worker_thread_id: null, environment_id: null });
    expect(h.bb.sent(worker.thread_id!).filter((text) => text.includes("asked for changes"))).toEqual([]);

    await startWorker(h);
    expect(h.bb.callsTo("spawnThread").at(-1)![0]).toMatchObject({ prompt: expect.stringContaining("Changes requested (round 1): Fix it") });
  });

  it("blocks the ticket when changes were requested in max_rounds rounds, and ends the worker", async () => {
    const { worker, reviewer } = await reviewerReady((doc) => (doc.review = { max_rounds: 1 }));
    await requestChanges(h.ctx, reviewer.thread_id!, "Fix it", findings);
    await settleReviews(h.ctx);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", blocked_reason: "review requested changes in 1 round", worker_thread_id: null, environment_id: null });
    expect(h.store.thread(worker.id)).toMatchObject({ state: "ended", end_reason: "blocked" });
    expect(archived()).toContain(worker.thread_id);
    expect(project().triage_pending).toBe(1);
    expect(postsOf().at(-1)).toMatchObject({ kind: "block", author_kind: "loom", body: "review requested changes in 1 round" });
  });

  it("gives a requeued ticket max_rounds fresh rounds, and never reuses an old review row", async () => {
    await seedProject(h, (doc) => (doc.review = { max_rounds: 2 }));
    let worker = await reachReview(h);
    const roundVerdict = async () => {
      await spawn();
      const reviewer = reviewers().at(-1)!;
      checkOutHead(h, reviewer);
      await requestChanges(h.ctx, reviewer.thread_id!, "Fix it", findings);
      await settleReviews(h.ctx);
    };
    await roundVerdict();
    expect(ticketOf(h, "CSV-1").state).toBe("working");
    await resubmit(worker);
    expect(ticketOf(h, "CSV-1").review_round).toBe(2);
    await roundVerdict();
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", blocked_reason: "review requested changes in 2 rounds" });

    await requeueTicket(h.ctx, "CSV-1", { note: "Try again", actor: "human", author: "human" });
    worker = await reachReview(h);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "review", review_round: 3 });
    await roundVerdict();
    expect(ticketOf(h, "CSV-1").state).toBe("working");
    expect(reviewsOf().map((review) => [review.round, review.verdict])).toEqual([[1, "changes_requested"], [2, "changes_requested"], [3, "changes_requested"]]);
    expect(worker.thread_id).not.toBe("thr_w1");
  });

  it("lets two reviewers who answer at once decide the round once", async () => {
    const { worker } = await reviewerReady((doc) => (doc.review = { approvals: 2 }));
    const [first, second] = reviewers();
    checkOutHead(h, second!);
    const results = await Promise.allSettled([requestChanges(h.ctx, first!.thread_id!, "No", findings), requestChanges(h.ctx, second!.thread_id!, "Also no", findings)]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason.message).toMatch(/review round is over/);
    await settleReviews(h.ctx);
    expect(reviewsOf().filter((review) => review.verdict === "changes_requested")).toHaveLength(1);
    expect(h.store.events(project().id).filter((event) => event.kind === "review.verdict")).toHaveLength(1);
    expect(h.bb.sent(worker.thread_id!).filter((text) => text.includes("asked for changes"))).toHaveLength(1);
    expect(ticketOf(h, "CSV-1").state).toBe("working");
  });

  it("refuses a second verdict on a round that is decided but still waiting for its outcome", async () => {
    const { worker } = await reviewerReady((doc) => (doc.review = { approvals: 2 }));
    const [first, second] = reviewers();
    checkOutHead(h, second!);
    h.store.claimThread(worker.id, "gone");
    const results = await Promise.allSettled([requestChanges(h.ctx, first!.thread_id!, "No", findings), approve(h.ctx, second!.thread_id!, "Yes")]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason.message).toMatch(/already decided|has ended/);
    expect(ticketOf(h, "CSV-1").state).toBe("review");
    expect(reviewsOf().map((review) => review.verdict)).toEqual(["changes_requested", "pending"]);
  });

  it("refuses a worker, an unknown thread, an empty summary and a reviewer that already answered", async () => {
    const { worker, reviewer } = await reviewerReady();
    await expect(approve(h.ctx, worker.thread_id!, "I approve my own work")).rejects.toThrow(/Loom reviewer/);
    await expect(requestChanges(h.ctx, worker.thread_id!, "x", findings)).rejects.toThrow(/Loom reviewer/);
    await expect(approve(h.ctx, "thr_nobody", "x")).rejects.toThrow(/Loom reviewer/);
    await expect(approve(h.ctx, reviewer.thread_id!, "   ")).rejects.toThrow(/summary is empty/);
    await expect(requestChanges(h.ctx, reviewer.thread_id!, "x", [])).rejects.toThrow(/finding/);
    expect(ticketOf(h, "CSV-1").state).toBe("review");
    await approve(h.ctx, reviewer.thread_id!, "ok");
    await expect(approve(h.ctx, reviewer.thread_id!, "again")).rejects.toThrow();
    expect(reviewsOf()).toHaveLength(1);
  });

  it("refuses a reviewer of another round", async () => {
    const { worker, reviewer } = await reviewerReady();
    h.store.setTicketState(ticketOf(h, "CSV-1").id, "working", "loom");
    await resubmit(worker);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "review", review_round: 2 });
    await expect(approve(h.ctx, reviewer.thread_id!, "ok")).rejects.toThrow(/review round is over/);
    expect(reviewsOf("CSV-1", 1)[0]!.verdict).toBe("pending");
    expect(ticketOf(h, "CSV-1").state).toBe("review");
  });

  it("keeps a reviewer to its own ticket, and refuses one whose ticket is no longer in review", async () => {
    await seedProject(h, withDocsTicket);
    await reachReview(h, "CSV-1");
    await reachReview(h, "CSV-3");
    await spawn();
    const [one] = reviewers("CSV-1");
    const [three] = reviewers("CSV-3");
    checkOutHead(h, one!);
    checkOutHead(h, three!);

    await approve(h.ctx, three!.thread_id!, "ok");
    await settleReviews(h.ctx);
    expect(ticketOf(h, "CSV-3").state).toBe("approved");
    expect(ticketOf(h, "CSV-1").state).toBe("review");
    expect(reviewsOf("CSV-1")[0]!.verdict).toBe("pending");

    h.store.setTicketState(ticketOf(h, "CSV-1").id, "working", "loom");
    await expect(approve(h.ctx, one!.thread_id!, "ok")).rejects.toThrow(/review round is over/);
  });

  it("refuses a verdict until the reviewer's worktree is on head_sha, then accepts it", async () => {
    await seedProject(h);
    await reachReview(h);
    await spawn();
    const reviewer = reviewers()[0]!;
    await expect(approve(h.ctx, reviewer.thread_id!, "ok")).rejects.toThrow("Check out c1 first, then review again.");
    await expect(requestChanges(h.ctx, reviewer.thread_id!, "no", findings)).rejects.toThrow("Check out c1 first, then review again.");
    expect(reviewsOf()[0]!.verdict).toBe("pending");
    expect(h.host.callsTo("worktreeState").at(-1)).toEqual({ worktree: `/wt/${reviewer.environment_id}`, base: "loom/csv" });

    checkOutHead(h, reviewer);
    await approve(h.ctx, reviewer.thread_id!, "ok");
    expect(reviewsOf()[0]!.verdict).toBe("approved");
  });

  it("tells the reviewer when its worktree cannot be read", async () => {
    const { reviewer } = await reviewerReady();
    h.host.scripted.worktreeState = [new Error("host disconnected")];
    await expect(approve(h.ctx, reviewer.thread_id!, "ok")).rejects.toThrow(/Could not read your worktree: host disconnected/);
    expect(reviewsOf()[0]!.verdict).toBe("pending");
  });
});

describe("the tick re-evaluates a round that already has its verdicts", () => {
  it("moves a ticket in review to approved when the approvals are in", async () => {
    await seedProject(h);
    await reachReview(h);
    await spawn();
    h.store.setVerdict(reviewsOf()[0]!.id, "approved", "ok", []);
    expect(ticketOf(h, "CSV-1").state).toBe("review");
    await spawn();
    expect(ticketOf(h, "CSV-1").state).toBe("approved");
    expect(h.store.thread(reviewers()[0]!.id)).toMatchObject({ state: "ended", end_reason: "verdict" });
  });

  it("sends the findings to the worker when a changes-requested verdict has no outcome yet", async () => {
    await seedProject(h);
    const worker = await reachReview(h);
    await spawn();
    h.store.setVerdict(reviewsOf()[0]!.id, "changes_requested", "Fix it", [{ severity: "blocking", title: "Bug", detail: "It breaks." }]);
    await spawn();
    expect(ticketOf(h, "CSV-1").state).toBe("working");
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("1. [blocking] Bug");
  });

  it("waits while the worker is still ending, then decides", async () => {
    await seedProject(h);
    const worker = await reachReview(h);
    await spawn();
    h.store.setVerdict(reviewsOf()[0]!.id, "changes_requested", "Fix it", [{ severity: "blocking", title: "Bug", detail: "It breaks." }]);
    h.store.claimThread(worker.id, "gone");
    await spawn();
    expect(ticketOf(h, "CSV-1").state).toBe("review");
    h.store.updateThread(worker.id, { state: "ended" });
    await spawn();
    expect(ticketOf(h, "CSV-1").state).toBe("queued");
  });
});

describe("a reviewer that stalls", () => {
  it("is nudged on the first idle and ended on the second, and a replacement starts on the next tick", async () => {
    await seedProject(h);
    await reachReview(h);
    await spawn();
    const row = reviewers()[0]!;
    await onReviewerIdle(h.ctx, row);
    expect(h.bb.sent(row.thread_id!)).toEqual([expect.stringMatching(/CSV-1.*without a verdict.*loom_approve.*loom_request_changes/s)]);
    expect(h.store.thread(row.id)!.idle_count).toBe(1);

    await onReviewerIdle(h.ctx, h.store.thread(row.id)!);
    expect(h.store.thread(row.id)).toMatchObject({ state: "ended", end_reason: "abandoned" });
    expect(archived()).toContain(row.thread_id);
    expect(reviewsOf()[0]!.verdict).toBe("pending");
    expect(await spawn()).toBe(1);
    expect(reviewers()).toHaveLength(2);
  });

  it("blocks the ticket once approvals + 2 reviewers ended without a verdict", async () => {
    await seedProject(h);
    await reachReview(h);
    for (let n = 0; n < 3; n++) {
      expect(await spawn()).toBe(1);
      const row = reviewers().at(-1)!;
      await onReviewerIdle(h.ctx, row);
      await onReviewerIdle(h.ctx, h.store.thread(row.id)!);
    }
    expect(await spawn()).toBe(0);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", blocked_reason: "reviewers ended without a verdict" });
  });

  it("ends a reviewer whose thread was archived or deleted, and leaves its review pending", async () => {
    await seedProject(h);
    await reachReview(h);
    await spawn();
    const row = reviewers()[0]!;
    await onReviewerGone(h.ctx, row);
    expect(h.store.thread(row.id)).toMatchObject({ state: "ended", end_reason: "gone" });
    expect(reviewsOf()[0]!.verdict).toBe("pending");
    expect(await spawn()).toBe(1);
  });

  it("does nothing for an idle reviewer that already answered but still ends it", async () => {
    const { reviewer } = await reviewerReady();
    h.store.setVerdict(reviewsOf()[0]!.id, "approved", "ok", []);
    await onReviewerIdle(h.ctx, reviewer);
    expect(h.bb.sent(reviewer.thread_id!)).toEqual([]);
    expect(h.store.thread(reviewer.id)).toMatchObject({ state: "ended", end_reason: "verdict" });
  });
});
