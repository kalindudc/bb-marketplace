import { beforeEach, describe, expect, it } from "vitest";
import { Changes } from "../src/changes";
import type { HostOutput } from "../src/host-contract";
import { runMergeQueue, settleMerges } from "../src/merge";
import { specOf } from "../src/workers";
import { makeCtx, reachApproved, reachReview, seedProject, seedRepoProject, startWorker, ticketOf, withDocsTicket, type Doc, type EngineHarness } from "./helpers";

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

    h.bb.calls = [];
    const view = await changes.view("csv");
    expect(view).toMatchObject({ strategy: "integration", base: "main", remoteBase: "origin/main", branch: "loom/csv", finished: false, unavailable: null });
    expect(view.repos).toEqual([{ name: null, base: "main", remoteBase: "origin/main", branch: "loom/csv", unavailable: null }]);
    expect(view.sources.every((source) => source.repo === null)).toBe(true);
    expect(h.bb.callsTo("projectCheckout")).toEqual([["proj_1", "host_1"]]);
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
    expect(view).toMatchObject({ strategy: "pr", branch: null, repos: [{ name: null, base: "main", remoteBase: "origin/main", branch: null, unavailable: null }] });
    expect(view.sources.map((source) => [source.id, source.repo])).toEqual([
      ["commit:CSV-1", null],
      ["commit:CSV-2", null],
    ]);
    expect(listed()).toEqual([{ base: "origin/main", head: head1, mergeBase: true, landed: true }]);
  });
});

describe("what cannot be read", () => {
  it("says so for a draft and for a project with no checkout on its machine", async () => {
    await h.projects.propose({ toml: (await import("./helpers")).specToml(), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_1" });
    expect(await changes.view("csv")).toMatchObject({ sources: [], unavailable: "The project has no approved spec yet." });
    await h.projects.approve("csv", "human");
    h.bb.checkout = null;
    expect(await changes.view("csv")).toMatchObject({ sources: [], unavailable: "The bb project has no checkout on the machine host_1, so its changes cannot be read." });
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

// seedRepoProject's repos: web (CSV-1 and CSV-3), api (CSV-2, on upstream/trunk) and docs (no tickets), checked out at /src/<name> on host_1.
const withWebDocsTicket = (doc: Doc) =>
  doc.ticket.push({ ref: "web-docs", title: "Web docs", body: "Write the docs.", acceptance: ["WHEN the docs are built THE SYSTEM SHALL list the export"], scope: ["docs/**"], repo: "web" });
const repoListed = () => h.host.callsTo("changedFiles").map(({ repo, base, head, mergeBase }) => ({ repo, base, head, mergeBase }));
const noCheckout = (name: string) => `Repo "${name}" (bb project proj_${name}) has no checkout on the machine host_1 that this Loom project uses. Clone it there with \`bb project source add proj_${name} --clone --machine host_1\`, then resume.`;

async function mergeNext(key: string): Promise<void> {
  await reachApproved(h, key);
  await runMergeQueue(h.ctx, project(), specOf(h.store, project()));
  await settleMerges(h.ctx);
}

/** CSV-1 merged into web's integration branch as m1, CSV-2 into api's as m2 (both from base000), and CSV-3's worker at work in web. */
async function repoProject(): Promise<void> {
  await seedRepoProject(h, withWebDocsTicket);
  await mergeNext("CSV-1");
  await mergeNext("CSV-2");
  await startWorker(h, "CSV-3");
  h.host.listings.set("/src/web:origin/main..refs/heads/loom/csv", listing("base000", "m1", ["src/model/a.ts", "src/shared.ts"]));
  h.host.listings.set("/src/api:upstream/trunk..refs/heads/loom/csv", listing("base000", "m2", ["src/export/b.ts", "src/shared.ts"]));
  h.host.listings.set("/src/web:base000..m1", listing("base000", "m1", ["src/model/a.ts"]));
  h.host.listings.set("/src/api:base000..m2", listing("base000", "m2", ["src/export/b.ts", "src/shared.ts"]));
}

describe("the changes of a multi-repo integration project", () => {
  it("reads one whole branch per repo and each merge in its own repo's checkout, and a working ticket against its repo's fresh base", async () => {
    await repoProject();
    const env3 = ticketOf(h, "CSV-3").environment_id!;
    h.bb.environmentChanges.set(env3, { files: [{ path: "docs/export.md", previousPath: null, status: "added", additions: 3, deletions: 0, binary: false, untracked: true }], patches: {} });
    h.bb.calls = [];

    const view = await changes.view("csv");
    expect(view).toMatchObject({ strategy: "integration", base: "main", remoteBase: "origin/main", branch: "loom/csv", finished: false, unavailable: null });
    expect(view.repos).toEqual([
      { name: "web", base: "main", remoteBase: "origin/main", branch: "loom/csv", unavailable: null },
      { name: "api", base: "trunk", remoteBase: "upstream/trunk", branch: "loom/csv", unavailable: null },
      { name: "docs", base: "main", remoteBase: "origin/main", branch: "loom/csv", unavailable: null },
    ]);
    expect(view.sources.map((source) => [source.id, source.repo, source.against, source.note])).toEqual([
      ["branch:web", "web", "origin/main", null],
      ["branch:api", "api", "upstream/trunk", null],
      ["branch:docs", "docs", "origin/main", "Nothing merged yet."],
      ["merge:CSV-1", "web", "loom/csv", null],
      ["merge:CSV-2", "api", "loom/csv", null],
      ["live:CSV-3", "web", "loom/csv", null],
    ]);
    expect(h.bb.callsTo("projectCheckout")).toEqual([
      ["proj_web", "host_1"],
      ["proj_api", "host_1"],
      ["proj_docs", "host_1"],
    ]);
    expect(repoListed()).toEqual([
      { repo: "/src/web", base: "origin/main", head: "refs/heads/loom/csv", mergeBase: true },
      { repo: "/src/api", base: "upstream/trunk", head: "refs/heads/loom/csv", mergeBase: true },
      { repo: "/src/web", base: "base000", head: "m1", mergeBase: false },
      { repo: "/src/api", base: "base000", head: "m2", mergeBase: false },
    ]);
    expect(h.bb.callsTo("environmentFiles")).toEqual([[env3, "loom/csv"]]);

    const byId = (id: string) => view.sources.find((source) => source.id === id)!;
    // src/shared.ts changed in both repos: each whole branch credits only its own repo's merges.
    expect(byId("branch:web").files!.map((changed) => [changed.path, changed.tickets])).toEqual([
      ["src/model/a.ts", ["CSV-1"]],
      ["src/shared.ts", []],
    ]);
    expect(byId("branch:api").files!.map((changed) => [changed.path, changed.tickets])).toEqual([
      ["src/export/b.ts", ["CSV-2"]],
      ["src/shared.ts", ["CSV-2"]],
    ]);
    expect(byId("merge:CSV-1")).toMatchObject({ base: "base000", head: "m1", gone: false, files: [expect.objectContaining({ path: "src/model/a.ts" })] });
    expect(byId("merge:CSV-2")).toMatchObject({ base: "base000", head: "m2", gone: false });
    expect(byId("live:CSV-3").files!.map((changed) => changed.path)).toEqual(["docs/export.md"]);
  });

  it("reads a finished project's branch in each repo from before that repo's first merge to its last", async () => {
    await repoProject();
    h.store.setProjectState(project().id, "archived", "human");
    const view = await changes.view("csv");
    expect(view.sources.filter((source) => source.kind === "branch").map((source) => [source.id, source.against, source.base, source.head, source.note])).toEqual([
      ["branch:web", "loom/csv before its first merge", "base000", "m1", null],
      ["branch:api", "loom/csv before its first merge", "base000", "m2", null],
      ["branch:docs", "loom/csv before its first merge", null, null, "Nothing merged yet."],
    ]);
    expect(repoListed().slice(0, 2)).toEqual([
      { repo: "/src/web", base: "base000", head: "m1", mergeBase: false },
      { repo: "/src/api", base: "base000", head: "m2", mergeBase: false },
    ]);
  });

  it("still reads the other repos when one has no checkout, and gives that repo's sources a note with the clone command", async () => {
    await repoProject();
    h.bb.checkouts.set("proj_api", {});
    const view = await changes.view("csv");
    expect(view.unavailable).toBeNull();
    expect(view.repos.map((repo) => [repo.name, repo.unavailable])).toEqual([
      ["web", null],
      ["api", noCheckout("api")],
      ["docs", null],
    ]);
    for (const source of view.sources.filter((entry) => entry.repo === "api")) expect(source).toMatchObject({ files: null, gone: false, note: noCheckout("api") });
    expect(view.sources.filter((source) => source.repo === "api").map((source) => source.id)).toEqual(["branch:api", "merge:CSV-2"]);
    expect(view.sources.find((source) => source.id === "merge:CSV-1")).toMatchObject({ note: null, head: "m1" });
    expect(repoListed().map((call) => call.repo)).toEqual(["/src/web", "/src/web"]);
  });

  it("says why a repo's checkout cannot be found, and that nothing can be read when no repo has a checkout", async () => {
    await repoProject();
    const lookup = h.bb.projectCheckout.bind(h.bb);
    h.bb.projectCheckout = async (bbProjectId, hostId) => (bbProjectId === "proj_docs" ? Promise.reject(new Error("HTTP 404: Project not found")) : lookup(bbProjectId, hostId));
    const docs = 'The checkout of the repo "docs" cannot be found, so its changes cannot be read: HTTP 404: Project not found';
    expect((await changes.view("csv")).repos.map((repo) => repo.unavailable)).toEqual([null, null, docs]);

    h.bb.checkouts.set("proj_web", {});
    h.bb.checkouts.set("proj_api", {});
    const none = await changes.view("csv");
    expect(none.sources).toEqual([]);
    expect(none.unavailable).toBe(`None of the project's repos can be read. ${noCheckout("web")} ${noCheckout("api")} ${docs}`);
  });
});

describe("the changes of a multi-repo pull request project", () => {
  it("compares each ticket with its own repo's remote base, in that repo's checkout", async () => {
    await seedRepoProject(h, (doc) => (doc.merge = { strategy: "pr" }));
    await reachReview(h, "CSV-1");
    const head1 = ticketOf(h, "CSV-1").head_sha!;
    await startWorker(h, "CSV-2");
    const env2 = ticketOf(h, "CSV-2").environment_id!;
    h.bb.environmentChanges.set(env2, { files: [], patches: { "src/export/b.ts": "@@ -0,0 +1 @@\n+b\n" } });

    const view = await changes.view("csv");
    expect(view.repos.map((repo) => [repo.name, repo.remoteBase, repo.branch])).toEqual([
      ["web", "origin/main", null],
      ["api", "upstream/trunk", null],
      ["docs", "origin/main", null],
    ]);
    expect(view.sources.map((source) => [source.id, source.repo, source.against])).toEqual([
      ["commit:CSV-1", "web", "origin/main"],
      ["live:CSV-2", "api", "upstream/trunk"],
    ]);
    expect(repoListed()).toEqual([{ repo: "/src/web", base: "origin/main", head: head1, mergeBase: true }]);
    expect(h.bb.callsTo("environmentFiles")).toEqual([[env2, "upstream/trunk"]]);

    expect(await changes.patch({ slug: "csv", path: "src/export/b.ts", key: "CSV-2" })).toEqual({ patch: "@@ -0,0 +1 @@\n+b\n", truncated: false });
    expect(h.bb.callsTo("environmentPatch")).toEqual([[env2, "upstream/trunk", "src/export/b.ts"]]);
  });
});

describe("a file's patch on a multi-repo project", () => {
  const [base, head] = ["a".repeat(40), "b".repeat(40)];

  it("reads git in the named repo's checkout, and refuses a missing or unknown repo", async () => {
    await repoProject();
    expect(await changes.patch({ slug: "csv", path: "src/export/b.ts", base, head, repo: "api" })).toEqual({ patch: "diff --git a/src/export/b.ts b/src/export/b.ts\n+changed\n", truncated: false });
    expect(h.host.callsTo("filePatch")).toEqual([{ repo: "/src/api", base, head, path: "src/export/b.ts", maxBytes: 400_000 }]);
    await expect(changes.patch({ slug: "csv", path: "x", base, head })).rejects.toMatchObject({ code: "loom_invalid_input", message: "A file's patch in csv needs the repo it is read in: one of web, api, docs." });
    await expect(changes.patch({ slug: "csv", path: "x", base, head, repo: "ios" })).rejects.toMatchObject({ code: "loom_invalid_input", message: 'Project csv has no repo "ios"; its repos are web, api, docs.' });
    expect(h.host.callsTo("filePatch")).toHaveLength(1);
  });

  it("says a repo has no checkout, with the clone command, and needs no repo for a working ticket's worktree", async () => {
    await repoProject();
    h.bb.checkouts.set("proj_web", {});
    expect(await changes.patch({ slug: "csv", path: "x", base, head, repo: "web" })).toEqual({ patch: null, message: noCheckout("web") });
    const env3 = ticketOf(h, "CSV-3").environment_id!;
    h.bb.environmentChanges.set(env3, { files: [], patches: { "docs/export.md": "+docs\n" } });
    expect(await changes.patch({ slug: "csv", path: "docs/export.md", key: "CSV-3" })).toEqual({ patch: "+docs\n", truncated: false });
    expect(h.bb.callsTo("environmentPatch")).toEqual([[env3, "loom/csv", "docs/export.md"]]);
  });

  it("refuses a repo on a single-repo project", async () => {
    await seedProject(h);
    await expect(changes.patch({ slug: "csv", path: "x", base, head, repo: "web" })).rejects.toMatchObject({ code: "loom_invalid_input", message: expect.stringContaining("has no [[repo]] tables") });
  });
});
