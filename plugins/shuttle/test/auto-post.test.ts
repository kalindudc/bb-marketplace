// @vitest-environment node
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { DEFAULT_DISCLOSURE } from "../src/config";
import { gatesSettled, NO_APPROVE_PATHS } from "../src/gate";
import { draft, gateOf, good, KEY, shadow } from "./gate-harness";
import { pr } from "./helpers";

const MINUTE = 60_000;
type Shadowed = Awaited<ReturnType<typeof shadow>>;

/** A repository entry that posts, on top of the harness's shadow repository. */
const posting = (repo: Record<string, unknown>, rest: Record<string, unknown> = {}) => ({ autoPost: { repos: [{ repo: "acme/*", mode: "shadow", ...repo }], ...rest } });
const APPROVE = { approve: "countdown", approvePaths: ["*.go", "docs/*"] };

/** Gives the review thread the critic threads its votes claim. */
function critics(h: Shadowed["h"], threadId: string, count = 3): void {
  const ids = Array.from({ length: count }, (_, i) => `${threadId}-critic-${i}`);
  for (const id of ids) h.port.addThread(id);
  h.port.children.set(threadId, ids);
}

async function due(h: Shadowed["h"], minutes: number) {
  h.clock.now += minutes * MINUTE;
  await h.shuttle.runAutoPosts();
  await h.shuttle.postsSettled();
}

const reviews = (h: Shadowed["h"]) => h.runner.calls.filter((call) => call.operation === "review");
const schedule = (h: Shadowed["h"]) => h.shuttle.detail(KEY(3)).draft?.autoPost ?? null;
const eventsOf = (h: Shadowed["h"], kind: string) => h.store.events({ limit: 50 }).filter((e) => e.kind === kind).map((e) => e.text);

describe("auto post in shadow mode", () => {
  it("never schedules or posts, however long it waits", async () => {
    const { h } = await shadow();
    const d = await draft(h, { findings: [good()] });
    expect(gateOf(d).decision).toBe("post");
    expect(d.autoPost).toBeNull();
    await due(h, 600);
    expect(reviews(h)).toEqual([]);
    expect(h.port.notifications).toEqual([]);
  });
});

describe("posting comments", () => {
  it("posts the passing findings after the countdown, with the summary and the footer, and tells you before and after", async () => {
    const { h } = await shadow(posting({ mode: "countdown" }));
    const d = await draft(h, { findings: [good(), good({ severity: "nit", line: 4, body: "A nit about naming the counter." })] });
    critics(h, d.threadId);
    expect(d.autoPost).toMatchObject({ state: "scheduled", verdict: "comment", at: h.clock.now + 30 * MINUTE, findings: ["f1"] });
    expect(h.port.notifications[0]!.title).toBe("Shuttle will comment on acme/app#3 with 1 comment in 30 minutes");
    expect(h.shuttle.view(KEY(3)).next).toMatchObject({ kind: "post", label: "Shuttle will post this in 30 minutes" });

    await due(h, 29);
    expect(reviews(h)).toEqual([]);
    await due(h, 2);
    const [call] = reviews(h);
    expect(call!.env).toMatchObject({ SHUTTLE_VERDICT: "comment", SHUTTLE_BODY: `One race\n\n---\n${DEFAULT_DISCLOSURE}`, SHUTTLE_HEAD: "h1" });
    expect(JSON.parse(call!.env.SHUTTLE_COMMENTS!)).toEqual([{ path: "main.go", line: 5, body: good().body }]);
    const posted = h.store.draftById(d.id)!;
    expect(posted).toMatchObject({ state: "posted", auto_post_state: "posted", posted_verdict: "comment" });
    // Shuttle chose the finding, so it is not one you kept, and the nit it left out is not one you dropped.
    expect(JSON.parse(posted.outcome!)).toEqual([{ id: "f1", outcome: "auto" }]);
    expect(h.port.notifications.at(-1)!.title).toBe("Shuttle commented on acme/app#3 with 1 comment");
  });

  it("posts at once in auto mode, and uses the repository's own footer", async () => {
    const { h } = await shadow(posting({ mode: "auto", disclosure: "Posted by Shuttle for Sam." }));
    const d = await draft(h, { findings: [good()] });
    critics(h, d.threadId);
    await due(h, 0);
    expect(reviews(h)[0]!.env.SHUTTLE_BODY).toBe("One race\n\n---\nPosted by Shuttle for Sam.");
    // Nothing to stop in auto mode, so nothing is announced before it posts.
    expect(h.port.notifications.map((n) => n.title)).toEqual(["Shuttle commented on acme/app#3 with 1 comment"]);
  });

  it("posts the summary alone when you clear the footer", async () => {
    const { h } = await shadow(posting({ mode: "auto" }, { disclosure: "" }));
    critics(h, (await draft(h, { findings: [good()] })).threadId);
    await due(h, 0);
    expect(reviews(h)[0]!.env.SHUTTLE_BODY).toBe("One race");
  });

  it("stops when you stop it, post it or discard it, and a check again does not start it again", async () => {
    const stopped = await shadow(posting({ mode: "countdown" }));
    const d = await draft(stopped.h, { findings: [good()] });
    stopped.h.shuttle.stopAutoPost(KEY(3), d.id);
    await stopped.h.shuttle.checkDraft(KEY(3), d.id);
    expect(schedule(stopped.h)).toMatchObject({ state: "stopped", reason: "you stopped it" });
    await due(stopped.h, 60);
    expect(reviews(stopped.h)).toEqual([]);

    const yours = await shadow(posting({ mode: "countdown" }));
    const y = await draft(yours.h, { findings: [good()] });
    await yours.h.shuttle.submitReview(KEY(3), { verdict: "comment", body: "Mine", findings: [{ id: "f1", path: "main.go", line: 5, body: good().body }], draftId: y.id });
    expect(yours.h.store.draftById(y.id)).toMatchObject({ auto_post_state: "stopped", auto_post_reason: "you posted it yourself", outcome: '[{"id":"f1","outcome":"kept"}]' });

    const discarded = await shadow(posting({ mode: "countdown" }));
    const x = await draft(discarded.h, { findings: [good()] });
    await discarded.h.shuttle.discardDraft(KEY(3), x.id);
    expect(discarded.h.store.draftById(x.id)).toMatchObject({ auto_post_state: "stopped", auto_post_reason: "you discarded it" });
    await due(discarded.h, 60);
    expect(reviews(discarded.h)).toEqual([]);
  });

  it("posts now when you ask, with every check just before it is sent", async () => {
    const { h } = await shadow(posting({ mode: "countdown" }));
    const d = await draft(h, { findings: [good()] });
    h.shuttle.autoPostNow(KEY(3), d.id);
    await h.shuttle.postsSettled();
    expect(reviews(h)).toEqual([]);
    expect(h.store.draftById(d.id)).toMatchObject({ state: "draft", auto_post_state: "refused", auto_post_reason: "the review reports 3 critic votes, but its thread has 0 child threads" });
    const again = await draft(h, { findings: [good()] });
    critics(h, again.threadId);
    h.shuttle.autoPostNow(KEY(3), again.id);
    await h.shuttle.postsSettled();
    expect(reviews(h)).toHaveLength(1);
  });

  it("refuses at post time what changed since the check, and says why", async () => {
    const cases: Array<[string, (s: Shadowed) => void | Promise<void>, string]> = [
      ["a push", (s) => { s.h.views[3] = pr(3, { head: "h2", additions: 12, deletions: 3 }); }, "the PR has new commits since the review read it"],
      ["a merge", (s) => { s.h.views[3] = pr(3, { head: "h1", additions: 12, deletions: 3, state: "merged" }); }, "the PR is merged"],
      ["paused automations", (s) => { s.h.settings.pauseAutomations = true; }, "automations are paused"],
      ["timed pause", async (s) => { await s.h.shuttle.setAutomationPause({ mode: "until", until: s.h.clock.now + 24 * 60 * MINUTE }); }, "automations are paused"],
      ["a mode turned back to shadow", (s) => {
        const config = s.h.shuttle.config();
        s.h.shuttle.saveConfig({ ...config, autoPost: { ...config.autoPost, repos: [{ ...config.autoPost.repos[0]!, mode: "shadow" }] } });
      }, "auto post no longer posts comments in acme/app"],
    ];
    for (const [name, change, reason] of cases) {
      const s = await shadow(posting({ mode: "countdown" }));
      const d = await draft(s.h, { findings: [good()] });
      critics(s.h, d.threadId);
      await change(s);
      await due(s.h, 31);
      expect(reviews(s.h), name).toEqual([]);
      expect(s.h.store.draftById(d.id), name).toMatchObject({ state: "draft", auto_post_state: "refused", auto_post_reason: reason });
      expect(s.h.port.notifications.at(-1)!.title, name).toBe("Shuttle did not comment on acme/app#3");
    }
  });

  it("checks again at the moment it posts, so a change while it waited in the queue still stops it", async () => {
    const cases: Array<[string, (s: Shadowed) => void, string]> = [
      ["paused", (s) => { s.h.settings.pauseAutomations = true; }, "automations are paused"],
      ["back to draft", (s) => { s.h.views[3] = pr(3, { head: "h1", additions: 12, deletions: 3, state: "draft" }); }, "the PR went back to draft"],
      ["checks failed", (s) => { s.h.views[3] = pr(3, { head: "h1", additions: 12, deletions: 3, checks: "failed" }); }, "checks failed"],
    ];
    for (const [name, change, reason] of cases) {
      const s = await shadow(posting({ mode: "shadow", ...APPROVE }));
      const d = await draft(s.h, { findings: [], verdict: "approve" });
      // Another review on the same server posts first, and the approval waits behind it.
      s.h.views[4] = pr(4, { head: "h1" });
      await s.h.shuttle.lookup(KEY(4));
      const ahead = s.h.hold("review");
      s.h.shuttle.queueReview(KEY(4), { verdict: "comment", body: "Mine", findings: [] });
      await ahead.reached;
      s.h.clock.now += 121 * MINUTE;
      expect(s.h.shuttle.runAutoPosts(), name).toBe(1);
      change(s);
      ahead.release();
      await s.h.shuttle.postsSettled();
      expect(reviews(s.h).map((call) => call.env.SHUTTLE_VERDICT), name).toEqual(["comment"]);
      expect(s.h.store.draftById(d.id), name).toMatchObject({ state: "draft", auto_post_state: "refused", auto_post_reason: reason });
    }
  });

  it("does not post what was scheduled under settings you changed since, and a check again starts a new countdown", async () => {
    const { h } = await shadow(posting({ mode: "auto" }));
    const d = await draft(h, { findings: [good()] });
    critics(h, d.threadId);
    const config = h.shuttle.config();
    h.shuttle.saveConfig({ ...config, autoPost: { ...config.autoPost, repos: [{ ...config.autoPost.repos[0]!, mode: "countdown" }] } });
    await due(h, 0);
    expect(reviews(h)).toEqual([]);
    expect(schedule(h)).toMatchObject({ state: "refused", reason: "the auto post settings changed since it was checked; check it again" });
    await h.shuttle.checkDraft(KEY(3), d.id);
    expect(schedule(h)).toMatchObject({ state: "scheduled", at: h.clock.now + 30 * MINUTE });
  });

  it("schedules nothing when the settings changed while the gate was checking, or the bot authors since", async () => {
    let s!: Shadowed;
    s = await shadow({
      ...posting({ mode: "countdown" }),
      onVerify: async () => {
        const config = s.h.shuttle.config();
        s.h.shuttle.saveConfig({ ...config, autoPost: { ...config.autoPost, repos: [{ ...config.autoPost.repos[0]!, holdPaths: ["main.go"] }] } });
      },
    });
    const d = await draft(s.h, { findings: [good()] });
    expect(d.autoPost).toMatchObject({ state: "refused", reason: "the auto post settings changed while it was checked; check it again" });
    expect(eventsOf(s.h, "auto_post")).toContain("Auto post did not schedule acme/app#3: the auto post settings changed while it was checked; check it again.");
    await due(s.h, 60);
    expect(reviews(s.h)).toEqual([]);

    const bots = await shadow(posting({ mode: "countdown" }));
    const b = await draft(bots.h, { findings: [good()] });
    critics(bots.h, b.threadId);
    bots.h.settings.botAuthors = ["sam"];
    await due(bots.h, 31);
    expect(reviews(bots.h)).toEqual([]);
    expect(schedule(bots.h)).toMatchObject({ state: "refused", reason: "the auto post settings changed since it was checked; check it again" });
  });

  it("withdraws a queued post of its own when a newer review of the PR arrives, and keeps one you queued", async () => {
    const { h } = await shadow(posting(APPROVE));
    const old = await draft(h, { findings: [], verdict: "approve" });
    critics(h, old.threadId);
    h.views[4] = pr(4, { head: "h1" });
    await h.shuttle.lookup(KEY(4));
    const ahead = h.hold("review");
    h.shuttle.queueReview(KEY(4), { verdict: "comment", body: "Mine", findings: [] });
    await ahead.reached;
    h.clock.now += 121 * MINUTE;
    expect(h.shuttle.runAutoPosts()).toBe(1);
    await h.shuttle.saveDraft(old.threadId, KEY(3), { summary: "On second look", verdict: "changes", findings: [good({ severity: "high" })] as never, assessment: { risk: "high", concerns: [] } });
    ahead.release();
    await h.shuttle.postsSettled();
    expect(reviews(h).map((call) => call.env.SHUTTLE_VERDICT)).toEqual(["comment"]);
    expect(h.store.draftById(old.id)).toMatchObject({ state: "discarded", discard_reason: "superseded", auto_post_state: "stopped", auto_post_reason: "a newer review of the PR replaced it" });
    expect(h.port.notifications.map((n) => n.title)).toContain("Shuttle will not post the earlier review of acme/app#3");
  });

  it("refuses at the write a draft a newer one replaced while it was being sent, and takes it out of the tab", async () => {
    const { h } = await shadow(posting({ mode: "auto" }));
    const old = await draft(h, { findings: [good()] });
    critics(h, old.threadId);
    const read = h.hold("view");
    h.shuttle.runAutoPosts();
    await read.reached;
    await h.shuttle.saveDraft(old.threadId, KEY(3), { summary: "Second look", verdict: "comment", findings: [], assessment: { risk: "low", concerns: [] } });
    read.release();
    await h.shuttle.postsSettled();
    expect(reviews(h)).toEqual([]);
    expect(h.store.draftById(old.id)).toMatchObject({ state: "discarded", auto_post_state: "refused", auto_post_reason: "a newer review of the PR replaced it" });
  });

  it("frees the daily limit when its post failed, and refuses a PR it already knows moved on in plain words", async () => {
    const { h } = await shadow(posting({ mode: "auto" }, { maxPerDay: 1 }));
    critics(h, (await draft(h, { findings: [good()] })).threadId);
    h.answers.review = new Error("server down");
    await due(h, 0);
    h.answers.review = "";
    h.views[4] = pr(4, { head: "h1", additions: 12, deletions: 3 });
    await h.shuttle.lookup(KEY(4));
    const { threadId } = await h.shuttle.review({ key: KEY(4) });
    critics(h, threadId);
    await h.shuttle.saveDraft(threadId, KEY(4), { summary: "Another race", verdict: "comment", findings: [good()] as never, assessment: { risk: "low", concerns: [] } });
    await gatesSettled(h.shuttle);
    expect(h.shuttle.detail(KEY(4)).draft!.autoPost).toMatchObject({ state: "scheduled" });
    h.views[4] = pr(4, { head: "h2", additions: 12, deletions: 3 });
    await h.shuttle.lookup(KEY(4));
    await due(h, 0);
    expect(h.shuttle.detail(KEY(4)).draft!.autoPost).toMatchObject({ state: "refused", reason: "the PR has new commits since the review read it" });
  });

  it("posts no more than the daily limit in a repository", async () => {
    const { h } = await shadow(posting({ mode: "auto" }, { maxPerDay: 1 }));
    critics(h, (await draft(h, { findings: [good()] })).threadId);
    await due(h, 0);
    h.views[4] = pr(4, { head: "h1", additions: 12, deletions: 3 });
    await h.shuttle.lookup(KEY(4));
    const { threadId } = await h.shuttle.review({ key: KEY(4) });
    critics(h, threadId);
    await h.shuttle.saveDraft(threadId, KEY(4), { summary: "Another race", verdict: "comment", findings: [good()] as never, assessment: { risk: "low", concerns: [] } });
    await h.shuttle.checkDraft(KEY(4), h.shuttle.detail(KEY(4)).draft!.id);
    expect(h.shuttle.detail(KEY(4)).draft!.autoPost).toMatchObject({ state: "refused", reason: "Shuttle already posted or queued 1 review in acme/* in the last day, its daily limit" });
    expect(reviews(h)).toHaveLength(1);
  });

  it("counts what it queued against the daily limit, so two drafts due together post one", async () => {
    const { h } = await shadow(posting({ mode: "countdown" }, { maxPerDay: 1 }));
    critics(h, (await draft(h, { findings: [good()] })).threadId);
    h.views[4] = pr(4, { head: "h1", additions: 12, deletions: 3 });
    await h.shuttle.lookup(KEY(4));
    const { threadId } = await h.shuttle.review({ key: KEY(4) });
    critics(h, threadId);
    await h.shuttle.saveDraft(threadId, KEY(4), { summary: "Another race", verdict: "comment", findings: [good()] as never, assessment: { risk: "low", concerns: [] } });
    await h.shuttle.checkDraft(KEY(4), h.shuttle.detail(KEY(4)).draft!.id);
    await due(h, 31);
    expect(reviews(h)).toHaveLength(1);
    expect(h.shuttle.detail(KEY(4)).draft!.autoPost).toMatchObject({ state: "refused", reason: "Shuttle already posted or queued 1 review in acme/* in the last day, its daily limit" });
  });

  it("tells you only once a review is sent, and when it fails to post; your own post afterwards clears it", async () => {
    const { h } = await shadow(posting({ mode: "auto" }));
    const d = await draft(h, { findings: [good()] });
    critics(h, d.threadId);
    h.answers.review = new Error("server down");
    await due(h, 0);
    expect(h.port.notifications.map((n) => n.title)).toEqual(["Shuttle's review of acme/app#3 did not post"]);
    expect(h.store.draftById(d.id)).toMatchObject({ state: "draft", auto_post_state: "queued" });
    h.answers.review = "";
    await h.shuttle.submitReview(KEY(3), { verdict: "comment", body: "Mine", findings: [], draftId: d.id });
    expect(h.store.draftById(d.id)).toMatchObject({ auto_post_state: "stopped", auto_post_reason: "you posted it yourself" });
    expect(h.shuttle.autoPostInsights("30d").repos[0]!.posted.reviews).toBe(0);
  });

  it("never posts a request for changes, or an approve draft's comments while approvals only record", async () => {
    for (const verdict of ["changes", "approve"] as const) {
      const { h } = await shadow(posting({ mode: "auto" }));
      const d = await draft(h, { findings: [good()], verdict });
      critics(h, d.threadId);
      await due(h, 600);
      expect(d.autoPost, verdict).toBeNull();
      expect(reviews(h), verdict).toEqual([]);
    }
  });
});

describe("posting approvals", () => {
  it("approves after the longer countdown, with the passing findings as comments and a footer even when comments have none", async () => {
    const { h, blockingPrompts } = await shadow(posting({ mode: "shadow", ...APPROVE }, { disclosure: "" , minSeverity: "low" }));
    const d = await draft(h, { findings: [good({ severity: "low" })], verdict: "approve" });
    critics(h, d.threadId);
    expect(gateOf(d).approval).toMatchObject({ decision: "approve", blocking: { score: 0.05 } });
    expect(blockingPrompts[0]).toContain("+\tshared++");
    expect(d.autoPost).toMatchObject({ state: "scheduled", verdict: "approve", at: h.clock.now + 120 * MINUTE, findings: ["f1"] });
    await due(h, 119);
    expect(reviews(h)).toEqual([]);
    await due(h, 2);
    const [call] = reviews(h);
    expect(call!.env).toMatchObject({ SHUTTLE_VERDICT: "approve", SHUTTLE_BODY: `One race\n\n---\n${DEFAULT_DISCLOSURE}` });
    expect(JSON.parse(call!.env.SHUTTLE_COMMENTS!)).toHaveLength(1);
  });

  it("approves only from a review that suggested approving, with critic threads behind it", async () => {
    const comment = await shadow(posting(APPROVE));
    const c = await draft(comment.h, { findings: [], verdict: "comment" });
    expect(gateOf(c).approval).toMatchObject({ decision: "approve" });
    expect(c.autoPost).toBeNull();
    const lonely = await shadow(posting({ ...APPROVE, approve: "auto" }));
    const l = await draft(lonely.h, { findings: [], verdict: "approve" });
    critics(lonely.h, l.threadId, 1);
    await due(lonely.h, 0);
    expect(reviews(lonely.h)).toEqual([]);
    expect(schedule(lonely.h)).toMatchObject({ state: "refused", reason: "an approval needs at least 2 critic threads behind it, and the review's thread has 1" });
  });

  it("does not post once you reviewed the PR yourself, on the server or through Shuttle, after the draft came", async () => {
    const { h } = await shadow(posting(APPROVE));
    const d = await draft(h, { findings: [], verdict: "approve" });
    critics(h, d.threadId);
    // What the server says of your own latest review, as GitHub reports it.
    (h.store as unknown as { db: Database.Database }).db.prepare("UPDATE prs SET my_review = ? WHERE key = ?").run(JSON.stringify({ verdict: "approve", at: h.clock.now + 60_000, head: "h1" }), KEY(3));
    await due(h, 121);
    expect(reviews(h)).toEqual([]);
    expect(schedule(h)).toMatchObject({ state: "refused", reason: expect.stringMatching(/^you reviewed it yourself on .+ after the draft came$/u) });

    const via = await shadow(posting(APPROVE));
    const v = await draft(via.h, { findings: [], verdict: "approve" });
    critics(via.h, v.threadId);
    via.h.clock.now += 60_000;
    await via.h.shuttle.submitReview(KEY(3), { verdict: "comment", body: "A question first", findings: [] });
    await due(via.h, 121);
    expect(reviews(via.h).map((call) => call.env.SHUTTLE_VERDICT)).toEqual(["comment"]);
  });

  it("never approves without paths to cover, or a PR that changes a file outside them", async () => {
    const none = gateOf(await draft((await shadow(posting({ approve: "auto" }))).h, { findings: [], verdict: "approve" }));
    expect(none.approval).toMatchObject({ decision: "hold", reasons: [NO_APPROVE_PATHS] });
    const outside = gateOf(await draft((await shadow(posting({ approve: "auto", approvePaths: ["*.go"] }))).h, { findings: [], verdict: "approve" }));
    expect(outside.approval).toMatchObject({ decision: "hold", reasons: ["it changes docs/readme.md, outside the paths approvals may cover"] });
    // Shadow mode still records what the other rules say, without paths.
    expect(gateOf(await draft((await shadow()).h, { findings: [], verdict: "approve" })).approval).toMatchObject({ decision: "approve" });
  });

  it("holds an approval the blocking check finds a problem in, cannot run, or cannot see all of", async () => {
    const blocked = await shadow({ ...posting(APPROVE), blocking: () => ({ stdout: '{"blocking": 0.6, "reason": "It drops the lock."}' }) });
    expect(gateOf(await draft(blocked.h, { findings: [], verdict: "approve" })).approval).toMatchObject({
      decision: "hold", reasons: ["the verifier puts a blocking problem at 0.60 (floor 0.2): It drops the lock."], blocking: { score: 0.6 },
    });
    const broken = await shadow({ ...posting(APPROVE), blocking: () => ({ code: 1 }) });
    expect(gateOf(await draft(broken.h, { findings: [], verdict: "approve" })).approval?.reasons[0]).toMatch(/^the blocking check failed: it exited 1/u);
    const hidden = await shadow(posting(APPROVE));
    hidden.h.answers.files = [{ path: "main.go", patch: null }];
    expect(gateOf(await draft(hidden.h, { findings: [], verdict: "approve" })).approval).toMatchObject({ reasons: ["the blocking check failed: the server sent no diff for main.go"] });
    expect(hidden.blockingPrompts).toEqual([]);
  });

  it("posts an approval's comments highest severity first", async () => {
    const { h } = await shadow(posting({ ...APPROVE, approve: "auto" }, { minSeverity: "low", approvals: { maxSeverity: "medium" } }));
    const d = await draft(h, { findings: [good({ severity: "low" }), good({ severity: "medium", line: 4, body: "A medium race on the counter." })], verdict: "approve" });
    critics(h, d.threadId);
    await due(h, 0);
    expect(JSON.parse(reviews(h)[0]!.env.SHUTTLE_COMMENTS!).map((c: { line: number }) => c.line)).toEqual([4, 5]);
  });

  it("matches the paths approvals may cover by case, as git does, and * across folders", async () => {
    const deep = await shadow(posting({ approve: "auto", approvePaths: ["docs/*"] }));
    deep.h.answers.files = [{ path: "docs/guides/setup.md", patch: "@@ -1 +1 @@\n-a\n+b" }];
    expect(gateOf(await draft(deep.h, { findings: [], verdict: "approve" })).approval).toMatchObject({ decision: "approve" });
    const lower = await shadow(posting({ approve: "auto", approvePaths: ["docs/*"] }));
    lower.h.answers.files = [{ path: "DOCS/readme.md", patch: "@@ -1 +1 @@\n-a\n+b" }];
    expect(gateOf(await draft(lower.h, { findings: [], verdict: "approve" })).approval).toMatchObject({ reasons: ["it changes DOCS/readme.md, outside the paths approvals may cover"] });
  });

  it("posts approvals with comments off when you choose to, and a repository with both off stays off", async () => {
    const { h } = await shadow(posting({ mode: "off", ...APPROVE, approve: "auto" }));
    const d = await draft(h, { findings: [], verdict: "approve" });
    expect(d.autoPost).toMatchObject({ state: "scheduled", verdict: "approve" });
    const off = await shadow(posting({ mode: "off" }));
    expect((await draft(off.h, { findings: [], verdict: "approve" })).gate).toBeNull();
    expect(off.blockingPrompts).toEqual([]);
  });

  it("does not approve what was scheduled before you narrowed the paths or tightened the blocking floor", async () => {
    for (const change of [{ repo: { approvePaths: ["*.go"] } }, { floors: { holds: 0.7, worth: 0.7, blocking: 0.01 } }]) {
      const { h } = await shadow(posting(APPROVE));
      await draft(h, { findings: [], verdict: "approve" });
      const config = h.shuttle.config();
      h.shuttle.saveConfig({ ...config, autoPost: { ...config.autoPost, ...("floors" in change ? { floors: change.floors } : {}), repos: [{ ...config.autoPost.repos[0]!, ...("repo" in change ? change.repo : {}) }] } });
      await due(h, 121);
      expect(reviews(h)).toEqual([]);
      expect(schedule(h)).toMatchObject({ state: "refused", reason: "the auto post settings changed since it was checked; check it again" });
    }
  });

  it("refuses an approval when checks fail or a reviewer asks for changes during the countdown", async () => {
    for (const [change, reason] of [[{ checks: "failed" }, "checks failed"], [{ review: "changes" }, "a reviewer requested changes"]] as const) {
      const { h } = await shadow(posting(APPROVE));
      await draft(h, { findings: [], verdict: "approve" });
      h.views[3] = pr(3, { head: "h1", additions: 12, deletions: 3, ...change });
      await due(h, 121);
      expect(reviews(h)).toEqual([]);
      expect(schedule(h)).toMatchObject({ state: "refused", reason });
    }
  });
});

describe("marking what Shuttle posted", () => {
  async function postedComment(rest: Record<string, unknown> = {}) {
    const s = await shadow(posting({ mode: "auto", ...APPROVE }, rest));
    const d = await draft(s.h, { findings: [good()] });
    critics(s.h, d.threadId);
    await due(s.h, 0);
    return { ...s, d };
  }

  it("counts an unmarked finding as pending until the PR closes, then agreed; a marked one against", async () => {
    const { h, d } = await postedComment();
    expect(h.shuttle.autoPostInsights("30d").repos[0]!).toMatchObject({ findings: { agreed: 0, pending: 1 }, posted: { reviews: 1, findings: 1, marked: 0 } });
    h.views[3] = pr(3, { head: "h1", additions: 12, deletions: 3, state: "merged" });
    await h.shuttle.lookup(KEY(3));
    expect(h.shuttle.autoPostInsights("30d").repos[0]!.findings).toMatchObject({ agreed: 1, pending: 0 });
    h.shuttle.markAutoPost(KEY(3), d.id, "f1");
    expect(h.shuttle.autoPostInsights("30d").repos[0]!).toMatchObject({ findings: { agreed: 0, against: 1 }, posted: { marked: 1 } });
    expect(h.shuttle.reviewHistory(KEY(3)).items[0]!.autoPosted).toMatchObject({ verdict: "comment", findings: [{ id: "f1", marked: true }] });
    h.shuttle.markAutoPost(KEY(3), d.id, "f1", true);
    expect(h.shuttle.autoPostInsights("30d").repos[0]!.findings).toMatchObject({ agreed: 1, against: 0 });
  });

  it("keeps the whole review Shuttle posted for Earlier reviews: its text, what it posted, what it left out and what you marked", async () => {
    const s = await shadow(posting({ mode: "auto", ...APPROVE }));
    const d = await draft(s.h, { findings: [good(), { ...good(), severity: "nit", body: "Nit: a clearer name would help here." }] });
    critics(s.h, d.threadId);
    await due(s.h, 0);
    const history = () => s.h.shuttle.reviewHistory(KEY(3)).items[0]!;
    expect(history().postedBody).toContain("Shuttle posted this review");
    expect(history().findings.map((f) => [f.id, f.fate])).toEqual([["f1", "auto"], ["f2", "left_out"]]);
    s.h.shuttle.markAutoPost(KEY(3), d.id, "f1");
    expect(history().findings.map((f) => [f.id, f.fate])).toEqual([["f1", "retracted"], ["f2", "left_out"]]);
  });

  it("stops posting comments in the repository when you mark more than the breaker allows, until you resume", async () => {
    const { h, d } = await postedComment({ breaker: { window: 20, maxMarked: 0 } });
    h.shuttle.markAutoPost(KEY(3), d.id, "f1");
    expect(eventsOf(h, "auto_post_breaker")).toEqual(["Auto post stopped posting comments in acme/*: you marked 1 of the last 20 comments it posted as mistakes. Resume it in Settings › Automations."]);
    expect(h.port.notifications.at(-1)!.title).toBe("Shuttle stopped posting comments in acme/*");
    expect(h.shuttle.autoPostInsights("30d").repos[0]!.trips).toEqual([{ kind: "comment", reason: "you marked 1 of the last 20 comments it posted as mistakes", at: expect.any(Number) }]);
    // The config is yours: the breaker leaves it as it was.
    expect(h.shuttle.config().autoPost.repos[0]!.mode).toBe("auto");
    const next = await draft(h, { findings: [good()] });
    expect(next.autoPost).toMatchObject({ state: "refused", reason: expect.stringMatching(/^posting comments in acme\/\* stopped: you marked 1/u) });
    expect(h.shuttle.resumeAutoPost("acme/*", "comment")).toEqual({ cleared: 1 });
    await h.shuttle.checkDraft(KEY(3), next.id);
    expect(schedule(h)).toMatchObject({ state: "scheduled" });
  });

  it("stops approvals after one approval you mark as a mistake, and leaves comments posting", async () => {
    const { h } = await shadow(posting({ mode: "auto", approve: "auto", approvePaths: ["*.go", "docs/*"] }));
    const d = await draft(h, { findings: [], verdict: "approve" });
    critics(h, d.threadId);
    await due(h, 0);
    expect(h.store.draftById(d.id)).toMatchObject({ auto_post_state: "posted", auto_post_verdict: "approve" });
    expect(() => h.shuttle.markAutoPost(KEY(3), d.id, "f1")).toThrow("Shuttle did not post that finding");
    h.shuttle.markAutoPost(KEY(3), d.id);
    const repo = h.shuttle.autoPostInsights("30d").repos[0]!;
    expect(repo.trips.map((t) => t.kind)).toEqual(["approve"]);
    expect(repo).toMatchObject({ approvals: { against: 1 }, posted: { approvals: 1, mistakes: 1 } });
    const comment = await draft(h, { findings: [good()] });
    expect(comment.autoPost).toMatchObject({ state: "scheduled", verdict: "comment" });
  });

  it("keeps a marked finding against the record when a later rescore would hold it", async () => {
    let scores = '{"holds": 0.9, "worth_posting": 0.85, "reason": "Real."}';
    const s = await shadow({ ...posting({ mode: "auto" }), verdict: () => ({ stdout: scores }) });
    const d = await draft(s.h, { findings: [good()] });
    critics(s.h, d.threadId);
    await due(s.h, 0);
    s.h.shuttle.markAutoPost(KEY(3), d.id, "f1");
    scores = '{"holds": 0.1, "worth_posting": 0.1, "reason": "No."}';
    await s.h.shuttle.rescoreDrafts(30);
    expect(s.h.shuttle.autoPostInsights("30d").repos[0]!.findings).toMatchObject({ against: 1, held: 0 });
  });

  it("starts a new countdown and says so when a check again changes what posts, and says why when it drops it", async () => {
    let worth = 0.85;
    const s = await shadow({ ...posting({ mode: "countdown" }), verdict: () => ({ stdout: `{"holds": 0.9, "worth_posting": ${worth}, "reason": "Real."}` }) });
    const d = await draft(s.h, { findings: [good(), good({ line: 4, body: "A second race on the counter." })] });
    expect(d.autoPost).toMatchObject({ findings: ["f1", "f2"] });
    s.h.clock.now += 10 * MINUTE;
    await s.h.shuttle.checkDraft(KEY(3), d.id);
    expect(schedule(s.h)!.at).toBe(d.autoPost!.at);
    s.h.store.setDraftGate(d.id, JSON.stringify({ ...gateOf(d), posting: ["f1"] }));
    worth = 0.1;
    const before = s.h.port.notifications.length;
    await s.h.shuttle.checkDraft(KEY(3), d.id);
    expect(schedule(s.h)).toMatchObject({ state: "refused", reason: expect.stringMatching(/^a check again held it: /u) });
    expect(s.h.port.notifications.length).toBe(before + 1);
  });

  it("tells you when a check again refuses a countdown it had announced", async () => {
    const { h } = await shadow(posting({ mode: "countdown" }));
    const d = await draft(h, { findings: [good()] });
    const before = h.port.notifications.length;
    h.settings.pauseAutomations = true;
    await h.shuttle.checkDraft(KEY(3), d.id);
    expect(schedule(h)).toMatchObject({ state: "refused", reason: "automations are paused" });
    expect(h.port.notifications.slice(before).map((n) => n.title)).toEqual(["Shuttle will not post on acme/app#3 after all"]);
  });

  it("keeps a would-approve draft that Shuttle posted as comments out of the approval record", async () => {
    const { h } = await shadow(posting({ mode: "auto" }));
    const d = await draft(h, { findings: [good()] });
    critics(h, d.threadId);
    expect(gateOf(d).approval).toMatchObject({ decision: "hold" });
    const low = await shadow(posting({ mode: "auto" }, { minSeverity: "low" }));
    const l = await draft(low.h, { findings: [good({ severity: "low" })] });
    critics(low.h, l.threadId);
    expect(gateOf(l).approval).toMatchObject({ decision: "approve" });
    await due(low.h, 0);
    expect(low.h.store.draftById(l.id)).toMatchObject({ auto_post_state: "posted", auto_post_verdict: "comment" });
    expect(low.h.shuttle.autoPostInsights("30d").repos[0]!.approvals).toMatchObject({ wouldApprove: 1, agreed: 0, against: 0, pending: 0 });
  });

  it("refuses to mark a draft you posted yourself", async () => {
    const { h } = await shadow();
    const d = await draft(h, { findings: [good()] });
    await h.shuttle.submitReview(KEY(3), { verdict: "comment", body: "s", findings: [], draftId: d.id });
    expect(() => h.shuttle.markAutoPost(KEY(3), d.id, "f1")).toThrow("Shuttle did not post that draft itself");
  });
});
