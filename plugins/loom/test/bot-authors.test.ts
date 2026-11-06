// Bot authors: accounts Loom counts as bots on top of the ones the forge marks, from Loom's botAuthors setting and the
// forge's own bots globs. A bot's top-level comment starts no fix round.
import { beforeEach, describe, expect, it } from "vitest";
import { specOf } from "../src/ctx";
import { Engine } from "../src/engine";
import { forgeCheck } from "../src/forge-check";
import { saveProfile } from "../src/forge-profiles";
import type { HostOutput } from "../src/host-contract";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { askForPrTexts, handInPrText } from "../src/pull-requests";
import { makeCtx, reachApproved, seedProject, ticketOf, type Doc, type EngineHarness } from "./helpers";

type Item = Extract<HostOutput<"prFeedback">, { outcome: "ok" }>["items"][number];
const URL = "https://github.com/acme/shop/pull/1";
const comment = (key: string, author: string, body: string): Item => ({ key, kind: "comment", author, bot: false, body, url: null, state: null, path: null, line: null });

let h: EngineHarness;
beforeEach(() => {
  h = makeCtx();
});

const project = () => h.store.projectBySlug("csv")!;
const ticket = () => ticketOf(h, "CSV-1");
const feedbackPost = () => h.store.posts(ticket().id).filter((post) => (JSON.parse(post.data_json) as { outcome?: string }).outcome === "pr_feedback").at(-1);

async function openPr(forge: Doc): Promise<void> {
  await seedProject(h, (doc) => (doc.merge = { strategy: "pr", forge }));
  const worker = await reachApproved(h);
  await askForPrTexts(h.ctx, project(), specOf(h.store, project()));
  handInPrText(h.ctx, worker.thread_id!, { title: "Add order rows", body: "Adds the rows.", commit_message: "Add the order rows" });
  await runMergeQueue(h.ctx, project(), specOf(h.store, project()));
  await settleMerges(h.ctx);
  expect(ticket()).toMatchObject({ state: "pr_open", pr_url: URL });
}

const poll = async () => {
  h.clock.advance(5 * 60_000);
  await pollPullRequests(h.ctx, project());
};

describe("authors Loom counts as bots", () => {
  it("leaves out the top-level comments of authors the forge's bots globs name, though the forge calls them people", async () => {
    await openPr({ kind: "gh", bots: ["*@robots.example.com"] });
    h.host.feedback.set(URL, { items: [comment("comment:1:a", "preview@robots.example.com", "Quick preview is ready.")] });
    await poll();
    expect(ticket()).toMatchObject({ state: "pr_open", pr_rounds: 0 });
    expect(JSON.parse(ticket().pr_seen_json)).toContain("comment:1:a");

    h.host.feedback.set(URL, { items: [comment("comment:1:a", "preview@robots.example.com", "Quick preview is ready."), comment("comment:3:c", "preview@robots.example.com", "Preview updated."), comment("comment:2:b", "sam", "Can this ship today?")] });
    await poll();
    expect(ticket()).toMatchObject({ state: "working", pr_rounds: 1 });
    expect(JSON.parse(feedbackPost()!.data_json)).toMatchObject({ items: [expect.objectContaining({ author: "sam" })], ignored: { bots: 1 } });
  });

  it("uses Loom's botAuthors setting, which names renovate, dependabot and [bot] accounts by default", async () => {
    await openPr({ kind: "gh" });
    h.host.feedback.set(URL, { items: [comment("comment:1:a", "renovate-helper", "Rebased."), comment("comment:2:b", "ci[bot]", "All green.")] });
    await poll();
    expect(ticket()).toMatchObject({ state: "pr_open", pr_rounds: 0 });

    h.ctx.botAuthors = () => ["notice-*"];
    h.host.feedback.set(URL, { items: [comment("comment:3:c", "notice-board", "To merge, get two approvals."), comment("comment:4:d", "ci[bot]", "All green again.")] });
    await poll();
    expect(ticket()).toMatchObject({ state: "working", pr_rounds: 1 });
    expect(JSON.parse(feedbackPost()!.data_json)).toMatchObject({ items: [expect.objectContaining({ author: "ci[bot]" })], ignored: { bots: 1 } });
  });

  it("takes the globs of the forge profile a spec names", async () => {
    saveProfile(h.store, { id: "forge", name: "Forge", open: "forge open", state: "forge state", feedback: "forge feedback", bots: ["svc-*"] }, null);
    await openPr({ profile: "forge" });
    const url = ticket().pr_url!;
    h.host.feedback.set(url, { items: [comment("comment:1:a", "svc-tests", "To merge this, add a test plan.")] });
    await poll();
    expect(ticket()).toMatchObject({ state: "pr_open", pr_rounds: 0 });
    const check = await forgeCheck(h.ctx, { slug: "csv", target: "CSV-1" });
    expect(check.read!.items).toEqual([expect.objectContaining({ author: "svc-tests", bot: true })]);
  });

  it("reads the setting from Loom's settings, and an empty one names nobody", () => {
    const engine = (botAuthors?: string) => new Engine({ store: h.store, bb: h.bb, now: h.clock.now, host: h.host, projects: h.projects, settings: () => ({ doneHook: "", doneRecord: "summary", ...(botAuthors === undefined ? {} : { botAuthors }) }) });
    expect(engine().ctx.botAuthors!()).toEqual(["dependabot*", "renovate*", "*[bot]"]);
    expect(engine("svc-*, *@robots.example.com").ctx.botAuthors!()).toEqual(["svc-*", "*@robots.example.com"]);
    expect(engine("").ctx.botAuthors!()).toEqual([]);
  });
});
