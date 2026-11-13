// @vitest-environment node
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/db/schema";
import { References } from "../src/references";
import { harness, pr } from "./helpers";

async function setup() {
  const h = harness();
  h.lists.authored = [pr(90386, { author: "me" })];
  await h.shuttle.sync();
  h.port.addThread("thr_rollout");
  h.port.projects = [{ id: "proj_app", name: "app", gitRemoteUrl: "https://forge.test/acme/app.git" }];
  const refs = new References(h.shuttle);
  const input = { threadId: "thr_rollout", messageId: "msg_1", text: "PR #90386 is ready.", urls: [] as string[] };
  return { h, refs, input };
}

describe("reference resolution", () => {
  it("uses a cached PR in the exact server/repository, never a global number lookup", async () => {
    const { h, refs, input } = await setup();
    const calls = h.runner.calls.length;
    const [row] = await refs.resolve(input);
    expect(row).toMatchObject({ status: "automatic", url: "https://forge.test/acme/app/pull/90386", reason: "Known PR in this thread’s repository" });
    expect(h.runner.calls.length).toBe(calls);
    expect(await refs.resolve({ ...input, text: "PR #99999" })).toMatchObject([{ status: "unresolved", url: null }]);
    h.port.projects[0]!.gitRemoteUrl = "https://other.test/acme/app.git";
    h.shuttle.invalidateProjects();
    expect(await refs.resolve(input)).toMatchObject([{ status: "flagged", url: null }]);
  });

  it("refuses mixed repositories and conflicting number-specific links", async () => {
    const { refs, input } = await setup();
    expect(await refs.resolve({ ...input, urls: ["https://forge.test/other/repo/pull/12"] })).toMatchObject([{ status: "ambiguous", url: null }]);
    expect(await refs.resolve({ ...input, urls: ["https://forge.test/acme/app/pull/90386", "https://forge.test/other/repo/pull/90386"] })).toMatchObject([{ status: "ambiguous", url: null }]);
    expect(await refs.resolve({ ...input, urls: ["https://forge.test/other/repo/issues/90386"] })).toMatchObject([{ status: "automatic", url: "https://forge.test/other/repo/issues/90386" }]);
  });

  it("skips code, colours, paths and explicitly non-git task numbers", async () => {
    const { refs, input } = await setup();
    expect(await refs.resolve({ ...input, text: "cortex task #1059; handover #1058; colour #282828; `PR #90386`; file.ts#123\n```ui\n#90386\n```" })).toEqual([]);
  });

  it("does not create inferred records for complete URLs or qualified keys", async () => {
    const { refs, input } = await setup();
    expect(await refs.resolve({ ...input, text: "Review https://forge.test/acme/app/pull/90386 (forge:acme/app#90386, head abc123)", urls: ["https://forge.test/acme/app/pull/90386"] })).toEqual([]);
    expect(await refs.resolve({ ...input, text: "acme/app#90386" })).toEqual([]);
    expect(refs.log(20).rows).toEqual([]);
  });

  it("shares flags and corrections across the thread and invalidates them on edits to the first mention", async () => {
    const { h, refs, input } = await setup();
    h.port.addThread("thr_other");
    const [row] = await refs.resolve(input);
    refs.feedback(row!.id, "flag", null);
    expect(await new References(h.shuttle).resolve(input)).toMatchObject([{ status: "flagged", url: null, automaticUrl: row!.url }]);
    refs.feedback(row!.id, "correct", "https://forge.test/other/repo/issues/10");
    expect(await refs.resolve(input)).toMatchObject([{ status: "corrected", url: "https://forge.test/other/repo/issues/10" }]);
    expect(await refs.resolve({ ...input, messageId: "msg_other", text: "Still #90386." })).toMatchObject([{ id: row!.id, status: "corrected", url: "https://forge.test/other/repo/issues/10" }]);
    expect(await refs.resolve({ ...input, threadId: "thr_other", messageId: "msg_other" })).toMatchObject([{ status: "automatic" }]);
    expect(await refs.resolve({ ...input, text: "Changed: PR #90386." })).toMatchObject([{ status: "flagged", url: null }]);
    expect(refs.log(20).events).toHaveLength(2);
    expect(() => refs.feedback(row!.id, "correct", "https://evil.test/a/b/pull/3")).toThrow();
    expect(() => refs.feedback(row!.id, "correct", "javascript:alert(1)")).toThrow();
  });

  it("requires number-specific evidence in mixed-repository text and rejects unknown servers", async () => {
    const { refs, input } = await setup();
    expect(await refs.resolve({ ...input, text: "PR #90386 and forge:other/repo#12" })).toMatchObject([{ number: 90386, status: "ambiguous", url: null }]);
    expect(await refs.resolve({ ...input, text: "PR #90386: forge:acme/app#90386 and forge:other/repo#90386" })).toMatchObject([{ status: "ambiguous", url: null }]);
    expect(await refs.resolve({ ...input, text: "PR #90386: unknown:acme/app#90386" })).toMatchObject([{ status: "unresolved", url: null }]);
  });

  it("uses the archived source thread for helpers and does not silently switch a resolved target", async () => {
    const { h, refs, input } = await setup();
    h.port.addThread("thr_source", "Source", true);
    h.port.children.set("thr_source", [input.threadId]);
    const row = h.shuttle.store.prByKey("forge:acme/app#90386")!;
    h.shuttle.store.link(row.id, "thr_source", "reference");
    expect(await refs.resolve(input)).toMatchObject([{ reason: "PR linked to the source thread" }]);
    const [resolved] = await refs.resolve({ ...input, messageId: "msg_other" });
    refs.feedback(resolved!.id, "correct", "https://forge.test/other/repo/issues/10");
    expect(await refs.resolve({ ...input, text: "Edited PR #90386" })).toMatchObject([{ status: "flagged", url: null }]);
  });

  it("rechecks context before reusing a persisted correction", async () => {
    const { h, refs, input } = await setup();
    const [row] = await refs.resolve(input);
    refs.feedback(row!.id, "correct", "forge:acme/app#90386");
    h.port.projects[0]!.gitRemoteUrl = "https://other.test/other/repo.git";
    h.shuttle.invalidateProjects();
    expect(await refs.resolve(input)).toMatchObject([{ status: "flagged", url: null }]);
  });

  it("does not infer an HTTP target from a project using a different port", async () => {
    const { h, refs, input } = await setup();
    h.port.projects[0]!.gitRemoteUrl = "https://forge.test:8443/acme/app.git";
    h.shuttle.invalidateProjects();
    expect(await refs.resolve(input)).toMatchObject([{ status: "unresolved", url: null }]);
  });

  it("deduplicates equivalent URLs by target identity", async () => {
    const { refs, input } = await setup();
    expect(await refs.resolve({ ...input, urls: ["https://forge.test/acme/app/pull/90386", "https://forge.test/acme/app/pull/90386/", "https://forge.test/acme/app/pull/90386/files"] })).toMatchObject([{ status: "automatic", url: "https://forge.test/acme/app/pull/90386" }]);
  });

  it.each(["flag", "suppress"] as const)("never silently restores a %s after context changes", async (action) => {
    const { h, refs, input } = await setup();
    const [row] = await refs.resolve(input);
    refs.feedback(row!.id, action, null);
    h.port.projects[0]!.gitRemoteUrl = "https://other.test/other/repo.git";
    h.shuttle.invalidateProjects();
    expect(await refs.resolve(input)).toMatchObject([{ status: "flagged", url: null }]);
  });

  it("uses the same issue target regardless of equivalent candidate order", async () => {
    const { refs, input } = await setup();
    const urls = ["https://forge.test/acme/app/issues/90386", "http://forge.test/acme/app/issues/90386"];
    const first = await refs.resolve({ ...input, urls });
    const second = await refs.resolve({ ...input, urls: [...urls].reverse() });
    expect(second).toEqual(first);
  });

  it.each(["confirm", "dismiss"] as const)("persists %s and hides it from pending without removing its target", async (action) => {
    const { h, refs, input } = await setup();
    const [row] = await refs.resolve(input);
    const result = refs.feedback(row!.id, action, null);
    expect(result).toMatchObject({ status: action === "confirm" ? "confirmed" : "dismissed", url: row!.url });
    expect(await new References(h.shuttle).resolve(input)).toMatchObject([{ status: result.status }]);
    expect(refs.log(20, { filter: "pending" }).rows).toEqual([]);
    expect(refs.log(20, { filter: "handled" }).rows).toHaveLength(1);
    expect(await refs.resolve({ ...input, text: "Edited PR #90386" })).toMatchObject([{ status: "flagged", url: null }]);
  });

  it("refuses to confirm a reference with no target", async () => {
    const { refs, input } = await setup();
    const [row] = await refs.resolve({ ...input, text: "PR #99999" });
    expect(() => refs.feedback(row!.id, "confirm", null)).toThrow("no target");
  });

  it("searches before paginating and filters handled decisions", async () => {
    const { h, refs, input } = await setup();
    h.port.addThread("thr_other");
    await refs.resolve({ ...input, messageId: "msg_a", text: "PR #90386 alpha" });
    await refs.resolve({ ...input, threadId: "thr_other", messageId: "msg_b", text: "PR #90386 beta" });
    const first = refs.log(1, { query: "alpha", filter: "pending" });
    expect(first.filteredTotal).toBe(1);
    expect(first.rows[0]!.excerpt).toContain("alpha");
    expect(refs.log(1, { query: "alpha 90386", filter: "pending" }).filteredTotal).toBe(1);
    expect(refs.log(1, { query: "ALPHA\t90386", filter: "pending" }).filteredTotal).toBe(1);
    expect(refs.log(1, { query: "alpha missing", filter: "pending" }).filteredTotal).toBe(0);
    expect(refs.log(1, { offset: 1, filter: "pending" }).rows).toHaveLength(1);
  });

  it("deduplicates re-renders and suppresses a mistaken reference until reset", async () => {
    const { refs, input } = await setup();
    const [row] = await refs.resolve(input);
    await refs.resolve(input);
    expect(refs.log(20).rows).toHaveLength(1);
    refs.feedback(row!.id, "suppress", null);
    expect(await refs.resolve(input)).toMatchObject([{ status: "suppressed", url: null }]);
    refs.feedback(row!.id, "reset", null);
    expect(await refs.resolve(input)).toMatchObject([{ status: "automatic" }]);
  });

  it("keeps one record per thread and number however many messages mention it", async () => {
    const { h, refs, input } = await setup();
    h.port.addThread("thr_other");
    const [first] = await refs.resolve(input);
    const [second] = await refs.resolve({ ...input, messageId: "msg_2", text: "Merged #90386 after CI." });
    const [third] = await refs.resolve({ ...input, messageId: "msg_3", text: "#90386 is deployed." });
    expect(second!.id).toBe(first!.id);
    expect(third).toEqual(first);
    expect(refs.log(20).rows).toEqual([expect.objectContaining({ id: first!.id, messageId: "msg_1", excerpt: input.text })]);
    refs.feedback(third!.id, "confirm", null);
    expect(await refs.resolve({ ...input, messageId: "msg_4", text: "Again #90386." })).toMatchObject([{ id: first!.id, status: "confirmed" }]);
    expect(await refs.resolve({ ...input, threadId: "thr_other" })).toMatchObject([{ status: "automatic" }]);
    expect(refs.log(20).total).toBe(2);
  });

  it("lets a later message supply the target a first mention could not find", async () => {
    const { h, refs, input } = await setup();
    expect(await refs.resolve({ ...input, text: "PR #12 is next." })).toMatchObject([{ status: "unresolved", url: null }]);
    h.port.invalidations.length = 0;
    expect(await refs.resolve({ ...input, messageId: "msg_2", text: "Opened #12.", urls: ["https://forge.test/acme/app/pull/12"] })).toMatchObject([{ status: "automatic", url: "https://forge.test/acme/app/pull/12", messageId: "msg_2" }]);
    expect(h.port.invalidations).toEqual([["references", "reference-log"]]);
    expect(await refs.resolve({ ...input, text: "PR #12 is next." })).toMatchObject([{ status: "automatic", url: "https://forge.test/acme/app/pull/12" }]);
    expect(refs.log(20).total).toBe(1);
  });

  it("resolves an ambiguous first mention only from an explicit link in a later message", async () => {
    const { refs, input } = await setup();
    expect(await refs.resolve({ ...input, text: "PR #90386 and forge:other/repo#12" })).toMatchObject([{ status: "ambiguous", url: null }]);
    expect(await refs.resolve({ ...input, messageId: "msg_2" })).toMatchObject([{ status: "ambiguous", url: null }]);
    expect(await refs.resolve({ ...input, messageId: "msg_3", urls: ["https://forge.test/acme/app/pull/90386"] })).toMatchObject([{ status: "automatic", url: "https://forge.test/acme/app/pull/90386", messageId: "msg_3" }]);
  });

  it("leaves a later mention plain when its own message links the number elsewhere", async () => {
    const { refs, input } = await setup();
    const [row] = await refs.resolve(input);
    expect(await refs.resolve({ ...input, messageId: "msg_2", urls: ["https://forge.test/other/repo/pull/90386"] })).toEqual([]);
    expect(await refs.resolve({ ...input, messageId: "msg_2", urls: ["https://forge.test/acme/app/pull/90386"] })).toEqual([row]);
    expect(refs.log(20).rows).toMatchObject([{ id: row!.id, messageId: "msg_1", url: "https://forge.test/acme/app/pull/90386" }]);
    expect(refs.log(20).total).toBe(1);
  });

  it("never shows a shared target on a server that was disabled since", async () => {
    const { h, refs, input } = await setup();
    await refs.resolve(input);
    h.shuttle.store.saveConfig({ ...h.shuttle.config(), servers: h.shuttle.config().servers.map((server) => ({ ...server, enabled: false })) });
    expect(await refs.resolve({ ...input, messageId: "msg_2" })).toEqual([]);
  });
});

describe("the one-record-per-thread migration", () => {
  it("clears the per-message reference log and its feedback, and nothing else", () => {
    const db = new Database(":memory:");
    const first = MIGRATIONS.indexOf("DELETE FROM reference_feedback");
    expect(first).toBeGreaterThan(0);
    for (const sql of MIGRATIONS.slice(0, first)) db.exec(sql);
    db.exec("INSERT INTO reference_resolutions (id, thread_id, message_id, text_hash, value, updated_at) VALUES ('a', 'thr_a', 'msg_1', 'h', '{}', 0), ('b', 'thr_a', 'msg_2', 'h', '{}', 0)");
    db.exec("INSERT INTO reference_feedback (reference_id, action, before_url, after_url, at) VALUES ('a', 'confirm', null, 'u', 0)");
    db.exec("INSERT INTO threads (id, title, updated_at) VALUES ('thr_a', 'A', 0)");
    for (const sql of MIGRATIONS.slice(first)) db.exec(sql);
    expect(db.prepare("SELECT count(*) AS n FROM reference_resolutions").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM reference_feedback").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT id FROM threads").all()).toEqual([{ id: "thr_a" }]);
  });
});
