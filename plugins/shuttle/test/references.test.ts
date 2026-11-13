// @vitest-environment node
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { MIGRATIONS } from "../src/db/schema";
import { References } from "../src/references";
import { searchIndex } from "../src/search";
import { inboxCandidates } from "../src/views";
import { harness, pr, type Harness } from "./helpers";

/** A thread of its own in the same project, for a case that must not share the record of #90386 in another. */
function inThread(h: Harness, input: { threadId: string; messageId: string; text: string; urls: string[] }, threadId: string) {
  h.port.addThread(threadId);
  return { ...input, threadId };
}

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
  it("does not read every cached PR to resolve bare numbers", async () => {
    const { h, refs, input } = await setup();
    const allPrs = vi.spyOn(h.store, "allPrs");
    expect(await refs.resolve({ ...input, text: "PR #90386 and #99999" })).toMatchObject([
      { number: 90386, status: "automatic", url: "https://forge.test/acme/app/pull/90386" },
      { number: 99999, status: "unresolved", url: null },
    ]);
    expect(allPrs).not.toHaveBeenCalled();
  });

  it("reads keys and repository references written with ! as evidence, never a bare !number", async () => {
    const { h, refs, input } = await setup();
    expect(await refs.resolve({ ...inThread(h, input, "thr_bang_key"), text: "PR #90386, see forge:other/repo!90386" })).toMatchObject([{ status: "automatic", url: "https://forge.test/other/repo/pull/90386", reason: "Explicit reference in this message" }]);
    expect(await refs.resolve({ ...inThread(h, input, "thr_bang_other"), text: "PR #90386, unlike forge:other/repo!12" })).toMatchObject([{ status: "ambiguous", url: null }]);
    expect(await refs.resolve({ ...inThread(h, input, "thr_bang_repo"), text: "PR #90386, unlike other/repo!12" })).toMatchObject([{ status: "ambiguous", url: null }]);
    expect(await refs.resolve({ ...inThread(h, input, "thr_bang_bare"), text: "Ship it!90386 and #90386" })).toMatchObject([{ status: "automatic", url: "https://forge.test/acme/app/pull/90386" }]);
  });

  it("matches a repository named in another case, as GitHub does", async () => {
    const { h, refs, input } = await setup();
    expect(await refs.resolve({ ...inThread(h, input, "thr_case"), text: "#90386 \u2014 see Acme/App#90386" })).toMatchObject([{ status: "automatic", url: "https://forge.test/acme/app/pull/90386" }]);
    expect(await refs.resolve({ ...inThread(h, input, "thr_case_key"), text: "#90386: acme/app#90386 and forge:Acme/App#90386" })).toMatchObject([{ status: "automatic" }]);
  });

  it("shows the thread's record for a later message that names the same repository in another case", async () => {
    const { refs, input } = await setup();
    const [first] = await refs.resolve({ ...input, text: "#90386: acme/app#90386" });
    expect(first).toMatchObject({ status: "automatic", url: "https://forge.test/acme/app/pull/90386" });
    expect(await refs.resolve({ ...input, messageId: "msg_2", text: "#90386, again forge:Acme/App#90386" })).toEqual([first]);
  });

  it("treats two repositories named for one number as a conflict, even when only one has the PR cached", async () => {
    const { refs, input } = await setup();
    expect(await refs.resolve({ ...input, messageId: "msg_uncached", text: "#90386: acme/app#90386 versus other/repo#90386" })).toMatchObject([{ status: "ambiguous", url: null }]);
    expect(await refs.resolve({ ...input, messageId: "msg_link", text: "#90386 versus other/repo#90386", urls: ["https://forge.test/acme/app/pull/90386"] })).toMatchObject([{ status: "ambiguous", url: null }]);
    expect(await refs.resolve({ ...input, messageId: "msg_same", text: "#90386: acme/app#90386, also forge:acme/app#90386", urls: ["https://forge.test/acme/app/pull/90386"] })).toMatchObject([{ status: "automatic", url: "https://forge.test/acme/app/pull/90386" }]);
  });

  it("takes evidence from qualified references past the first hundred", async () => {
    const { refs, input } = await setup();
    const filler = Array.from({ length: 120 }, (_, i) => `#${i + 1}`).join(" ");
    expect(await refs.resolve({ ...input, text: `PR #90386 is ready. ${filler} Not to be confused with forge:other/repo#7.` })).toEqual(expect.arrayContaining([expect.objectContaining({ number: 90386, status: "ambiguous", url: null })]));
  });

  it("takes repository evidence from links to a PR's comment, review, commit or check", async () => {
    const { h, refs, input } = await setup();
    for (const anchored of [
      "https://forge.test/other/repo/pull/90386#discussion_r123",
      "https://forge.test/other/repo/pull/90386#issuecomment-5",
      "https://forge.test/other/repo/pull/90386#pullrequestreview-7",
      "https://forge.test/other/repo/pull/90386/commits/abc1234",
      "https://forge.test/other/repo/pull/90386/checks?check_run_id=9",
    ]) {
      expect(await refs.resolve({ ...inThread(h, input, `thr_${anchored}`), urls: [anchored] }), anchored).toMatchObject([{ status: "automatic", url: "https://forge.test/other/repo/pull/90386", reason: "Explicit reference in this message" }]);
      expect(await refs.resolve({ ...inThread(h, input, `thr_${anchored}_other`), urls: [anchored.replace("90386", "12")] }), anchored).toMatchObject([{ status: "ambiguous", url: null }]);
    }
  });

  it("keeps the PR indexes when resolving an unchanged, saved message", async () => {
    const { h, refs, input } = await setup();
    await refs.resolve(input);
    const version = h.store.version;
    const inbox = inboxCandidates(h.shuttle);
    const search = searchIndex(h.shuttle);
    await refs.resolve(input);
    expect(h.store.version).toBe(version);
    expect(inboxCandidates(h.shuttle)).toBe(inbox);
    expect(searchIndex(h.shuttle)).toBe(search);
  });

  it("keeps the PR indexes when creating and updating reference records", async () => {
    const { h, refs, input } = await setup();
    h.store.saveThread(input.threadId, `Thread ${input.threadId}`, false);
    const version = h.store.version;
    const inbox = inboxCandidates(h.shuttle);
    const search = searchIndex(h.shuttle);
    const [row] = await refs.resolve(input);
    expect(h.store.version).toBe(version);
    await refs.resolve({ ...input, text: "Edited PR #90386" });
    refs.read(row!.id);
    refs.log(20, { query: "Edited", filter: "pending" });
    expect(h.store.version).toBe(version);
    expect(inboxCandidates(h.shuttle)).toBe(inbox);
    expect(searchIndex(h.shuttle)).toBe(search);
  });

  it.each(["confirm", "dismiss", "flag", "correct", "suppress", "reset"] as const)("keeps the PR indexes when recording %s feedback", async (action) => {
    const { h, refs, input } = await setup();
    const [row] = await refs.resolve(input);
    const version = h.store.version;
    const inbox = inboxCandidates(h.shuttle);
    const search = searchIndex(h.shuttle);
    const record = refs.feedback(row!.id, action, action === "correct" ? "forge:other/repo#12" : null);
    expect(refs.read(row!.id)).toEqual(record);
    expect(refs.log(20).events).toMatchObject([{ action, referenceId: row!.id }]);
    expect(h.store.version).toBe(version);
    expect(inboxCandidates(h.shuttle)).toBe(inbox);
    expect(searchIndex(h.shuttle)).toBe(search);
  });

  it.each([
    { title: "Renamed source", archived: false },
    { title: "Thread thr_rollout", archived: true },
  ])("still saves thread changes: %j", async ({ title, archived }) => {
    const { h, refs, input } = await setup();
    await refs.resolve(input);
    h.store.setThreadStatus(input.threadId, "active", true);
    const version = h.store.version;
    h.port.addThread(input.threadId, title, archived);
    await refs.resolve(input);
    expect(h.store.thread(input.threadId)).toMatchObject({ title, archived: archived ? 1 : 0, status: "active", waiting: 1 });
    expect(h.store.version).toBeGreaterThan(version);
  });

  it.each(["getThread", "projects", "referenceContext"] as const)("does not overwrite a newer snapshot after waiting for %s", async (step) => {
    const { h, refs, input } = await setup();
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pause = async <T>(value: Promise<T>): Promise<T> => {
      reached();
      await gate;
      return value;
    };
    if (step === "getThread") {
      const read = h.port.getThread.bind(h.port);
      vi.spyOn(h.port, "getThread").mockImplementationOnce((id) => pause(read(id)));
    } else if (step === "projects") {
      const read = h.shuttle.projects.bind(h.shuttle);
      vi.spyOn(h.shuttle, "projects").mockImplementationOnce(() => pause(read()));
    } else {
      const read = h.port.referenceContext.bind(h.port);
      vi.spyOn(h.port, "referenceContext").mockImplementationOnce((id) => pause(read(id)));
    }
    const older = refs.resolve(input);
    await waiting;
    h.port.addThread(input.threadId, "Latest source");
    const newer = await refs.resolve({ ...input, text: "PR #90386 in forge:other/repo#12" });
    expect(newer).toMatchObject([{ status: "ambiguous", url: null }]);
    const version = h.store.version;
    const publish = vi.spyOn(h.port, "publish");
    release();
    expect(await older).toEqual(newer);
    expect(refs.read(newer[0]!.id)).toEqual(newer[0]);
    expect(h.store.thread(input.threadId)!.title).toBe("Latest source");
    expect(h.store.version).toBe(version);
    expect(publish).not.toHaveBeenCalled();
  });

  it("keeps an older resolution superseded when another starts after the newer one finished", async () => {
    const { h, refs, input } = await setup();
    const releases: Array<(ids: string[]) => void> = [];
    const reached: Array<Promise<void>> = [];
    const hold = () => {
      let arrive!: () => void;
      reached.push(new Promise<void>((resolve) => { arrive = resolve; }));
      return () => { arrive(); return new Promise<string[]>((resolve) => { releases.push(resolve); }); };
    };
    vi.spyOn(h.port, "referenceContext").mockImplementationOnce(hold()).mockImplementationOnce(() => Promise.resolve([input.threadId])).mockImplementationOnce(hold());
    const older = refs.resolve(input);
    await reached[0];
    const newer = await refs.resolve({ ...input, text: "PR #90386 in forge:other/repo#12" });
    expect(newer).toMatchObject([{ status: "ambiguous", url: null }]);
    const latest = refs.resolve({ ...input, text: "PR #90386 in forge:other/repo#12, still" });
    await reached[1];
    releases[0]!([input.threadId]);
    expect(await older).toEqual(newer);
    expect(refs.read(newer[0]!.id)).toEqual(newer[0]);
    releases[1]!([input.threadId]);
    expect(await latest).toMatchObject([{ status: "ambiguous", url: null }]);
  });

  it("supersedes a pending resolution even when the latest text has no bare references", async () => {
    const { h, refs, input } = await setup();
    let release!: (ids: string[]) => void;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    vi.spyOn(h.port, "referenceContext").mockImplementationOnce(() => {
      reached();
      return new Promise<string[]>((resolve) => { release = resolve; });
    });
    const older = refs.resolve(input);
    await waiting;
    expect(await refs.resolve({ ...input, text: "No pull requests remain." })).toEqual([]);
    const version = h.store.version;
    release([input.threadId]);
    expect(await older).toEqual([]);
    expect(refs.log(20).rows).toEqual([]);
    expect(h.store.version).toBe(version);
  });

  it.each(["threadId", "messageId"] as const)("does not supersede another %s's resolution", async (field) => {
    const { h, refs, input } = await setup();
    let release!: (ids: string[]) => void;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    vi.spyOn(h.port, "referenceContext").mockImplementationOnce(() => {
      reached();
      return new Promise<string[]>((resolve) => { release = resolve; });
    });
    const older = refs.resolve(input);
    await waiting;
    h.port.addThread("thr_other");
    // Another message of the same thread shares #90386's record, so it names another number to stay a record of its own.
    const number = field === "threadId" ? 90386 : 90387;
    expect(await refs.resolve({ ...input, [field]: field === "threadId" ? "thr_other" : "msg_other", text: `PR #${number} in forge:other/repo#12` })).toMatchObject([{ number, status: "ambiguous" }]);
    release([input.threadId]);
    expect(await older).toMatchObject([{ threadId: input.threadId, messageId: input.messageId, status: "automatic" }]);
    expect(refs.log(20).rows).toHaveLength(2);
  });

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

  it("distinguishes URL remotes from SCP-style remotes when resolving cached PRs", async () => {
    for (const [remote, status] of [
      ["ssh://git@forge.test:22/acme/app.git", "automatic"],
      ["ssh://git@forge.test:2222/acme/app.git", "automatic"],
      ["ssh://git@forge.test/acme/app.git", "automatic"],
      ["ssh://forge.test:22/acme/app.git", "automatic"],
      ["git@forge.test:acme/app.git", "automatic"],
      ["https://user:password@forge.test/acme/app.git", "automatic"],
      ["https://user:password@forge.test:443/acme/app.git", "automatic"],
      ["https://forge.test/acme/app", "automatic"],
      ["https://forge.test/acme/app.git/", "automatic"],
      ["git://forge.test/acme/app.git", "unresolved"],
      ["git://git@forge.test:9418/acme/app.git", "unresolved"],
      ["https://user:password@forge.test:8443/acme/app.git", "unresolved"],
      ["ssh://git@other.test:22/acme/app.git", "unresolved"],
      ["ssh://git@forge.test:22/other/repo.git", "unresolved"],
    ] as const) {
      const { h, refs, input } = await setup();
      h.port.projects[0]!.gitRemoteUrl = remote;
      h.shuttle.invalidateProjects();
      const calls = h.runner.calls.length;
      expect(await refs.resolve(input), remote).toMatchObject([{ status, url: status === "automatic" ? "https://forge.test/acme/app/pull/90386" : null }]);
      expect(h.runner.calls.length).toBe(calls);
    }
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
