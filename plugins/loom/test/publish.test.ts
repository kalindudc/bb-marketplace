// The publish gate: with merge.publish, Loom keeps each pull request a draft and marks it ready itself once it can ship,
// for the commit it pushed: its checks passed and its rollout prerequisites are live. Only then does it ask people to
// review. A held draft is never published.
import { beforeEach, describe, expect, it } from "vitest";
import { specOf } from "../src/ctx";
import type { HostOutput } from "../src/host-contract";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { mergeOrderOf } from "../src/merge-order";
import { publishWaitsOf } from "../src/publish";
import { askForPrTexts, handInPrText } from "../src/pull-requests";
import { markLiveByHuman } from "../src/rollout-live";
import { boardCards } from "../src/rpc";
import { parseSpec } from "../src/spec";
import { makeCtx, reachApproved, seedProject, specToml, ticketOf, type Doc, type EngineHarness } from "./helpers";

type Check = Extract<HostOutput<"prFeedback">, { outcome: "ok" }>["checks"][number];
const URL = "https://github.com/acme/shop/pull/1";
const check = (name: string, state: Check["state"]): Check => ({ key: `check:${name}`, name, state, url: null, started: null, startedAt: null, completedAt: null, progress: null, steps: null });

let h: EngineHarness;
beforeEach(() => {
  h = makeCtx();
});

const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const ticket = () => ticketOf(h, "CSV-1");
const card = () => boardCards(h.store.tickets(project().id), h.store.threadsForProject(project().id), spec(), h.store, h.clock.now()).find((each) => each.key === "CSV-1")!;
const methods = () => h.host.calls.map((call) => call.method).filter((method) => method === "prReady" || method === "prRequestReview");
const poll = async () => {
  h.clock.advance(5 * 60_000);
  await pollPullRequests(h.ctx, project());
};
const checks = (...list: Check[]) => h.host.feedback.set(URL, { head: ticket().pushed_sha!, checks: list });

async function openPr(edit: (doc: Doc) => void = () => undefined): Promise<void> {
  await seedProject(h, (doc) => {
    doc.merge = { strategy: "pr", publish: {}, forge: { kind: "gh", reviewers: [{ users: ["dana"] }] } };
    edit(doc);
  });
  const worker = await reachApproved(h);
  await askForPrTexts(h.ctx, project(), spec());
  handInPrText(h.ctx, worker.thread_id!, { title: "Add order rows", body: "Adds the rows.", commit_message: "Add the order rows" });
  await runMergeQueue(h.ctx, project(), spec());
  await settleMerges(h.ctx);
  expect(ticket()).toMatchObject({ state: "pr_open", pr_url: URL });
}

describe("merge.publish in the spec", () => {
  it("is off when unset, takes the conditions it waits for, and needs drafts, a forge that marks them ready and one that reports checks", () => {
    expect(parseSpec(specToml((doc) => (doc.merge = { strategy: "pr" }))).spec!.merge.publish).toBeUndefined();
    expect(parseSpec(specToml((doc) => (doc.merge = { strategy: "pr", publish: { when: ["live"] } }))).spec!.merge.publish).toEqual({ when: ["live"] });
    expect(parseSpec(specToml((doc) => (doc.merge = { strategy: "pr", publish: {}, draft: false }))).errors).toEqual([expect.stringContaining("merge.publish: Loom publishes a pull request by marking its draft ready, but merge.draft is false")]);
    expect(parseSpec(specToml((doc) => (doc.merge = { strategy: "integration", publish: {} }))).errors).toEqual([expect.stringContaining("merge.publish: it applies to the pull request Loom opens for each ticket")]);
    const noReady = parseSpec(specToml((doc) => (doc.merge = { strategy: "pr", publish: {}, forge: { kind: "command", open: "o", state: "s", feedback: "f" } })));
    expect(noReady.errors).toEqual([expect.stringContaining("merge.forge: merge.publish marks drafts ready, and this forge has no ready command")]);
    const noFeedback = parseSpec(specToml((doc) => {
      doc.merge = { strategy: "pr", publish: { when: ["checks"] }, forge: { kind: "command", open: "o", state: "s", ready: "r" } };
      doc.checks.ci = false;
    }));
    expect(noFeedback.errors).toEqual([expect.stringContaining("merge.forge: merge.publish reads a pull request's draft flag and checks, and this forge has no feedback command")]);
  });
});

describe("publishing a draft", () => {
  it("keeps it a draft while its checks run, says why on the board and the Merge order tab, then marks it ready and only then asks for reviewers", async () => {
    await openPr();
    expect(methods()).toEqual([]);
    checks(check("build", "passed"), check("test", "pending"));
    await poll();
    expect(methods()).toEqual([]);
    expect(card().publishWait).toBe("1 check is still running");
    expect(mergeOrderOf(spec(), h.store.tickets(project().id), new Map(), publishWaitsOf(h.store, spec(), h.clock.now()))!.entries.find((entry) => entry.key === "CSV-1")).toMatchObject({ draft: true, publishWait: "1 check is still running" });

    checks(check("build", "passed"), check("test", "passed"));
    await poll();
    expect(methods()).toEqual(["prReady", "prRequestReview"]);
    expect(card()).toMatchObject({ draft: null, publishWait: null });
    const marked = h.store.posts(ticket().id).filter((post) => (JSON.parse(post.data_json) as { outcome?: string }).outcome === "pr_marked_ready");
    expect(marked.at(-1)!.body).toContain("Published");
    await poll();
    expect(methods()).toEqual(["prReady", "prRequestReview"]);
  });

  it("waits for checks on the commit Loom pushed, and for a failed one to be fixed", async () => {
    await openPr();
    h.host.feedback.set(URL, { head: "someone-else", checks: [check("build", "passed")] });
    await poll();
    expect(card().publishWait).toBe("Loom has not read the checks of the commit it pushed yet");
    checks(check("build", "failed"), check("lint", "neutral"));
    await poll();
    expect(methods()).toEqual([]);
  });

  it("waits until what the ticket's rollout requires is live, with when = [\"live\"]", async () => {
    await openPr((doc) => {
      doc.merge.publish = { when: ["live"] };
      doc.ticket[0].rollout = { requires_live: ["schema-ready"] };
      doc.rollout = { milestone: [{ ref: "schema-ready", title: "The schema is migrated" }] };
    });
    checks(check("test", "pending"));
    await poll();
    expect(card().publishWait).toBe("schema-ready is not live yet");
    markLiveByHuman(h.ctx, "csv", "schema-ready", {}, "human");
    await poll();
    expect(methods()).toEqual(["prReady", "prRequestReview"]);
  });

  it("never publishes a held draft", async () => {
    await openPr((doc) => void (doc.ticket[0].keep_draft = true));
    checks(check("build", "passed"));
    for (let read = 0; read < 3; read += 1) await poll();
    expect(methods()).toEqual([]);
    expect(card().draft).toBe("held");
  });

  it("leaves a project without merge.publish as it was: marked ready at the open, reviewers at the next read", async () => {
    await openPr((doc) => void delete doc.merge.publish);
    expect(methods()).toEqual(["prReady"]);
    await poll();
    expect(methods()).toEqual(["prReady", "prRequestReview"]);
    expect(card().publishWait).toBeNull();
  });
});
