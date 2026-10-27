import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostOutput } from "../src/host-contract";
import { runMergeQueue, settleMerges } from "../src/merge";
import { syncMessage, type PrSyncTicket } from "../src/pr-sync";
import { LoomError } from "../src/projects";
import { specOf } from "../src/workers";
import { makeEngine, reachApproved, seedProject, seedRepoProject, ticketOf, type Doc } from "./helpers";

let h: ReturnType<typeof makeEngine>;
beforeEach(() => {
  h = makeEngine();
});

const MINUTE = 60_000;
const URL = "https://github.com/acme/shop/pull/1";
const project = () => h.store.projectBySlug("csv")!;
const pr = (doc: Doc) => (doc.merge = { strategy: "pr", describe: "loom", squash: false, max_fix_rounds: 0 });
const reads = () => h.host.callsTo("prBatch");
type Batch = HostOutput<"prBatch">;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

async function open(key = "CSV-1"): Promise<void> {
  await reachApproved(h, key);
  await runMergeQueue(h.ctx, project(), specOf(h.store, project()));
  await settleMerges(h.ctx);
  expect(ticketOf(h, key).state).toBe("pr_open");
  h.host.calls = [];
}

async function refusal(run: () => Promise<unknown>): Promise<LoomError> {
  const error = await run().then(
    () => null,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(LoomError);
  return error as LoomError;
}

describe("syncing a project's pull requests", () => {
  it("reads an open pull request before its next poll is due and completes it when it merged", async () => {
    await seedProject(h, pr);
    await open();
    h.host.prStates.set(URL, "MERGED");
    await h.engine.tick();
    expect(reads()).toEqual([]);
    expect(ticketOf(h, "CSV-1").state).toBe("pr_open");

    const result = await h.engine.syncPullRequests("csv");
    expect(reads()).toEqual([{ repo: "/repo", host: "github.com", owner: "acme", name: "shop", numbers: [1], feedback: false }]);
    expect(ticketOf(h, "CSV-1").state).toBe("done");
    expect(result).toEqual({ slug: "csv", tickets: [{ key: "CSV-1", state: "done", outcome: "merged", detail: null }], message: "CSV-1's pull request merged, so CSV-1 is done.", problem: false });
    expect(h.ctx.prReads!.asked.size + h.ctx.prReads!.out.size).toBe(0);
  });

  it("says nothing is new for a pull request that is still open, tells the page, and leaves its next poll 5 minutes away", async () => {
    await seedProject(h, pr);
    await open();
    const changed = vi.spyOn(h.store, "changed");
    const result = await h.engine.syncPullRequests("csv");
    expect(result).toMatchObject({ tickets: [{ key: "CSV-1", outcome: "open" }], message: "Read CSV-1's pull request: nothing new, it is still open.", problem: false });
    expect(changed).toHaveBeenCalledWith(project().id);
    expect(ticketOf(h, "CSV-1").pr_checked_at).toBe(h.clock.t);
    h.clock.advance(4 * MINUTE);
    await h.engine.tick();
    expect(reads()).toHaveLength(1);
  });

  it("reads a paused project's pull requests too", async () => {
    await seedProject(h, pr);
    await open();
    h.store.setProjectState(project().id, "paused", "human");
    h.host.prStates.set(URL, "CLOSED");
    const result = await h.engine.syncPullRequests("csv");
    expect(ticketOf(h, "CSV-1").state).toBe("blocked");
    expect(result.tickets).toEqual([{ key: "CSV-1", state: "blocked", outcome: "blocked", detail: "the pull request was closed without merging" }]);
    expect(result.message).toBe("CSV-1 is blocked: the pull request was closed without merging.");
  });

  it("goes past the wait after a server error, and a failure that follows keeps counting the same streak", async () => {
    await seedProject(h, pr);
    await open();
    h.clock.advance(5 * MINUTE);
    h.host.scripted.prBatch = [{ outcome: "unavailable", message: "gh api graphql failed: gh: HTTP 504", transient: "server" } satisfies Batch];
    await h.engine.tick();
    expect(JSON.parse(ticketOf(h, "CSV-1").pr_poll_json!)).toMatchObject({ failures: 1 });

    h.host.scripted.prBatch = [{ outcome: "unavailable", message: "gh api graphql failed: gh: HTTP 504", transient: "server" } satisfies Batch];
    const failed = await h.engine.syncPullRequests("csv");
    expect(reads()).toHaveLength(2);
    expect(JSON.parse(ticketOf(h, "CSV-1").pr_poll_json!)).toMatchObject({ failures: 2 });
    expect(failed).toMatchObject({ tickets: [{ key: "CSV-1", outcome: "failed" }], problem: true });
    expect(failed.message).toBe("Could not read CSV-1's pull request: gh api graphql failed: gh: HTTP 504; Loom reads it again in 10m.");

    h.host.prStates.set(URL, "MERGED");
    const merged = await h.engine.syncPullRequests("csv");
    expect(merged.tickets[0]).toMatchObject({ outcome: "merged" });
    expect(ticketOf(h, "CSV-1").pr_poll_json).toBeNull();
  });

  it("goes past a forge host's network wait, keeping its streak when the read fails again", async () => {
    await seedProject(h, pr);
    await open();
    const now = h.clock.t;
    h.ctx.forgeBackoffs.set("github.com", { until: now + 10 * MINUTE, delayMs: 10 * MINUTE, message: "dial tcp: i/o timeout", network: { failures: 2, since: now - 15 * MINUTE } });
    h.host.scripted.prBatch = [{ outcome: "unavailable", message: "dial tcp: i/o timeout", transient: "network" } satisfies Batch];
    const failed = await h.engine.syncPullRequests("csv");
    expect(reads()).toHaveLength(1);
    expect(h.ctx.forgeBackoffs.get("github.com")).toMatchObject({ until: now + 20 * MINUTE, network: { failures: 3, since: now - 15 * MINUTE } });
    expect(failed.message).toBe("Could not read CSV-1's pull request: Loom could not reach github.com (dial tcp: i/o timeout), so it tries again in 20m.");

    const read = await h.engine.syncPullRequests("csv");
    expect(reads()).toHaveLength(2);
    expect(read.tickets[0]).toMatchObject({ outcome: "open" });
    expect(h.ctx.forgeBackoffs.has("github.com")).toBe(false);
  });

  it("does not go past a rate limit: it reads nothing and says how long the limit lasts", async () => {
    await seedProject(h, pr);
    await open();
    h.ctx.forgeBackoffs.set("github.com", { until: h.clock.t + 15 * MINUTE, delayMs: 15 * MINUTE, message: "API rate limit exceeded" });
    const result = await h.engine.syncPullRequests("csv");
    expect(reads()).toEqual([]);
    expect(result).toEqual({
      slug: "csv",
      tickets: [{ key: "CSV-1", state: "pr_open", outcome: "waiting", detail: "github.com rate-limited Loom's reads for 15m more" }],
      message: "Did not read CSV-1's pull request, because github.com rate-limited Loom's reads for 15m more.",
      problem: true,
    });
    expect(h.ctx.prReads!.asked.size).toBe(0);
  });

  it("names the failure that paused the project once, on the ticket", async () => {
    await seedProject(h, pr);
    await open();
    h.host.scripted.prBatch = [{ outcome: "unavailable", message: "gh is not signed in to github.com." } satisfies Batch];
    const result = await h.engine.syncPullRequests("csv");
    expect(project()).toMatchObject({ state: "paused", system_reason: "gh is not signed in to github.com." });
    expect(result.tickets).toEqual([{ key: "CSV-1", state: "pr_open", outcome: "failed", detail: "gh is not signed in to github.com." }]);
    expect(result.message).toBe("Could not read CSV-1's pull request: gh is not signed in to github.com. Loom paused the project.");
    expect(result.problem).toBe(true);
  });

  it("answers that a read is still going when the pass outlasts the wait, and the read still settles the ticket", async () => {
    await seedProject(h, pr);
    await open();
    const answer = deferred<Batch>();
    h.host.scripted.prBatch = [answer.promise];
    const result = await h.engine.syncPullRequests("csv", { waitMs: 5 });
    expect(result).toMatchObject({ tickets: [{ key: "CSV-1", outcome: "reading" }], message: "Loom is still reading CSV-1's pull request; the page updates when it is done.", problem: true });

    answer.resolve({ outcome: "ok", pulls: [{ number: 1, state: "MERGED", draft: false, review: null, base: null, feedback: null }], missing: [] });
    await h.engine.tick();
    expect(ticketOf(h, "CSV-1").state).toBe("done");
  });

  it("reads a pull request once when the sync comes while the usual poll's read of it is out", async () => {
    await seedProject(h, pr);
    await open();
    h.clock.advance(5 * MINUTE);
    const answer = deferred<Batch>();
    h.host.scripted.prBatch = [answer.promise];
    const pass = h.engine.tick();
    await vi.waitFor(() => expect(reads()).toHaveLength(1));
    const syncing = h.engine.syncPullRequests("csv");
    answer.resolve({ outcome: "ok", pulls: [{ number: 1, state: "OPEN", draft: false, review: null, base: null, feedback: null }], missing: [] });
    const result = await syncing;
    await pass;
    expect(reads()).toHaveLength(1);
    expect(result).toMatchObject({ tickets: [{ key: "CSV-1", outcome: "open" }], problem: false });
  });

  describe("on the push-only forge", () => {
    const pushOnly = (doc: Doc) => {
      doc.merge = { strategy: "pr", forge: { kind: "none" }, describe: "loom", squash: false, max_fix_rounds: 0 };
      doc.checks.ci = false;
    };

    it("reads whether the branch landed, and completes the ticket when it did", async () => {
      await seedProject(h, pushOnly);
      await open();
      expect((await h.engine.syncPullRequests("csv")).message).toBe("Read CSV-1's pull request: nothing new, it is still open.");
      h.host.landed.add(ticketOf(h, "CSV-1").pushed_sha!);
      const landed = await h.engine.syncPullRequests("csv");
      expect(landed.tickets).toEqual([{ key: "CSV-1", state: "done", outcome: "landed", detail: null }]);
      expect(h.host.callsTo("landedOn")).toHaveLength(2);
    });

    it("says a read that failed failed, though the forge stores nothing when it works", async () => {
      await seedProject(h, pushOnly);
      await open();
      h.host.scripted.landedOn = [{ outcome: "unavailable", message: "git fetch from origin failed: offline" } satisfies HostOutput<"landedOn">];
      const result = await h.engine.syncPullRequests("csv");
      expect(project().state).toBe("paused");
      expect(result.tickets).toEqual([{ key: "CSV-1", state: "pr_open", outcome: "failed", detail: "git fetch from origin failed: offline" }]);
      expect(result.message).toBe("Could not read CSV-1's pull request: git fetch from origin failed: offline. Loom paused the project.");
    });
  });

  it("reads every open pull request of the project in one call, or only one ticket's with its key", async () => {
    await seedRepoProject(h, pr);
    await open("CSV-2");
    await open("CSV-1");
    const [api, web] = [ticketOf(h, "CSV-2").pr_url!, ticketOf(h, "CSV-1").pr_url!];
    const number = (url: string) => Number(url.split("/").at(-1));

    const one = await h.engine.syncPullRequests("csv", { key: "CSV-2" });
    expect(reads().map((read) => read.numbers)).toEqual([[number(api)]]);
    expect(one.tickets.map((ticket) => ticket.key)).toEqual(["CSV-2"]);

    h.host.prStates.set(web, "MERGED");
    const both = await h.engine.syncPullRequests("csv");
    expect(reads().at(-1)!.numbers.sort()).toEqual([number(api), number(web)].sort());
    expect(both.message).toBe("Read 2 pull requests: CSV-1 merged and 1 is still open.");
  });

  it("refuses a project it cannot read pull requests for, and a ticket without an open pull request", async () => {
    expect((await refusal(() => h.engine.syncPullRequests("nope"))).code).toBe("loom_not_found");

    await seedProject(h, pr, "ready");
    expect((await refusal(() => h.engine.syncPullRequests("csv"))).message).toBe("Project csv is ready; Loom reads pull requests only while a project is running or paused.");
    h.store.setProjectState(project().id, "running", "human");
    expect((await refusal(() => h.engine.syncPullRequests("csv"))).message).toBe("No pull request of csv is open, so there is nothing to read.");
    expect((await refusal(() => h.engine.syncPullRequests("csv", { key: "CSV-2" }))).message).toBe("CSV-2 has no open pull request for Loom to read: it is queued.");
    expect((await refusal(() => h.engine.syncPullRequests("csv", { key: "CSV-9" }))).code).toBe("loom_not_found");
    expect(reads()).toEqual([]);
  });

  it("refuses an integration project, which has no pull request per ticket", async () => {
    await seedProject(h);
    const error = await refusal(() => h.engine.syncPullRequests("csv"));
    expect(error).toMatchObject({ code: "loom_invalid_state", message: "Project csv merges into its integration branch, so it has no pull request per ticket to read." });
  });
});

describe("syncMessage", () => {
  const t = (key: string, outcome: PrSyncTicket["outcome"], detail: string | null = null, state: PrSyncTicket["state"] = "pr_open"): PrSyncTicket => ({ key, state, outcome, detail });

  it("puts what changed first, then what is still open", () => {
    expect(syncMessage([t("A-1", "merged", null, "done"), t("A-2", "merged", null, "done"), t("A-3", "open")])).toBe("Read 3 pull requests: A-1 and A-2 merged and 1 is still open.");
    expect(syncMessage([t("A-1", "fix", "fix round 2", "working"), t("A-2", "blocked", "the pull request was closed without merging.", "blocked")])).toBe(
      "Read 2 pull requests: A-2 is blocked (the pull request was closed without merging) and A-1's feedback started fix round 2.",
    );
    expect(syncMessage([t("A-1", "open"), t("A-2", "open")])).toBe("Read 2 pull requests: nothing new, all 2 are still open.");
  });

  it("gives each failed read its own sentence, then what waits and what is still being read", () => {
    expect(syncMessage([t("A-1", "open"), t("A-2", "failed", "gh: HTTP 502"), t("A-3", "waiting", "github.com rate-limited Loom's reads for 9m more"), t("A-4", "reading")])).toBe(
      "Read 1 pull request: nothing new, it is still open. Could not read A-2's pull request: gh: HTTP 502. Not read: A-3, because github.com rate-limited Loom's reads for 9m more. Loom is still reading A-4; the page updates when it is done.",
    );
    expect(syncMessage([t("A-1", "failed", "gh: HTTP 502"), t("A-2", "failed", "gh: HTTP 504")])).toBe("Could not read A-1's pull request: gh: HTTP 502. Could not read A-2's pull request: gh: HTTP 504.");
  });

  it("names each host's own rate limit for the tickets that wait on it", () => {
    const github = "github.com rate-limited Loom's reads for 9m more";
    const delta = "delta.shopify.io rate-limited Loom's reads for 40m more";
    expect(syncMessage([t("A-1", "waiting", github), t("A-2", "waiting", delta), t("A-3", "waiting", github)])).toBe(`Not read: A-1 and A-3, because ${github}. Not read: A-2, because ${delta}.`);
  });
});
