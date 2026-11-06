// Loom's own section of a pull request's description is written for the human reviewer: pull request links and titles,
// what must be in production first, how the change deploys and rolls back; never a ticket key outside a hidden comment,
// and never Loom's own vocabulary. Old blocks are rewritten in the new format at a later read.
import { beforeEach, describe, expect, it } from "vitest";
import { settleChecks, submit } from "../src/checks";
import type { ThreadRow } from "../src/db/store";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { LOOM_BEGIN, LOOM_END, loomBlock, replaceLoomBlock } from "../src/prompts";
import { askForPrTexts, FORMAT_REFRESHES, handInPrText } from "../src/pull-requests";
import { approve, settleReviews, spawnReviewers } from "../src/review";
import { markLiveByHuman } from "../src/rollout-live";
import { specOf } from "../src/ctx";
import { checkOutHead, makeCtx, seedProject, startWorker, ticketOf, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;
beforeEach(() => {
  h = makeCtx();
});

const URL = "https://github.com/acme/shop/pull/1";
const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const ticket = (key = "CSV-1") => ticketOf(h, key);
const outcomes = (outcome: string) => h.store.posts(ticket().id).filter((post) => post.kind === "merge" && (JSON.parse(post.data_json) as { outcome?: string }).outcome === outcome);
const poll = async () => {
  h.clock.advance(5 * 60_000);
  await pollPullRequests(h.ctx, project());
};
const BODY = "## Summary\n\nAdd order rows.";
const OLD_BLOCK = `${LOOM_BEGIN}\nStacked on https://github.com/acme/shop/pull/9 (CSV-9): merge that one first. Loom moves this pull request to main when it merges.\n\nOpened by Loom for CSV-1.\n${LOOM_END}`;

/** The text between Loom's markers, without the hidden comments: what a reviewer reads. */
const visible = (body: string) => body.slice(body.indexOf(LOOM_BEGIN) + LOOM_BEGIN.length, body.indexOf(LOOM_END)).replace(/<!--[\s\S]*?-->/gu, "");
const KEY = /\b[A-Z][A-Z0-9]*-\d+\b/u;

async function handIn(worker: ThreadRow): Promise<void> {
  const worktree = h.host.worktree(`/wt/${worker.environment_id}`);
  worktree.dirty = true;
  worktree.changed = ["src/model/a.ts"];
  submit(h.ctx, worker.thread_id!, "Done.", { title: "Add order rows", body: BODY });
  await settleChecks(h.ctx);
  await spawnReviewers(h.ctx, project(), spec());
  const reviewer = h.store.threads({ ticketId: ticket().id, role: "reviewer" }).at(-1)!;
  checkOutHead(h, reviewer);
  await approve(h.ctx, reviewer.thread_id!, "Every criterion holds.");
  await settleReviews(h.ctx);
  await askForPrTexts(h.ctx, project(), spec());
  handInPrText(h.ctx, worker.thread_id!, { commit_message: "Add the order row mapper" });
  await runMergeQueue(h.ctx, project(), spec());
  await settleMerges(h.ctx);
  expect(ticket().state).toBe("pr_open");
}

describe("Loom's section of a pull request's description", () => {
  it("is a hidden comment only when there is nothing to say, with the ticket key nowhere a reviewer reads", () => {
    expect(loomBlock("CSV-1")).toBe(`${LOOM_BEGIN}\n<!-- loom:ticket CSV-1 -->\n${LOOM_END}`);
    expect(visible(loomBlock("CSV-1")).trim()).toBe("");
  });

  it("names prerequisites by pull request link and title, says what is in production, and how it deploys and rolls back", async () => {
    await seedProject(h, (doc) => {
      doc.merge = { strategy: "pr" };
      doc.rollout = { milestone: [{ ref: "traffic-low", title: "Old traffic is near zero" }] };
      doc.ticket[0].depends_on = [];
      doc.ticket[0].merge_after = ["csv-export"];
      doc.ticket[0].rollout = { requires_live: ["traffic-low", "csv-export"], how: "The shop pipeline deploys main to canary, then production.", rollback: "Revert the commit and redeploy.", dark: true };
      doc.ticket[1].depends_on = [];
    });
    const worker = await startWorker(h);
    await handIn(worker);
    const body = h.host.callsTo("prCreate")[0]!.body;
    expect(body.startsWith(`${BODY}\n\n${LOOM_BEGIN}\n`)).toBe(true);
    const shown = visible(body);
    expect(shown.trim()).toBe(
      [
        "## Merge and deploy order",
        `- Merge after "${ticket("CSV-2").title}" (pull request not open yet).`,
        "- Needs in production first:",
        "  - Old traffic is near zero: not yet.",
        `  - "${ticket("CSV-2").title}" (pull request not open yet): not deployed yet.`,
        "- How this deploys: The shop pipeline deploys main to canary, then production. Merging does not deploy it.",
        "- Ships dark: its feature gate starts off.",
        "- Rollback: Revert the commit and redeploy.",
      ].join("\n"),
    );
    expect(shown).not.toMatch(KEY);
    expect(shown).not.toMatch(/\bLoom\b|\bstage\b|\badvice\b|the human|Opened by/iu);
    expect(shown).not.toContain("csv-export");
    expect(body).toContain("<!-- loom:ticket CSV-1 -->");
  });

  it("links a prerequisite once its pull request is open, and says it is deployed once it is live", async () => {
    await seedProject(h, (doc) => {
      doc.merge = { strategy: "pr" };
      doc.ticket[0].depends_on = [];
      doc.ticket[0].rollout = { requires_live: ["csv-export"] };
      doc.ticket[1].depends_on = [];
    });
    h.store.updateTicket(ticket("CSV-2").id, { state: "done", pr_url: "https://github.com/acme/shop/pull/7" });
    markLiveByHuman(h.ctx, "csv", "CSV-2", {}, "human");
    const worker = await startWorker(h);
    await handIn(worker);
    const shown = visible(h.host.callsTo("prCreate")[0]!.body);
    expect(shown).toContain(`  - https://github.com/acme/shop/pull/7 (${ticket("CSV-2").title}): deployed.`);
    expect(shown).not.toMatch(KEY);
  });

  it("replaces an old block, with the markers it always had, and only what lies between them", () => {
    const body = `Why.\n\n${OLD_BLOCK}\n\nA footer someone added.`;
    const replaced = replaceLoomBlock(body, loomBlock("CSV-1"));
    expect(replaced).toEqual({ body: `Why.\n\n${LOOM_BEGIN}\n<!-- loom:ticket CSV-1 -->\n${LOOM_END}\n\nA footer someone added.` });
  });
});

describe("refreshing an old block in the new format", () => {
  async function openOld(): Promise<void> {
    await seedProject(h, (doc) => void (doc.merge = { strategy: "pr" }));
    const worker = await startWorker(h);
    await handIn(worker);
    // As a pull request Loom opened before this version: the old block, with someone's footer after it.
    h.host.texts.set(URL, { title: "Add order rows", body: `${BODY}\n\n${OLD_BLOCK}\n\nA footer.` });
  }

  it("rewrites the block at the next read, keeping everything outside the markers, once", async () => {
    await openOld();
    await poll();
    expect(h.host.callsTo("prEdit")).toEqual([{ repo: "/repo", url: URL, title: "Add order rows", body: `${BODY}\n\n${loomBlock("CSV-1")}\n\nA footer.`, forge: { kind: "gh" } }]);
    expect(outcomes("pr_block_refreshed")).toHaveLength(1);
    await poll();
    await poll();
    expect(h.host.callsTo("prEdit")).toHaveLength(1);
  });

  it("does not edit a block that is already current, and never again after writing one the forge changed", async () => {
    await openOld();
    h.host.texts.set(URL, { title: "Add order rows", body: `${BODY}\n\n${loomBlock("CSV-1")}` });
    await poll();
    expect(h.host.callsTo("prEdit")).toEqual([]);

    h.host.texts.set(URL, { title: "Add order rows", body: `${BODY}\n\n${OLD_BLOCK}` });
    // Loom already wrote this block once; a forge that rewrites it must not make Loom edit on every read.
    await poll();
    expect(h.host.callsTo("prEdit")).toEqual([]);
  });

  // Tony's review: a read with the body but no title made Loom send the title it last set, over a human's change.
  it("never sends a title it did not just read: a read with no title leaves the block for a later read", async () => {
    await openOld();
    h.host.texts.set(URL, { title: null, body: `${BODY}\n\n${OLD_BLOCK}` });
    await poll();
    expect(h.host.callsTo("prEdit")).toEqual([]);
    h.host.texts.set(URL, { title: "Renamed by a person", body: `${BODY}\n\n${OLD_BLOCK}` });
    await poll();
    expect(h.host.callsTo("prEdit")).toEqual([expect.objectContaining({ title: "Renamed by a person" })]);
  });

  it("leaves a description with no markers alone, saying nothing", async () => {
    await openOld();
    h.host.texts.set(URL, { title: "Add order rows", body: "A description from before Loom's markers." });
    await poll();
    expect(h.host.callsTo("prEdit")).toEqual([]);
    expect(outcomes("rollout_not_refreshed")).toEqual([]);
  });

  it("rewrites at most FORMAT_REFRESHES blocks every ten minutes across every pull request, and the rest at later reads", async () => {
    await seedProject(h, (doc) => {
      doc.merge = { strategy: "pr" };
      doc.ticket[1].depends_on = [];
      for (let index = 0; index < 6; index += 1) doc.ticket.push({ ref: `more-${index}`, title: `More ${index}`, body: "More.", acceptance: ["It holds."], scope: [`src/more${index}/**`] });
    });
    const rows = h.store.tickets(project().id);
    for (const [index, row] of rows.entries()) {
      const url = `https://github.com/acme/shop/pull/${100 + index}`;
      h.store.updateTicket(row.id, { state: "pr_open", pr_url: url, branch: `loom/csv/${index}`, pr_branch: `loom/csv/${index}`, pushed_sha: "a".repeat(40), pushed_at: 0 });
      h.host.texts.set(url, { title: row.title, body: `${BODY}\n\n${OLD_BLOCK}` });
    }
    await poll();
    expect(h.host.callsTo("prEdit")).toHaveLength(FORMAT_REFRESHES);
    await poll();
    expect(h.host.callsTo("prEdit")).toHaveLength(FORMAT_REFRESHES);
    h.clock.advance(10 * 60_000);
    await poll();
    expect(h.host.callsTo("prEdit")).toHaveLength(rows.length);
    expect(new Set(h.host.callsTo("prEdit").map((call) => call.url)).size).toBe(rows.length);
  });
});

describe("the prompts name the pull request description skill", () => {
  it("tells the worker to read it first and leave Loom's section out, and the reviewer to judge the text by it", async () => {
    await seedProject(h, (doc) => void (doc.merge = { strategy: "pr" }));
    const worker = await startWorker(h);
    const brief = h.bb.callsTo("spawnThread").map(([args]) => `${(args as { prompt: string }).prompt}\n${(args as { detail?: string }).detail ?? ""}`).join("\n");
    expect(brief).toContain("Read the loom-pr-description skill first and follow it");
    expect(brief).toContain("Loom adds its own merge and deploy section after your description; do not write one");
    const worktree = h.host.worktree(`/wt/${worker.environment_id}`);
    worktree.dirty = true;
    worktree.changed = ["src/model/a.ts"];
    submit(h.ctx, worker.thread_id!, "Done.", { title: "Add order rows", body: BODY });
    await settleChecks(h.ctx);
    await spawnReviewers(h.ctx, project(), spec());
    const reviewer = h.bb.callsTo("spawnThread").at(-1)!.map((args) => `${(args as { prompt: string }).prompt}\n${(args as { detail?: string }).detail ?? ""}`).join("\n");
    expect(reviewer).toContain("by the rules of the loom-pr-description skill");
    expect(reviewer).toMatch(/request changes with a finding when it names a ticket key/u);
    expect(reviewer).toContain("Loom's vocabulary");
    expect(reviewer).toContain("the agent's machine or sandbox");
  });

  it("asks for the pull request text by the skill in loom_pr, and in a fix round's rules", async () => {
    const { prAskText, prFeedbackText } = await import("../src/prompts");
    for (const asked of [prAskText({ key: "CSV-1", fix: false, round: 0, url: null, limitMinutes: 10 }), prAskText({ key: "CSV-1", fix: true, round: 1, url: URL, limitMinutes: 10 })]) {
      expect(asked.detail).toContain("Read the loom-pr-description skill first and follow it for the title and description");
    }
    const fix = prFeedbackText({ key: "CSV-1", url: URL, round: 1, counted: 1, max: 5, checks: [], items: [], foreign: null });
    expect(fix.detail).toContain("written by the loom-pr-description skill");
  });
});
