// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { gatesSettled, parseGate } from "../src/gate";
import { changedSettings, neededFor, replay, replaySettingsOf, summarize, wilsonLower, withReplaySettings } from "../src/replay";
import { draft, good, KEY, LOW, shadow } from "./gate-harness";

type Setup = Parameters<typeof shadow>[0];
type Input = Parameters<typeof draft>[1];

/** The stored check of a draft, replayed under the settings it ran with. */
async function checked(setup: Setup, input: Input) {
  const { h } = await shadow(setup);
  const d = await draft(h, input);
  const facts = h.shuttle.autoPostReplay("30d").drafts.find((row) => row.id === d.id)!;
  return { h, d, facts, gate: d.gate!, settings: replaySettingsOf(h.shuttle.config().autoPost) };
}

const CASES: Array<[string, Setup, Input]> = [
  ["a finding that passes", {}, { findings: [good()] }],
  ["only a nit", {}, { findings: [good({ severity: "nit" })] }],
  ["a low finding under a medium minimum", { autoPost: { minSeverity: "medium" } }, { findings: [good({ severity: "low" })] }],
  ["a finding without critic votes", {}, { findings: [good({ consensus: undefined })] }],
  ["a finding the verifier doubts", { verdict: () => ({ stdout: '{"holds": 0.3, "worth_posting": 0.2, "reason": "Unsure."}' }) }, { findings: [good()] }],
  ["a right finding not worth posting", { verdict: () => ({ stdout: '{"holds": 0.9, "worth_posting": 0.3, "reason": "True but minor."}' }) }, { findings: [good()] }],
  ["a description concern", {}, { findings: [good()], assessment: { risk: "low", concerns: [{ kind: "description", text: "Says three rules; has one." }] } }],
  ["a design concern", {}, { findings: [good()], assessment: { risk: "low", concerns: [{ kind: "design", text: "A new default." }] } }],
  ["an older concern with no kind", {}, { findings: [good()], assessment: { risk: "low", concerns: ["Old text."] } }],
  ["no assessment", {}, { findings: [good()], assessment: null }],
  ["high risk", {}, { findings: [good()], assessment: { risk: "high", concerns: [] } }],
  ["a bot author", { view: { author: "renovate[bot]" } }, { findings: [good()] }],
  ["an allowed bot author", { view: { author: "renovate[bot]" }, autoPost: { repos: [{ repo: "acme/*", allowAuthors: ["renovate*"] }] } }, { findings: [good()] }],
  ["a PR over the line limit", { view: { additions: 900, deletions: 10 } }, { findings: [good()] }],
  ["an unsafe summary", {}, { findings: [good()] }],
  ["a held path", { autoPost: { repos: [{ repo: "acme/*", holdPaths: ["docs/*"] }] } }, { findings: [good()] }],
  ["an approve draft", {}, { findings: [], verdict: "approve" }],
  ["an approval with checks running", { view: { checks: "pending" } }, { findings: [], verdict: "approve" }],
  ["an approval with no checks reported", { view: { checks: "none" } }, { findings: [], verdict: "approve" }],
  ["an approval with failed checks", { view: { checks: "failed" } }, { findings: [], verdict: "approve" }],
  ["an approval with changes requested", { view: { review: "changes" } }, { findings: [], verdict: "approve" }],
  ["an approval at medium risk", {}, { findings: [], verdict: "approve", assessment: { risk: "medium", concerns: [] } }],
  ["an approval over its limit", { view: { additions: 300, deletions: 0 } }, { findings: [], verdict: "approve" }],
  ["an approval with a medium finding", {}, { findings: [good()], verdict: "approve" }],
  ["an approval with a couldn't-verify concern", {}, { findings: [], verdict: "approve", assessment: { risk: "low", concerns: [{ kind: "unverified", text: "Tests not run." }] } }],
  ["a comment draft the rules would approve", { autoPost: { minSeverity: "low" } }, { findings: [good({ severity: "low" })] }],
  ["a request for changes", {}, { findings: [good()], verdict: "changes" }],
];

describe("replaying a check under the settings it ran with", () => {
  it.each(CASES)("agrees with the gate on %s", async (name, setup, input) => {
    const { h } = await shadow(setup);
    if (name === "an unsafe summary") {
      const { threadId } = await h.shuttle.review({ key: KEY(3) });
      await h.shuttle.saveDraft(threadId, KEY(3), { summary: "Thanks @sam", verdict: "comment", findings: input.findings as never, assessment: LOW });
    } else await draft(h, input);
    await gatesSettled(h.shuttle);
    const stored = h.shuttle.detail(KEY(3)).draft!;
    const gate = stored.gate!;
    const facts = h.shuttle.autoPostReplay("30d").drafts.find((row) => row.id === stored.id)!;
    const out = replay(facts, replaySettingsOf(h.shuttle.config().autoPost));
    expect(out.posts, name).toBe(gate.decision === "post");
    expect(out.approves, name).toBe(gate.approval?.decision === "approve");
    expect(out.findings.map((f) => f.pass), name).toEqual(gate.findings.map((f) => f.pass));
    expect(facts.exact).toBe(true);
  });
});

describe("replaying a check under other settings", () => {
  // Each pair: the settings a draft was checked with, and the settings it is replayed under; a fresh check under the
  // second must decide the same as the replay.
  const PAIRS: Array<[string, Setup, Setup, Input]> = [
    ["turning off the description concern for comments", {}, { autoPost: { holdConcerns: { comment: ["scope", "other"] } } },
      { findings: [good()], assessment: { risk: "low", concerns: [{ kind: "description", text: "Mismatch." }] } }],
    ["holding comments for design points", {}, { autoPost: { holdConcerns: { comment: ["description", "scope", "design", "other"] } } },
      { findings: [good()], assessment: { risk: "low", concerns: [{ kind: "design", text: "A default." }] } }],
    ["raising the line limit", { view: { additions: 900, deletions: 10 } }, { view: { additions: 900, deletions: 10 }, autoPost: { maxLines: 1000 } }, { findings: [good()] }],
    ["raising the minimum severity", {}, { autoPost: { minSeverity: "high" } }, { findings: [good()] }],
    ["raising the verifier floors", {}, { autoPost: { floors: { holds: 0.95, worth: 0.9 } } }, { findings: [good()] }],
    ["raising only the worth floor", {}, { autoPost: { floors: { holds: 0.7, worth: 0.9 } } }, { findings: [good()] }],
    ["lowering the verifier floors", { verdict: () => ({ stdout: '{"holds": 0.5, "worth_posting": 0.45, "reason": "Maybe."}' }) },
      { verdict: () => ({ stdout: '{"holds": 0.5, "worth_posting": 0.45, "reason": "Maybe."}' }), autoPost: { floors: { holds: 0.4, worth: 0.4 } } }, { findings: [good()] }],
    ["approving with checks still running", { view: { checks: "pending" } }, { view: { checks: "pending" }, autoPost: { approvals: { checks: "not_failed" } } }, { findings: [], verdict: "approve" }],
    ["approving bigger PRs", { view: { additions: 300, deletions: 0 } }, { view: { additions: 300, deletions: 0 }, autoPost: { approvals: { maxLines: 400 } } }, { findings: [], verdict: "approve" }],
    ["approving with a medium finding", {}, { autoPost: { approvals: { maxSeverity: "medium" } } }, { findings: [good()], verdict: "approve" }],
    ["not holding approvals for couldn't-verify concerns", {}, { autoPost: { holdConcerns: { approve: ["description", "scope", "process", "other"] } } },
      { findings: [], verdict: "approve", assessment: { risk: "low", concerns: [{ kind: "unverified", text: "Tests not run." }] } }],
  ];
  it.each(PAIRS)("matches a fresh check after %s", async (name, before, after, input) => {
    const old = await checked(before, input);
    const fresh = await checked(after, input);
    const out = replay(old.facts, fresh.settings);
    expect(out.posts, name).toBe(fresh.gate.decision === "post");
    expect(out.approves, name).toBe(fresh.gate.approval?.decision === "approve");
    // The blocking check reads the diff only once every other approval rule passes, so a replay that newly approves says it has not.
    if (out.approves) expect(out.unchecked, name).toBe(old.gate.approval?.blocking == null);
  });
});

describe("the facts a replay reads", () => {
  it("keeps the PR's checks, review and size with each check", async () => {
    const { gate } = await checked({ view: { checks: "pending", review: "required", additions: 40, deletions: 2 } }, { findings: [good()] });
    expect(gate.facts).toEqual({ checks: "pending", review: "required", size: 42 });
  });

  it("reads an older check without facts from its approval reasons, and keeps what no setting changes", async () => {
    const { h, d } = await checked({ view: { checks: "pending" }, autoPost: { repos: [{ repo: "acme/*", holdPaths: ["docs/*"] }] } }, { findings: [], verdict: "approve" });
    const { facts: _facts, ...older } = parseGate(h.store.draftById(d.id)!.gate)!;
    h.store.setDraftGate(d.id, JSON.stringify(older));
    h.views[3] = { ...h.views[3]!, checks: "passed" } as never;
    await h.shuttle.lookup(KEY(3));
    const facts = h.shuttle.autoPostReplay("30d").drafts[0]!;
    expect(facts).toMatchObject({ exact: false, checks: "pending" });
    expect(facts.kept).toEqual(["it changes docs/readme.md, a path held for you"]);
    expect(facts.keptApproval).toEqual(["it changes docs/readme.md, a path held for you"]);
  });

  it("says what you did with each draft and finding", async () => {
    const { h } = await shadow();
    const posted = await draft(h, { findings: [good(), good({ line: 4, body: "A second race on the counter." })] });
    await h.shuttle.submitReview(KEY(3), { verdict: "approve", body: "LGTM", findings: [{ id: "f1", path: "main.go", line: 5, body: good().body }], draftId: posted.id });
    const replaced = await draft(h, { findings: [good()] });
    await draft(h, { findings: [good()] });
    const rows = h.shuttle.autoPostReplay("30d").drafts;
    expect(rows.map((row) => [row.id, row.you])).toEqual([[replaced.id + 1, "pending"], [replaced.id, "replaced"], [posted.id, "approved"]]);
    expect(rows[2]!.findings.map((f) => f.you)).toEqual(["posted", "dropped"]);
  });

  it("leaves out checks before the range", async () => {
    const { h } = await checked({}, { findings: [good()] });
    h.clock.now += 8 * 86_400_000;
    expect(h.shuttle.autoPostReplay("7d").drafts).toEqual([]);
    expect(h.shuttle.autoPostReplay("30d").drafts).toHaveLength(1);
  });
});

describe("trying settings", () => {
  it("saves only the settings it can try, and the result parses", async () => {
    const { h } = await shadow({ autoPost: { maxComments: 3, verifierTimeoutSeconds: 60, disclosure: "Mine." } });
    const config = h.shuttle.config();
    const mine = replaySettingsOf(config.autoPost);
    const trying = { ...mine, holds: 0.5, checks: "not_failed" as const, holdApprove: mine.holdApprove.filter((k) => k !== "unverified") };
    expect(changedSettings(mine, trying).sort()).toEqual(["checks", "holdApprove", "holds"]);
    const next = withReplaySettings(config.autoPost, trying);
    expect(parseConfig({ ...config, autoPost: next }).autoPost).toEqual({
      ...config.autoPost, floors: { ...config.autoPost.floors, holds: 0.5 }, approvals: { ...config.autoPost.approvals, checks: "not_failed" },
      holdConcerns: { ...config.autoPost.holdConcerns, approve: trying.holdApprove },
    });
    expect(changedSettings(mine, { ...mine, holdComment: [...mine.holdComment].reverse() })).toEqual([]);
  });

  it("adds up a replay: what posts, what you agreed with, and how far the record is from its target", async () => {
    const { facts, settings } = await checked({}, { findings: [good()] });
    expect(summarize([replay(facts, settings)])).toMatchObject({ posts: 1, passing: 1, findingsAgreed: 0, findingsAgainst: 0 });
    expect(wilsonLower(0, 0)).toBeNull();
    expect(neededFor(0, 0, 0.9)).toBe(35);
  });
});

describe("what the reviews found", () => {
  it("never approves in a repository whose approvals are off, and never posts comments where they are off", async () => {
    const off = await checked({ autoPost: { repos: [{ repo: "acme/*", approve: "off" }] } }, { findings: [], verdict: "approve" });
    expect(off.gate.approval).toBeNull();
    expect(off.facts.keptApproval).toEqual(["approvals are off in this repository"]);
    expect(replay(off.facts, off.settings).approves).toBe(false);
    const comments = await checked({ autoPost: { repos: [{ repo: "acme/*", mode: "off", approve: "auto", approvePaths: ["*.go", "docs/*"] }] } }, { findings: [good()] });
    expect(comments.facts.kept).toEqual(["comments are off in this repository"]);
    expect(replay(comments.facts, comments.settings).posts).toBe(false);
  });

  it("holds on what the gate's second read of the PR saw, as the gate does", async () => {
    let s!: Awaited<ReturnType<typeof shadow>>;
    s = await shadow({ autoPost: { minSeverity: "low" }, onVerify: async () => { s.h.views[3] = { ...s.h.views[3]!, checks: "failed" } as never; } });
    const d = await draft(s.h, { findings: [good({ severity: "low" })], verdict: "approve" });
    expect(d.gate!.approval).toMatchObject({ decision: "hold", reasons: ["checks failed"] });
    const facts = s.h.shuttle.autoPostReplay("30d").drafts[0]!;
    expect(facts.checks).toBe("failed");
    expect(replay(facts, replaySettingsOf(s.h.shuttle.config().autoPost)).approves).toBe(false);
  });

  it("reads an older check's checks from the PR as it is now when its reasons say nothing of them", async () => {
    const { h, d } = await checked({ view: { checks: "pending" }, autoPost: { approvals: { checks: "not_failed" } } }, { findings: [], verdict: "approve" });
    const { facts: _facts, ...older } = parseGate(h.store.draftById(d.id)!.gate)!;
    h.store.setDraftGate(d.id, JSON.stringify(older));
    expect(h.shuttle.autoPostReplay("30d").drafts[0]).toMatchObject({ exact: false, checks: "pending" });
  });

  it("takes only the gate's own timing messages as timing, never a concern that mentions new commits", async () => {
    const { facts, settings } = await checked({}, { findings: [good()], assessment: { risk: "low", concerns: [{ kind: "description", text: "There are new commits since the review mentioned in the description." }] } });
    expect(facts.timing).toBeNull();
    expect(replay(facts, { ...settings, holdComment: ["scope", "other"] }).posts).toBe(true);
  });

  it("says when no finding can pass with any setting here, and does not count it as a setting's hold", async () => {
    const { facts, settings } = await checked({}, { findings: [good({ consensus: undefined })] });
    expect(replay(facts, settings).comment).toEqual([{ k: "findings-fixed" }]);
    const tunable = await checked({ verdict: () => ({ stdout: '{"holds": 0.4, "worth_posting": 0.3, "reason": "Unsure."}' }) }, { findings: [good()] });
    expect(replay(tunable.facts, tunable.settings).comment).toEqual([{ k: "findings" }]);
  });

  it("holds a finding that is not on a line, whatever its severity held it for first", async () => {
    const { facts } = await checked({ autoPost: { minSeverity: "medium" } }, { findings: [good({ severity: "low", line: null })] });
    const lowered = replaySettingsOf({ ...(await shadow()).h.shuttle.config().autoPost, minSeverity: "low" });
    expect(replay(facts, lowered).findings[0]!.why.map((w) => w.k)).toContain("no-line");
  });

  it("treats the first version's comment limit as a finding not scored yet, and a post of unknown verdict as posted", async () => {
    const { h, d } = await checked({}, { findings: [good()] });
    const gate = parseGate(h.store.draftById(d.id)!.gate)!;
    h.store.setDraftGate(d.id, JSON.stringify({ ...gate, findings: gate.findings.map((f) => ({ ...f, holds: null, worth: null, pass: false, checks: [{ check: "quality", ok: false, reason: "beyond the 1-comment limit" }] })) }));
    await h.shuttle.submitReview(KEY(3), { verdict: "comment", body: "s", findings: [], draftId: d.id });
    (h.store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): void } } }).db.prepare("UPDATE review_drafts SET posted_verdict = NULL WHERE id = ?").run(d.id);
    const facts = h.shuttle.autoPostReplay("30d").drafts[0]!;
    expect(facts.you).toBe("posted");
    expect(facts.findings[0]).toMatchObject({ other: null, holds: null });
    expect(replay(facts, replaySettingsOf(h.shuttle.config().autoPost)).findings[0]!.why).toEqual([{ k: "unjudged" }]);
  });

  it("leaves out repositories no longer in auto post's settings, and holds approvals where paths are now required but missing", async () => {
    const { h } = await checked({}, { findings: [], verdict: "approve" });
    const config = h.shuttle.config();
    h.shuttle.saveConfig({ ...config, autoPost: { ...config.autoPost, repos: [{ ...config.autoPost.repos[0]!, approve: "countdown" }] } });
    expect(h.shuttle.autoPostReplay("30d").drafts[0]!.keptApproval).toEqual(["no paths are set for approvals to cover"]);
    h.shuttle.saveConfig({ ...config, autoPost: { ...config.autoPost, repos: [{ ...config.autoPost.repos[0]!, repo: "other/*" }] } });
    expect(h.shuttle.autoPostReplay("30d").drafts).toEqual([]);
  });

  it("saves tried settings into the settings as they are now, so a save elsewhere meanwhile stays", async () => {
    const { h } = await shadow();
    const config = h.shuttle.config();
    h.shuttle.saveConfig({ ...config, autoPost: { ...config.autoPost, disclosure: "Saved elsewhere.", maxPerDay: 2 } });
    const saved = h.shuttle.saveAutoPostSettings({ holds: 0.5, checks: "not_failed" });
    expect(saved.autoPost).toEqual({ ...h.shuttle.config().autoPost, disclosure: "Saved elsewhere.", maxPerDay: 2, floors: { ...config.autoPost.floors, holds: 0.5 }, approvals: { ...config.autoPost.approvals, checks: "not_failed" } });
    expect({ ...saved, autoPost: null }).toEqual({ ...config, autoPost: null });
  });
});
