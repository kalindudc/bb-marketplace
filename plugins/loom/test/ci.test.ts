// Relying on the pull request's CI (checks.ci, a [[repo]]'s ci): what the briefs tell workers and reviewers, and where a
// ticket's CI shows. Fix rounds from failed checks are in pull-requests.test.ts; a stacked dependent following one is in
// stacked-machines.test.ts.
import { beforeEach, describe, expect, it } from "vitest";
import type { BoardCard, ProjectSummary } from "../src/contract";
import { nextStepOf, type NextStepInput } from "../src/next-step";
import { prFeedbackText, reviewerBrief, workerBrief } from "../src/prompts";
import { boardCards } from "../src/rpc";
import { parseSpec } from "../src/spec";
import { card, overview } from "./fixtures";
import { makeCtx, seedProject, specToml, ticketOf, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;
beforeEach(() => {
  h = makeCtx();
});

const spec = (edit: (doc: Doc) => void) => parseSpec(specToml(edit)).spec!;
const pr = (doc: Doc) => (doc.merge = { strategy: "pr" });
const ignored = (doc: Doc) => {
  pr(doc);
  doc.checks = { commands: ["npm test"], ci: false };
};

const RELY_WORKER =
  "These are the cheap checks that run where you are. Every other test of this repository runs in the pull request's CI once Loom opens it, and a check that fails there comes back to you as a fix round. Run what you can here; do not block, fail or loop on a test this environment cannot run, such as one that needs a container runtime, a service that will not start here, or more time than your turn has. Say in your loom_submit summary which tests you did not run, and why.";
const IGNORE_WORKER = "These checks are the whole bar: Loom does not read the pull request's CI for this repository, so run every test the ticket needs here before you submit.";
const RELY_REVIEWER =
  "Those are the plugin's cheap checks. Every other test runs in the pull request's CI once it opens, and a check that fails there goes back to the worker as a fix round. Do not request changes only because a test was not run here; the worker's summary says which it did not run. Request changes when the work lacks a test the ticket needs, or a test you ran shows a problem.";
const IGNORE_REVIEWER = "Loom does not read this repository's CI, so these checks are the whole bar: request changes when the ticket needs a test they do not run.";

describe("the briefs on a repo that relies on CI", () => {
  async function briefs(edit: (doc: Doc) => void) {
    await seedProject(h);
    const project = h.store.projectBySlug("csv")!;
    const ticket = ticketOf(h, "CSV-1");
    const diff = { stat: "", patch: "", truncated: false };
    return {
      worker: workerBrief({ project, spec: spec(edit), ticket, posts: [], resume: false }),
      reviewer: reviewerBrief({ project, spec: spec(edit), ticket, round: 1, diff, checkPost: null, earlierReviews: [], prFeedback: null }),
    };
  }

  it("tells the worker to leave what it cannot run to CI and say so, and the reviewer not to ask for changes for a test not run here", async () => {
    const { worker, reviewer } = await briefs(pr);
    expect(worker).toContain(RELY_WORKER);
    expect(worker).not.toContain(IGNORE_WORKER);
    expect(reviewer).toContain(RELY_REVIEWER);
  });

  it("says the plugin checks are the whole bar when the repo's CI is ignored", async () => {
    const { worker, reviewer } = await briefs(ignored);
    expect(worker).toContain(IGNORE_WORKER);
    expect(worker).not.toContain("pull request's CI once Loom opens it");
    expect(reviewer).toContain(IGNORE_REVIEWER);
  });

  it("says nothing of CI on the integration strategy, which opens no pull request per ticket", async () => {
    const { worker, reviewer } = await briefs(() => undefined);
    for (const text of [RELY_WORKER, IGNORE_WORKER, RELY_REVIEWER, IGNORE_REVIEWER]) {
      expect(worker).not.toContain(text);
      expect(reviewer).not.toContain(text);
    }
  });

  it("tells the worker in a fix round for a failed check that CI may run tests it cannot run here", () => {
    const base = { key: "CSV-1", url: "https://github.com/acme/shop/pull/1", round: 1, counted: 1, max: 5, items: [], diverged: null };
    const line = "These checks ran in the pull request's CI, which may run tests you cannot run here: read each one's log at its link, fix the cause, and say in your loom_submit summary which of those tests you could not run here.";
    expect(prFeedbackText({ ...base, checks: [{ name: "test", url: "https://ci/1" }] }).detail).toContain(line);
    expect(prFeedbackText({ ...base, checks: [], items: [{ kind: "review", author: "alice", body: "Rename it.", url: null, state: "changes_requested", path: null, line: null }] }).detail).not.toContain(line);
  });
});

describe("where a ticket's CI shows", () => {
  const status = (failed: number, pending: number) => JSON.stringify({ at: 1, head: "sq1", passed: 1, failed, pending });

  it("puts the failing and pending checks of an open pull request on its board card when the repo relies on CI", async () => {
    await seedProject(h, pr);
    const project = h.store.projectBySlug("csv")!;
    h.store.updateTicket(ticketOf(h, "CSV-1").id, { state: "pr_open", pr_status_json: status(1, 2) });
    h.store.updateTicket(ticketOf(h, "CSV-2").id, { pr_status_json: status(0, 0) });
    const cards = boardCards(h.store.tickets(project.id), [], spec(pr));
    expect(cards.map((each) => each.ci)).toEqual([{ failed: 1, pending: 2 }, null]);
    expect(boardCards(h.store.tickets(project.id), [], spec(ignored)).map((each) => each.ci)).toEqual([null, null]);
  });

  const input = (board: BoardCard[]): NextStepInput => ({ overview: overview({ state: "running" } as Partial<ProjectSummary>), board, version: 1, maxWorkers: 2, triage: true, startFailed: [], reviewRefused: [] });

  it("names the open pull requests whose CI is failing or pending on the next-step bar while the project runs", () => {
    const board = [
      card({ key: "CSV-1", state: "pr_open", ready: false, ci: { failed: 1, pending: 0 } }),
      card({ key: "CSV-2", state: "pr_open", ready: false, ci: { failed: 0, pending: 2 } }),
      card({ key: "CSV-3", state: "pr_open", ready: false, ci: { failed: 0, pending: 0 } }),
    ];
    expect(nextStepOf(input(board))!.text).toBe(
      "No worker is running now; tickets in checks, review or the merge queue move by themselves. CI on the pull requests: CSV-1 has 1 check failing; CSV-2 has 2 checks pending. Loom sends a failing check back to its worker as a fix round once no pending check holds it. Nothing needs you now; this bar turns yellow when something does.",
    );
    expect(nextStepOf(input([card({ key: "CSV-3", state: "pr_open", ready: false })]))!.text).not.toContain("CI on");
  });
});
