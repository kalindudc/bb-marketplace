// @vitest-environment node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { configToToml } from "../src/config";
import { MIGRATIONS } from "../src/db/schema";
import { Store } from "../src/db/store";
import { nextStep, ruleMatches, type NextFacts } from "../src/next";
import { createShuttlePlugin } from "../server";
import { FakePort, fakeRunner, harness, pr, testConfig } from "./helpers";

const KEY = (n: number) => `forge:shop/world#${n}`;
const OTHER = "forge:shop/other#3";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

/** Two requests by name after the first sync, so both are fresh Inbox requests; and a ready PR of yours. */
async function inboxOfThree() {
  const h = harness(testConfig({ autoReview: { enabled: false, when: ["requested"], drafts: false, preset: "", repos: [], maxPerDay: 8, rerun: "never" } }));
  await h.shuttle.sync();
  h.clock.now += HOUR;
  h.lists.authored = [pr(1, { author: "me", review: "approved" })];
  h.lists.review_requested = [pr(2, { author: "dana" }), pr(3, { author: "sam", repo: "shop/other" })];
  await h.shuttle.sync();
  return h;
}

describe("the inbox migration", () => {
  it("renames the snooze's start, keeps snoozes, and counts every PR stored before the upgrade as seen", () => {
    const db = new Database(":memory:");
    const first = MIGRATIONS.indexOf("ALTER TABLE prs RENAME COLUMN dismissed_at TO snoozed_at");
    expect(first).toBeGreaterThan(0);
    for (const sql of MIGRATIONS.slice(0, first)) db.exec(sql);
    const insert = db.prepare("INSERT INTO prs (key, server, repo, number, url, title, author, state, checks, review, mine, fetched_at, updated_at, dismissed_at, snoozed_until) VALUES (?, 'forge', 'shop/world', ?, 'u', 't', 'a', 'open', 'none', 'none', 0, ?, ?, ?, ?)");
    insert.run(KEY(1), 1, 50, 100, 120, 900);
    insert.run(KEY(2), 2, 70, null, null, null);
    for (const sql of MIGRATIONS.slice(first)) db.exec(sql);
    expect(db.prepare("SELECT key, snoozed_at, snoozed_until, inbox_dismissed_at, seen_at FROM prs ORDER BY id").all()).toEqual([
      { key: KEY(1), snoozed_at: 120, snoozed_until: 900, inbox_dismissed_at: null, seen_at: 100 },
      { key: KEY(2), snoozed_at: null, snoozed_until: null, inbox_dismissed_at: null, seen_at: 70 },
    ]);
    expect(db.prepare("SELECT * FROM inbox_rules").all()).toEqual([]);
    const store = new Store(db, () => 1000);
    expect(store.prByKey(KEY(1))).toMatchObject({ snoozed_at: 120, seen_at: 100 });
    expect(store.addInboxRule("author", "forge", "dana")).toMatchObject({ id: 1, kind: "author", server: "forge", value: "dana", created_at: 1000 });
  });
});

describe("rule matching", () => {
  const theirs = { mine: false, server: "forge", author: "dana", repo: "shop/world", reasons: ["mentioned" as const] };
  it("matches an author's PRs except yours, a repo's PRs including yours, and mentions where you are not asked by name", () => {
    expect(ruleMatches({ kind: "author", server: "forge", value: "dana" }, theirs)).toBe(true);
    expect(ruleMatches({ kind: "author", server: "other", value: "dana" }, theirs)).toBe(false);
    expect(ruleMatches({ kind: "author", server: "forge", value: "dana" }, { ...theirs, mine: true })).toBe(false);
    expect(ruleMatches({ kind: "repo", server: "forge", value: "shop/world" }, { ...theirs, mine: true })).toBe(true);
    expect(ruleMatches({ kind: "repo", server: "forge", value: "shop/other" }, theirs)).toBe(false);
    expect(ruleMatches({ kind: "repo", server: "other", value: "shop/world" }, theirs)).toBe(false);
    expect(ruleMatches({ kind: "mention", server: "forge", value: "shop/world" }, theirs)).toBe(true);
    expect(ruleMatches({ kind: "mention", server: "forge", value: "shop/world" }, { ...theirs, reasons: ["mentioned", "team"] })).toBe(true);
    expect(ruleMatches({ kind: "mention", server: "forge", value: "shop/world" }, { ...theirs, reasons: ["mentioned", "requested"] })).toBe(false);
    expect(ruleMatches({ kind: "mention", server: "forge", value: "shop/world" }, { ...theirs, reasons: ["team"] })).toBe(false);
    expect(ruleMatches({ kind: "mention", server: "forge", value: "shop/world" }, { ...theirs, mine: true })).toBe(false);
    expect(ruleMatches({ kind: "mention", server: "forge", value: "shop/other" }, theirs)).toBe(false);
  });
});

describe("the next step of a PR kept out of the Inbox", () => {
  const facts = (patch: Partial<NextFacts>): NextFacts => ({
    now: Date.parse("2026-10-23T12:00:00Z"), mine: true, state: "open", checks: "passed", checkCounts: null, review: "approved", head: "h1", author: "me",
    createdAt: null, updatedAt: null, reviewers: [], agent: null, suggestedAgent: null, handled: false, autoMerge: false, snoozed: false, keptOut: false,
    can: { merge: true, comment: true, ready: true, reopen: true, cancelAutoMerge: false, approve: true },
    reasons: [], teams: [], tracked: false, bot: false, requestedAt: null, lastReview: null, lastReviewFinishedAt: null, lastReviewHandled: false,
    draft: null, myReview: null, additions: 1, deletions: 1, files: 1, inboxRequests: true, inboxRequestDays: 3, ...patch,
  });
  it("keeps its step and turns only the Inbox off, like a snooze", () => {
    expect(nextStep(facts({}))).toMatchObject({ kind: "ready_to_merge", inbox: true });
    expect(nextStep(facts({ keptOut: true }))).toMatchObject({ kind: "ready_to_merge", inbox: false, primary: { id: "merge" } });
    expect(nextStep(facts({ snoozed: true }))).toMatchObject({ kind: "ready_to_merge", inbox: false });
  });
});

describe("snoozing", () => {
  it("reports a snooze until it changes as snoozed, which snoozedUntil alone could not", async () => {
    const h = await inboxOfThree();
    const [view] = h.shuttle.snooze([KEY(1)], "update");
    expect(view).toMatchObject({ key: KEY(1), snoozed: true, snoozedUntil: null, next: { inbox: false } });
    const later = h.clock.now + 3 * HOUR;
    expect(h.shuttle.snooze([KEY(2)], later)[0]).toMatchObject({ snoozed: true, snoozedUntil: later });
    expect(h.shuttle.view(OTHER)).toMatchObject({ snoozed: false, snoozedUntil: null });
    expect(h.store.events({ kinds: ["snoozed"], limit: 5 }).map((e) => e.text)).toEqual([
      expect.stringMatching(/^Snoozed shop\/world#2 until \w{3} \d+ \w{3}, \d+:\d\d\.$/u),
      "Snoozed shop/world#1 until it changes.",
    ]);
    h.clock.now += 4 * HOUR;
    expect(h.shuttle.view(KEY(2))).toMatchObject({ snoozed: false, snoozedUntil: null, next: { inbox: true } });
    h.shuttle.snooze([KEY(1)], null);
    expect(h.shuttle.view(KEY(1))).toMatchObject({ snoozed: false, next: { inbox: true } });
  });

  it("refuses a time in the past or more than 60 days ahead, and unknown keys, changing nothing", async () => {
    const h = await inboxOfThree();
    expect(() => h.shuttle.snooze([KEY(1)], h.clock.now - 1)).toThrow(/future/u);
    expect(() => h.shuttle.snooze([KEY(1)], h.clock.now)).toThrow(/future/u);
    expect(() => h.shuttle.snooze([KEY(1)], h.clock.now + 61 * DAY)).toThrow(/60 days/u);
    expect(h.shuttle.snooze([KEY(1)], h.clock.now + 60 * DAY)[0]!.snoozed).toBe(true);
    h.shuttle.snooze([KEY(1)], null);
    expect(() => h.shuttle.snooze([KEY(2), KEY(99)], "update")).toThrow(/forge:shop\/world#99/u);
    expect(h.shuttle.view(KEY(2)).snoozed).toBe(false);
  });

  it("snoozes several PRs at once and returns them in order", async () => {
    const h = await inboxOfThree();
    const out = h.shuttle.snooze([OTHER, KEY(2)], "update");
    expect(out.map((view) => [view.key, view.snoozed])).toEqual([[OTHER, true], [KEY(2), true]]);
    expect(h.shuttle.inbox().prs.map((view) => view.key)).toEqual([KEY(1)]);
  });
});

describe("dismissing", () => {
  it("keeps a PR out for good, even when it changes, flags its new activity, and Restore brings it back", async () => {
    const h = await inboxOfThree();
    h.shuttle.snooze([KEY(2)], "update");
    const [view] = h.shuttle.dismiss([KEY(2)], true);
    expect(view).toMatchObject({ dismissed: { at: h.clock.now, activity: false }, snoozed: false, keptOutBy: null, next: { kind: "new_request", inbox: false } });
    expect(h.store.prByKey(KEY(2))).toMatchObject({ snoozed_at: null, snoozed_until: null, inbox_dismissed_at: h.clock.now });
    h.clock.now += 30 * DAY;
    h.lists.review_requested = [pr(2, { author: "dana", updated_at: iso(h.clock.now - HOUR) }), pr(3, { author: "sam", repo: "shop/other" })];
    await h.shuttle.sync();
    expect(h.shuttle.view(KEY(2))).toMatchObject({ dismissed: { activity: true }, next: { inbox: false } });
    expect(h.shuttle.inbox().dismissed.map((v) => v.key)).toEqual([KEY(2)]);
    h.shuttle.dismiss([KEY(2)], false);
    expect(h.shuttle.view(KEY(2)).dismissed).toBeNull();
    expect(h.store.events({ kinds: ["dismissed", "restored"], limit: 5 }).map((e) => e.text)).toEqual(["shop/world#2 is back in the Inbox.", "Dismissed shop/world#2 from the Inbox."]);
  });

  it("refuses the whole call when one key is unknown", async () => {
    const h = await inboxOfThree();
    expect(() => h.shuttle.dismiss([KEY(1), KEY(99)], true)).toThrow(/forge:shop\/world#99/u);
    expect(h.shuttle.view(KEY(1)).dismissed).toBeNull();
  });

  it("survives a review starting and a draft landing, which clear only a snooze", async () => {
    const h = await inboxOfThree();
    h.views[2] = pr(2, { author: "dana" });
    h.shuttle.dismiss([KEY(2)], true);
    h.shuttle.snooze([KEY(2)], "update");
    const { threadId } = await h.shuttle.review({ key: KEY(2) });
    expect(h.shuttle.view(KEY(2))).toMatchObject({ snoozed: false, dismissed: { activity: false } });
    h.shuttle.snooze([KEY(2)], "update");
    await h.shuttle.saveDraft(threadId, KEY(2), { summary: "s", verdict: "comment", findings: [] });
    expect(h.shuttle.view(KEY(2))).toMatchObject({ snoozed: false, dismissed: { activity: false }, next: { kind: "post", inbox: false } });
  });
});

describe("seen", () => {
  it("marks a PR stored after the upgrade as new until it is opened, and again when it changes", async () => {
    const h = await inboxOfThree();
    expect(h.shuttle.view(KEY(2)).unseen).toBe(true);
    h.shuttle.markSeen([KEY(2), OTHER]);
    expect(h.shuttle.view(KEY(2)).unseen).toBe(false);
    expect(h.shuttle.view(KEY(1)).unseen).toBe(true);
    expect(h.store.events({ limit: 50 }).some((e) => e.text.includes("seen"))).toBe(false);
    h.clock.now += HOUR;
    h.lists.review_requested = [pr(2, { author: "dana", updated_at: iso(h.clock.now) }), pr(3, { author: "sam", repo: "shop/other" })];
    await h.shuttle.sync();
    expect(h.shuttle.view(KEY(2)).unseen).toBe(true);
    expect(h.shuttle.view(OTHER).unseen).toBe(false);
    expect(() => h.shuttle.markSeen([KEY(99)])).toThrow(/forge:shop\/world#99/u);
  });

  it("is never touched by a sync, nor are a snooze and a dismissal", async () => {
    const h = await inboxOfThree();
    h.shuttle.markSeen([KEY(2)]);
    h.shuttle.dismiss([KEY(2)], true);
    h.shuttle.snooze([KEY(2)], "update");
    const before = h.store.prByKey(KEY(2))!;
    h.clock.now += HOUR;
    h.lists.review_requested = [pr(2, { author: "dana", title: "Renamed", updated_at: iso(h.clock.now) })];
    await h.shuttle.sync();
    const after = h.store.prByKey(KEY(2))!;
    expect(after.title).toBe("Renamed");
    expect([after.seen_at, after.inbox_dismissed_at, after.snoozed_at, after.snoozed_until]).toEqual([before.seen_at, before.inbox_dismissed_at, before.snoozed_at, before.snoozed_until]);
  });
});

describe("rules", () => {
  it("keeps every PR by an author out of the Inbox, and lists what it keeps out", async () => {
    const h = await inboxOfThree();
    const { rule, created } = h.shuttle.inboxRuleAdd({ kind: "author", server: "forge", value: "dana" });
    expect(created).toBe(true);
    expect(rule).toMatchObject({ kind: "author", server: "forge", serverName: "Forge", value: "dana", createdAt: h.clock.now, keeps: [KEY(2)] });
    expect(h.shuttle.view(KEY(2))).toMatchObject({ keptOutBy: rule.id, next: { inbox: false } });
    expect(h.shuttle.inbox().prs.map((v) => v.key)).toEqual([KEY(1), OTHER]);
    expect(h.shuttle.inboxRuleAdd({ kind: "author", server: "forge", value: "dana" })).toMatchObject({ rule: { id: rule.id }, created: false });
    expect(h.store.events({ kinds: ["inbox_rule"], limit: 5 })).toHaveLength(1);
    h.shuttle.inboxRuleRemove(rule.id);
    expect(h.shuttle.view(KEY(2))).toMatchObject({ keptOutBy: null, next: { inbox: true } });
    expect(h.shuttle.inbox().rules).toEqual([]);
    expect(h.store.events({ kinds: ["inbox_rule"], limit: 5 })).toHaveLength(2);
    expect(() => h.shuttle.inboxRuleRemove(rule.id)).toThrow(/no Inbox rule/u);
  });

  it("keeps a repo's PRs out, yours too, but leaves dismissed and snoozed PRs out of what it keeps", async () => {
    const h = await inboxOfThree();
    h.shuttle.dismiss([KEY(2)], true);
    const { rule } = h.shuttle.inboxRuleAdd({ kind: "repo", server: "forge", value: "shop/world" });
    expect(rule.keeps).toEqual([KEY(1)]);
    expect(h.shuttle.view(KEY(1)).keptOutBy).toBe(rule.id);
    expect(h.shuttle.view(KEY(2)).keptOutBy).toBe(rule.id);
    expect(h.shuttle.inbox().prs.map((v) => v.key)).toEqual([OTHER]);
  });

  it("keeps mentions out unless you are asked by name", async () => {
    const h = harness(testConfig({ autoReview: { enabled: false, when: ["requested"], drafts: false, preset: "", repos: [], maxPerDay: 8, rerun: "never" } }));
    await h.shuttle.sync();
    h.clock.now += HOUR;
    h.lists.mentioned = [pr(4, { author: "dana" }), pr(5, { author: "dana" })];
    h.lists.review_requested = [pr(5, { author: "dana" })];
    await h.shuttle.sync();
    const { rule } = h.shuttle.inboxRuleAdd({ kind: "mention", server: "forge", value: "shop/world" });
    expect(rule.keeps).toEqual([KEY(4)]);
    expect(h.shuttle.inbox().prs.map((v) => v.key)).toEqual([KEY(5)]);
  });

  it("refuses a server that is not configured, and lists rules newest first", async () => {
    const h = await inboxOfThree();
    expect(() => h.shuttle.inboxRuleAdd({ kind: "repo", server: "nowhere", value: "shop/world" })).toThrow(/no server called nowhere/u);
    const { rule: a } = h.shuttle.inboxRuleAdd({ kind: "author", server: "forge", value: "nobody" });
    h.clock.now += 1000;
    const { rule: b } = h.shuttle.inboxRuleAdd({ kind: "repo", server: "forge", value: "shop/none" });
    expect(h.shuttle.inbox().rules.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(h.shuttle.inbox().rules[1]).toMatchObject({ keeps: [] });
  });
});

describe("the Inbox read", () => {
  it("lists snoozed PRs soonest back first, dismissed PRs newest first, and counts what automation did", async () => {
    const h = await inboxOfThree();
    h.shuttle.snooze([KEY(1)], "update");
    h.shuttle.snooze([KEY(2)], h.clock.now + 5 * HOUR);
    h.shuttle.snooze([OTHER], h.clock.now + 2 * HOUR);
    let inbox = h.shuttle.inbox();
    expect(inbox.prs).toEqual([]);
    expect(inbox.snoozed.map((v) => v.key)).toEqual([OTHER, KEY(2), KEY(1)]);
    expect(inbox.dismissed).toEqual([]);
    h.shuttle.dismiss([OTHER], true);
    h.clock.now += 1000;
    h.shuttle.dismiss([KEY(1)], true);
    inbox = h.shuttle.inbox();
    expect(inbox.snoozed.map((v) => v.key)).toEqual([KEY(2)]);
    expect(inbox.dismissed.map((v) => v.key)).toEqual([KEY(1), OTHER]);
    expect(Object.keys(inbox).sort()).toEqual(["dismissed", "handled", "olderRequests", "prs", "rules", "snoozed"]);
    expect(inbox.handled).toBe(0);
    for (let i = 0; i < 12; i++) h.store.addEvent("forwarded", `Sent ${i}`);
    h.store.addEvent("tracked", "Not automation");
    expect(h.shuttle.inbox().handled).toBe(12);
    h.clock.now += DAY + 1;
    expect(h.shuttle.inbox().handled).toBe(0);
  });

  it("leaves a dismissed PR that merged out of the Dismissed list", async () => {
    const h = await inboxOfThree();
    h.shuttle.dismiss([KEY(1)], true);
    h.lists.authored = [pr(1, { author: "me", state: "merged" })];
    await h.shuttle.sync();
    expect(h.shuttle.inbox().dismissed).toEqual([]);
  });
});

describe("the Inbox RPCs", () => {
  async function boot() {
    const port = new FakePort();
    const runner = fakeRunner((operation) => {
      if (operation === "whoami") return { login: "me" };
      if (operation === "authored") return [pr(1, { author: "me", review: "approved" })];
      if (operation === "activity") return { items: [] };
      return [];
    });
    const host = createFakePluginHost({ pluginId: "shuttle", dataDir: mkdtempSync(join(tmpdir(), "shuttle-")) });
    await createShuttlePlugin({ port: () => port, runner, tickMs: 3_600_000 })(host.bb);
    const { behavior, lifecycle } = host.harness;
    await behavior.callRpc("importToml", { toml: configToToml(testConfig()), apply: true });
    await behavior.callRpc("sync", {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { port, behavior, lifecycle };
  }

  it("serves snooze, dismiss, markSeen and rules, refusing bad input with plain messages", async () => {
    const { port, behavior, lifecycle } = await boot();
    const publishes = port.publishes;
    const snoozed = (await behavior.callRpc("snooze", { keys: [KEY(1)], until: "update" })) as { prs: Array<{ key: string; snoozed: boolean }> };
    expect(snoozed.prs).toMatchObject([{ key: KEY(1), snoozed: true }]);
    await expect(behavior.callRpc("snooze", { keys: [KEY(1)], until: 1 })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("future") });
    await expect(behavior.callRpc("snooze", { keys: [KEY(1)], until: "tomorrow" })).rejects.toThrow();
    await expect(behavior.callRpc("snooze", { keys: [], until: null })).rejects.toThrow();
    await expect(behavior.callRpc("snooze", { keys: [KEY(9)], until: null })).rejects.toMatchObject({ code: "not_found" });
    const dismissed = (await behavior.callRpc("dismiss", { keys: [KEY(1)], on: true })) as { prs: Array<{ dismissed: unknown }> };
    expect(dismissed.prs[0]!.dismissed).toMatchObject({ activity: false });
    expect(await behavior.callRpc("markSeen", { keys: [KEY(1)] })).toEqual({ ok: true });
    const added = (await behavior.callRpc("inboxRuleAdd", { kind: "repo", server: "forge", value: "shop/world" })) as { rule: { id: number; keeps: string[] }; created: boolean };
    expect(added).toMatchObject({ rule: { keeps: [] }, created: true });
    expect(await behavior.callRpc("inboxRuleAdd", { kind: "repo", server: "forge", value: "shop/world" })).toMatchObject({ rule: { id: added.rule.id }, created: false });
    await expect(behavior.callRpc("inboxRuleAdd", { kind: "repo", server: "nowhere", value: "x" })).rejects.toMatchObject({ code: "invalid" });
    await expect(behavior.callRpc("inboxRuleAdd", { kind: "repo", server: "forge", value: "" })).rejects.toThrow();
    await expect(behavior.callRpc("inboxRuleAdd", { kind: "team", server: "forge", value: "x" })).rejects.toThrow();
    const inbox = (await behavior.callRpc("inbox", {})) as { rules: Array<{ id: number }>; dismissed: Array<{ key: string }> };
    expect(inbox.rules.map((r) => r.id)).toEqual([added.rule.id]);
    expect(inbox.dismissed.map((v) => v.key)).toEqual([KEY(1)]);
    expect(await behavior.callRpc("inboxRuleRemove", { id: added.rule.id })).toEqual({ ok: true });
    await expect(behavior.callRpc("inboxRuleRemove", { id: added.rule.id })).rejects.toMatchObject({ code: "not_found" });
    expect(port.publishes - publishes).toBe(5);
    await lifecycle.dispose();
  });
});
