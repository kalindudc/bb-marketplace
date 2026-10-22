import { beforeEach, describe, expect, it } from "vitest";
import { Changes } from "../src/changes";
import type { HostOutput } from "../src/host-contract";
import { runMergeQueue, settleMerges } from "../src/merge";
import { specOf } from "../src/workers";
import { makeCtx, reachApproved, reachReview, seedProject, startWorker, ticketOf, withDocsTicket, type EngineHarness } from "./helpers";

let h: EngineHarness;
let changes: Changes;

beforeEach(() => {
  h = makeCtx();
  changes = new Changes({ store: h.store, bb: h.bb, host: h.host });
});

const project = () => h.store.projectBySlug("csv")!;
const listed = () => h.host.callsTo("changedFiles").map(({ base, head, mergeBase, landed }) => ({ base, head, mergeBase, ...(landed === undefined ? {} : { landed }) }));
const file = (path: string, blob = `blob-${path}`) => ({ path, status: "modified" as const, additions: 2, deletions: 1, binary: false, blob });
const listing = (base: string, head: string, paths: string[]): HostOutput<"changedFiles"> => ({ outcome: "ok", base, head, files: paths.map((path) => file(path)), truncated: false });

/** CSV-1 merged into the integration branch as m1 (from base000), CSV-3 in review, and CSV-2's worker at work. */
async function midProject(): Promise<void> {
  await seedProject(h, withDocsTicket);
  await reachApproved(h, "CSV-1");
  await runMergeQueue(h.ctx, project(), specOf(h.store, project()));
  await settleMerges(h.ctx);
  await reachReview(h, "CSV-3");
  await startWorker(h, "CSV-2");
}

describe("the changes of an integration project", () => {
  it("compares the branch with the remote's base, each merge by its commits, a commit in review with the branch, and a working ticket's worktree", async () => {
    await midProject();
    const head3 = ticketOf(h, "CSV-3").head_sha!;
    const env2 = ticketOf(h, "CSV-2").environment_id!;
    h.host.listings.set("origin/main..refs/heads/loom/csv", listing("base000", "m1", ["src/model/a.ts", "src/shared.ts"]));
    h.host.listings.set("base000..m1", listing("base000", "m1", ["src/model/a.ts"]));
    h.bb.environmentChanges.set(env2, { files: [{ path: "src/export/b.ts", previousPath: null, status: "added", additions: 4, deletions: 0, binary: false, untracked: true }], patches: {} });

    const view = await changes.view("csv");
    expect(view).toMatchObject({ strategy: "integration", base: "main", remoteBase: "origin/main", branch: "loom/csv", finished: false, unavailable: null });
    expect(view.sources.map((source) => [source.id, source.state])).toEqual([
      ["branch", null],
      ["merge:CSV-1", "done"],
      ["live:CSV-2", "working"],
      ["commit:CSV-3", "review"],
    ]);
    expect(listed()).toEqual([
      { base: "origin/main", head: "refs/heads/loom/csv", mergeBase: true },
      { base: "base000", head: "m1", mergeBase: false },
      { base: "loom/csv", head: head3, mergeBase: true },
    ]);
    expect(h.bb.callsTo("environmentFiles")).toEqual([[env2, "loom/csv"]]);

    const [branch, merge, live] = view.sources;
    expect(branch!.files!.map((changed) => [changed.path, changed.tickets])).toEqual([
      ["src/model/a.ts", ["CSV-1"]],
      ["src/shared.ts", []],
    ]);
    expect(branch).toMatchObject({ base: "base000", head: "m1", against: "origin/main", gone: false });
    expect(merge).toMatchObject({ key: "CSV-1", title: "Order rows", against: "loom/csv", base: "base000", head: "m1" });
    expect(merge!.at).not.toBeNull();
    expect(live).toMatchObject({ kind: "live", base: null, head: null, against: "loom/csv" });
    expect(live!.files).toEqual([{ path: "src/export/b.ts", previousPath: null, status: "added", additions: 4, deletions: 0, binary: false, untracked: true, fingerprint: "live:added:4:0", tickets: [] }]);
    expect(merge!.files![0]!.fingerprint).toBe("blob-src/model/a.ts");
  });

  it("says nothing merged yet before the first merge, and no changes yet for a queued ticket, without asking git", async () => {
    await seedProject(h);
    const view = await changes.view("csv");
    expect(view.sources.map((source) => [source.id, source.files, source.note])).toEqual([
      ["branch", [], "Nothing merged yet."],
      ["commit:CSV-1", [], "No changes yet."],
      ["commit:CSV-2", [], "No changes yet."],
    ]);
    expect(h.host.callsTo("changedFiles")).toEqual([]);
  });

  it("reads a finished or archived project's branch from before its first merge to its last, so it works after landing", async () => {
    await midProject();
    h.store.setProjectState(project().id, "archived", "human");
    const view = await changes.view("csv");
    expect(view.finished).toBe(true);
    expect(view.sources[0]).toMatchObject({ id: "branch", against: "loom/csv before its first merge" });
    expect(listed()[0]).toEqual({ base: "base000", head: "m1", mergeBase: false });
  });

  it("marks work whose commits are gone, and keeps reading the rest", async () => {
    await midProject();
    h.host.listings.set("base000..m1", { outcome: "missing", message: "m1 is not in the repository." });
    const view = await changes.view("csv");
    expect(view.sources.find((source) => source.id === "merge:CSV-1")).toMatchObject({ gone: true, files: null, note: "Its commits are no longer in the repository: m1 is not in the repository." });
    expect(view.sources.find((source) => source.id === "branch")).toMatchObject({ gone: false });
  });

  it("falls back to the last commit when the worker's worktree cannot be read", async () => {
    await midProject();
    h.store.updateTicket(ticketOf(h, "CSV-2").id, { head_sha: "c9" });
    const view = await changes.view("csv");
    expect(view.sources.find((source) => source.key === "CSV-2")).toMatchObject({ id: "commit:CSV-2", kind: "commit", base: "loom/csv", head: "c9" });
    expect(listed()).toContainEqual({ base: "loom/csv", head: "c9", mergeBase: true });
  });

  it("says why a host failure left a source empty", async () => {
    await midProject();
    h.host.errors.changedFiles = new Error("host disconnected");
    const view = await changes.view("csv");
    expect(view.sources.find((source) => source.id === "merge:CSV-1")).toMatchObject({ files: null, gone: false, note: "Could not read the changes: host disconnected" });
  });

  it("reads a listing between two full commit hashes once", async () => {
    await seedProject(h);
    const [a, b] = ["a".repeat(40), "b".repeat(40)];
    const ticket = ticketOf(h, "CSV-1");
    h.store.event(project().id, ticket.id, "ticket.state", "loom", { from: "merging", to: "done", outcome: "merged", sha: b, before: a });
    h.host.listings.set(`${a}..${b}`, listing(a, b, ["src/model/a.ts"]));
    const first = await changes.view("csv");
    const second = await changes.view("csv");
    expect(second.sources.find((source) => source.id === "merge:CSV-1")!.files).toEqual(first.sources.find((source) => source.id === "merge:CSV-1")!.files);
    expect(listed().filter((call) => call.base === a && call.head === b)).toHaveLength(1);
    // The live branch is a ref, so it is read every time.
    expect(listed().filter((call) => call.head === "refs/heads/loom/csv")).toHaveLength(2);
  });
});

describe("the changes of a pull request project", () => {
  it("compares each ticket with the remote's base, and a merged ticket with the base before its merge", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr" }));
    await reachReview(h, "CSV-1");
    const head1 = ticketOf(h, "CSV-1").head_sha!;
    h.store.updateTicket(ticketOf(h, "CSV-1").id, { state: "done", environment_id: null });
    const view = await changes.view("csv");
    expect(view).toMatchObject({ strategy: "pr", branch: null });
    expect(view.sources.map((source) => source.id)).toEqual(["commit:CSV-1", "commit:CSV-2"]);
    expect(listed()).toEqual([{ base: "origin/main", head: head1, mergeBase: true, landed: true }]);
  });
});

describe("what cannot be read", () => {
  it("says so for a draft and for a project with no checkout on its machine", async () => {
    await h.projects.propose({ toml: (await import("./helpers")).specToml(), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_1" });
    expect(await changes.view("csv")).toMatchObject({ sources: [], unavailable: "The project has no approved spec yet." });
    await h.projects.approve("csv", "human");
    h.bb.checkout = null;
    expect((await changes.view("csv")).unavailable).toContain("no checkout on the machine host_1");
    h.bb.projectCheckout = async () => Promise.reject(new Error("HTTP 404: Project not found"));
    expect((await changes.view("csv")).unavailable).toBe("The project's checkout cannot be found, so its changes cannot be read: HTTP 404: Project not found");
    expect(await changes.patch({ slug: "csv", path: "a", base: "a".repeat(40), head: "b".repeat(40) })).toMatchObject({ patch: null, message: expect.stringContaining("HTTP 404") });
    await expect(changes.view("nope")).rejects.toThrow('No Loom project named "nope".');
  });
});

describe("a file's patch", () => {
  it("reads git between the listing's commits, or the worker's worktree for a working ticket", async () => {
    await midProject();
    const env2 = ticketOf(h, "CSV-2").environment_id!;
    h.bb.environmentChanges.set(env2, { files: [], patches: { "src/export/b.ts": "@@ -0,0 +1 @@\n+b\n" } });
    const [base, head] = ["a".repeat(40), "b".repeat(40)];
    expect(await changes.patch({ slug: "csv", path: "src/a.ts", base, head })).toEqual({ patch: "diff --git a/src/a.ts b/src/a.ts\n+changed\n", truncated: false });
    expect(h.host.callsTo("filePatch")).toEqual([{ repo: "/repo", base, head, path: "src/a.ts", maxBytes: 400_000 }]);
    expect(await changes.patch({ slug: "csv", path: "src/export/b.ts", key: "CSV-2" })).toEqual({ patch: "@@ -0,0 +1 @@\n+b\n", truncated: false });
    expect(h.bb.callsTo("environmentPatch")).toEqual([[env2, "loom/csv", "src/export/b.ts"]]);
  });

  it("says when the commits or the worktree are gone, and refuses a request it cannot place", async () => {
    await midProject();
    const [base, head] = ["a".repeat(40), "b".repeat(40)];
    h.host.scripted.filePatch = [{ outcome: "missing", message: `${base} is not in the repository.` }];
    expect(await changes.patch({ slug: "csv", path: "x", base, head })).toEqual({ patch: null, message: `Its commits are no longer in the repository: ${base} is not in the repository.` });
    expect(await changes.patch({ slug: "csv", path: "x", key: "CSV-1" })).toEqual({ patch: null, message: "CSV-1 has no worktree now." });
    expect(await changes.patch({ slug: "csv", path: "x", key: "CSV-2" })).toMatchObject({ patch: null, message: expect.stringContaining("is gone") });
    await expect(changes.patch({ slug: "csv", path: "x" })).rejects.toThrow("needs the two commits");
    await expect(changes.patch({ slug: "csv", path: "x", key: "OTHER-1" })).rejects.toThrow("No ticket OTHER-1 in csv.");
  });
});
