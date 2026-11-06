// One failure policy: a failure of one ticket waits on that ticket and blocks only it; a failure of a forge or the
// project's machine waits without blocking or pausing; only a failure of the whole project pauses it. The waits live on
// the ticket, so a restart goes on with them and repeats nothing.
import { beforeEach, describe, expect, it } from "vitest";
import { specOf, type EngineCtx } from "../src/ctx";
import { Store } from "../src/db/store";
import { forgeBoundary } from "../src/forge-gate";
import type { Failure } from "../src/failures";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { SpawnUnavailableError } from "../src/ports";
import { Projects } from "../src/projects";
import { maybeSendTriage } from "../src/triage";
import { decide, nextRetry, retryOf } from "../src/retry-wait";
import { makeCtx, reachApproved, seedProject, seedRepoProject, startWorker, ticketOf, type Doc, type EngineHarness } from "./helpers";

const MINUTE = 60_000;
const DEADLINE = "host plugin call 1f46e1e1-6061-4d69-81e2-afb2e9ac216c exceeded its deadline";
const failure = (kind: Failure["kind"], scope: Failure["scope"], more: Partial<Failure> = {}): Failure => ({ kind, scope, reason: "it broke", known: true, ...more });
const at = (now: number) => ({ step: "merge" as const, what: "Merging CSV-1", now });

describe("decide", () => {
  it("waits on a temporary failure of the ticket, and blocks it once it has failed for an hour", () => {
    const first = decide(null, { ...at(0), failure: failure("temporary", "ticket") });
    expect(first).toMatchObject({ do: "wait", wait: { failures: 1, since: 0, until: MINUTE, scope: "ticket" } });
    expect(first.do === "wait" && first.post).toContain("blocks this ticket only if it keeps failing for 1h");
    let wait = first.do === "wait" ? first.wait : null;
    for (const now of [MINUTE, 3 * MINUTE, 8 * MINUTE, 18 * MINUTE, 33 * MINUTE, 48 * MINUTE]) {
      const next = decide(wait, { ...at(now), failure: failure("temporary", "ticket") });
      expect(next).toMatchObject({ do: "wait", post: null });
      wait = next.do === "wait" ? next.wait : null;
    }
    expect(decide(wait, { ...at(63 * MINUTE), failure: failure("temporary", "ticket") })).toEqual({ do: "block", reason: "Merging CSV-1 failed 8 times in a row over 1h 3m: it broke. Loom blocked this ticket; the rest of the project keeps running." });
  });

  it("blocks the ticket after five tries of a failure no rule recognized", () => {
    let wait = null as ReturnType<typeof nextRetry> | null;
    for (const now of [0, MINUTE, 3 * MINUTE, 8 * MINUTE]) {
      const next = decide(wait, { ...at(now), failure: failure("temporary", "ticket", { known: false }) });
      expect(next.do).toBe("wait");
      wait = next.do === "wait" ? next.wait : null;
    }
    expect(decide(wait, { ...at(18 * MINUTE), failure: failure("temporary", "ticket", { known: false }) })).toMatchObject({ do: "block" });
  });

  it("blocks the ticket at once for a lasting failure of the ticket", () => {
    expect(decide(null, { ...at(0), failure: failure("lasting", "ticket") })).toEqual({ do: "block", reason: "Merging CSV-1 failed, and trying again would not help: it broke." });
  });

  it.each([
    ["temporary", "forge"],
    ["unknown", "host"],
    ["temporary", "host"],
  ] as const)("never blocks or pauses for a %s failure of the %s, and says so once more after an hour", (kind, scope) => {
    let wait = null as ReturnType<typeof nextRetry> | null;
    const posts: Array<string | null> = [];
    for (let now = 0; now <= 3 * 60 * MINUTE; now += 15 * MINUTE) {
      const next = decide(wait, { ...at(now), failure: failure(kind, scope) });
      expect(next.do).toBe("wait");
      if (next.do === "wait") {
        posts.push(next.post);
        wait = next.wait;
      }
    }
    expect(posts.filter((post) => post !== null)).toHaveLength(2);
    expect(posts[4]).toMatch(/has failed 5 times in a row over 1h/u);
  });

  it("waits every 15 minutes on a lasting failure of the machine, saying at once that someone has to put it right", () => {
    const first = decide(null, { ...at(0), failure: failure("lasting", "host") });
    expect(first).toMatchObject({ do: "wait", wait: { until: 15 * MINUTE, noted: true } });
    expect(first.do === "wait" && first.post).toContain("that someone has to put right");
    expect(decide(first.do === "wait" ? first.wait : null, { ...at(15 * MINUTE), failure: failure("lasting", "host") })).toMatchObject({ do: "wait", post: null });
  });

  it("pauses for a failure of the whole project, saying what to fix", () => {
    expect(decide(null, { ...at(0), failure: failure("lasting", "project", { fix: "Sign in, then resume the project." }) })).toEqual({ do: "pause", reason: "Merging CSV-1 stopped: it broke. Sign in, then resume the project." });
  });

  it("waits at least 15 minutes after a rate limit, and never before the time the forge named", () => {
    expect(nextRetry(null, { step: "merge", now: 0, failure: failure("temporary", "forge", { rateLimited: true }) }).until).toBe(15 * MINUTE);
    expect(nextRetry(null, { step: "merge", now: 0, failure: failure("temporary", "forge", { retryAfterMs: 40 * MINUTE }) }).until).toBe(40 * MINUTE);
  });

  it("starts a new streak for another step, another head, or a wait that ended long ago", () => {
    const wait = nextRetry(null, { step: "diff", head: "c1", now: 0, failure: failure("temporary", "ticket") });
    expect(nextRetry(wait, { step: "diff", head: "c1", now: MINUTE, failure: failure("temporary", "ticket") })).toMatchObject({ failures: 2, since: 0 });
    expect(nextRetry(wait, { step: "diff", head: "c2", now: MINUTE, failure: failure("temporary", "ticket") })).toMatchObject({ failures: 1, since: MINUTE });
    expect(nextRetry(wait, { step: "read", now: MINUTE, failure: failure("temporary", "ticket") })).toMatchObject({ failures: 1 });
    expect(nextRetry(wait, { step: "diff", head: "c1", now: 30 * MINUTE, failure: failure("temporary", "ticket") })).toMatchObject({ failures: 1, since: 30 * MINUTE });
  });
});

describe("on a running project", () => {
  let h: EngineHarness & { db: ReturnType<typeof makeCtx>["db"] };
  beforeEach(() => {
    h = makeCtx();
  });
  const project = () => h.store.projectBySlug("csv")!;
  const spec = () => specOf(h.store, project());
  const queue = async () => {
    await runMergeQueue(h.ctx, project(), spec());
    await settleMerges(h.ctx);
  };
  const pr = (doc: Doc) => (doc.merge = { strategy: "pr", describe: "loom", max_fix_rounds: 0 });
  const systemPosts = (key: string) => h.store.posts(ticketOf(h, key).id).filter((post) => post.kind === "system").map((post) => post.body);

  /** Loom restarts: a new store over the same database, and none of the engine's memory, as after a plugin reload. */
  const restart = () => {
    const store = new Store(h.db, h.clock.now);
    const ctx: EngineCtx = { ...h.ctx, store, forgeBackoffs: new Map(), host: forgeBoundary(h.host, { backoffs: () => ctx.forgeBackoffs, now: h.clock.now }) };
    h = { ...h, store, ctx, projects: new Projects({ store, bb: h.bb, now: h.clock.now, host: h.host }) };
  };

  it("keeps reading and merging another repo's pull requests on another forge while one forge cannot be reached for hours", async () => {
    await seedRepoProject(h, pr);
    await reachApproved(h, "CSV-1");
    await reachApproved(h, "CSV-2");
    await queue();
    await queue();
    h.store.updateTicket(ticketOf(h, "CSV-2").id, { pr_url: "https://git.example.com/acme/api/pull/7" });
    const offline = { outcome: "unavailable", message: "gh api graphql failed: error connecting to api.github.com", transient: "network" } as const;
    const call = h.host.call.bind(h.host);
    let down = true;
    h.host.call = (async (hostId: string, method: string, input: { host?: string }) => (down && method === "prBatch" && input.host === "github.com" ? offline : call(hostId, method as never, input as never))) as typeof h.host.call;
    for (let minutes = 0; minutes < 3 * 60; minutes += 5) {
      h.clock.advance(5 * MINUTE);
      await pollPullRequests(h.ctx, project());
    }
    expect(project()).toMatchObject({ state: "running", system_reason: null });
    expect(ticketOf(h, "CSV-1").state).toBe("pr_open");
    expect(systemPosts("CSV-1")).toEqual([expect.stringContaining("could not reach github.com"), expect.stringContaining("Loom still cannot reach github.com")]);

    expect(ticketOf(h, "CSV-2").state).toBe("pr_open");
    expect(h.host.callsTo("prBatch").filter((input) => input.host === "git.example.com").length).toBeGreaterThan(30);
    h.host.prStates.set("https://git.example.com/acme/api/pull/7", "MERGED");
    h.clock.advance(5 * MINUTE);
    await pollPullRequests(h.ctx, project());
    expect(ticketOf(h, "CSV-2").state).toBe("done");
    down = false;
  });

  it("blocks only the ticket whose environment provider stays unavailable for an hour, and starts the others", async () => {
    await seedProject(h, (doc) => {
      doc.ticket[1].depends_on = [];
      doc.agents = { ...doc.agents, max_workers: 2 };
    });
    h.bb.spawnError = (args) => (args.title.includes("CSV-1") ? new SpawnUnavailableError("HTTP 409: No room on this machine.") : null);
    await startWorker(h, "CSV-1");
    for (let n = 0; n < 8; n++) {
      h.clock.advance(15 * MINUTE);
      await startWorker(h, "CSV-1");
    }
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", blocked_reason: expect.stringContaining("the environment provider was unavailable for 1h") });
    const other = await startWorker(h, "CSV-2");
    expect(other).toMatchObject({ state: "active" });
    expect(ticketOf(h, "CSV-2").state).toBe("working");
    expect(project().state).toBe("running");
  });

  it("opens another repo's pull request while one repo's merge waits on its forge, and never two of one repo", async () => {
    await seedRepoProject(h, (doc) => {
      pr(doc);
      doc.ticket.push({ ref: "docs", title: "Web docs", body: "Document the export.", acceptance: ["The docs say how to export."], verify: [], scope: ["docs/**"], depends_on: [], repo: "web" });
    });
    await reachApproved(h, "CSV-1");
    await reachApproved(h, "CSV-3");
    await reachApproved(h, "CSV-2");
    const call = h.host.call.bind(h.host);
    h.host.call = (async (hostId: string, method: string, input: { repo?: string }) => (method === "push" && input.repo === "/src/web" ? { outcome: "unavailable", message: "git push failed: could not resolve host: github.com", transient: "network" } : call(hostId, method as never, input as never))) as typeof h.host.call;
    await queue();
    expect(ticketOf(h, "CSV-1").state).toBe("merging");
    await queue();
    await queue();
    expect(ticketOf(h, "CSV-2").state).toBe("pr_open");
    expect(ticketOf(h, "CSV-3").state).toBe("approved");
    expect(h.store.tickets(project().id, ["merging"]).map((ticket) => ticket.key)).toEqual(["CSV-1"]);
  });

  it("keeps the integration strategy's merges one at a time while a merge waits", async () => {
    await seedRepoProject(h);
    await reachApproved(h, "CSV-1");
    await reachApproved(h, "CSV-2");
    h.host.scripted.merge = [new Error(DEADLINE)];
    await queue();
    await queue();
    expect([ticketOf(h, "CSV-1").state, ticketOf(h, "CSV-2").state]).toEqual(["merging", "approved"]);
  });

  it("pauses the project with the fix when any forge operation's answer breaks the host contract, and blocks only the ticket for another host call's", async () => {
    await seedProject(h, pr);
    await reachApproved(h);
    h.host.errors.prCreate = Object.assign(new Error("Host output did not match schema"), { code: "invalid_output" });
    await queue();
    expect(project()).toMatchObject({ state: "paused", system_reason: expect.stringMatching(/^Merging CSV-1 stopped: Host output did not match schema\. Fix the forge command in the spec/u) });

    h = makeCtx();
    await seedProject(h, pr);
    await reachApproved(h);
    h.host.errors.prCommit = Object.assign(new Error("Host output did not match schema"), { code: "invalid_output" });
    await queue();
    expect(project().state).toBe("running");
    expect(ticketOf(h, "CSV-1").state).toBe("blocked");
  });

  it("sends no forge call while its forge host is backed off, from any step, and waits until the time it named", async () => {
    await seedProject(h, (doc) => {
      pr(doc);
      doc.ticket[1].depends_on = [];
    });
    await reachApproved(h, "CSV-1");
    await queue();
    const until = h.clock.t + 40 * MINUTE;
    h.ctx.forgeBackoffs.set("github.com", { until, delayMs: 15 * MINUTE, message: "API rate limit exceeded" });
    await reachApproved(h, "CSV-2");
    await queue();
    expect(h.host.callsTo("prCreate")).toHaveLength(1);
    expect(ticketOf(h, "CSV-2").state).toBe("merging");
    expect(retryOf(ticketOf(h, "CSV-2"), "merge")).toMatchObject({ scope: "forge", until });

    h.clock.advance(40 * MINUTE);
    await queue();
    expect(h.host.callsTo("prCreate")).toHaveLength(2);
    expect(ticketOf(h, "CSV-2").state).toBe("pr_open");
  });

  it("backs off every read of the forge host after a merge's forge call hit a rate limit or a server error that named a time", async () => {
    await seedProject(h, (doc) => {
      pr(doc);
      doc.ticket[1].depends_on = [];
    });
    await reachApproved(h, "CSV-1");
    await queue();
    await reachApproved(h, "CSV-2");
    h.host.scripted.prCreate = [{ outcome: "unavailable", message: "gh pr create failed: HTTP 429: slow down", transient: "rate_limit", retryAfterMs: 20 * MINUTE }];
    await queue();
    expect(h.ctx.forgeBackoffs.get("github.com")).toMatchObject({ until: h.clock.t + 20 * MINUTE });
    h.clock.advance(5 * MINUTE);
    await pollPullRequests(h.ctx, project());
    expect(h.host.callsTo("prBatch")).toEqual([]);

    h.ctx.forgeBackoffs.clear();
    h.host.scripted.prBatch = [{ outcome: "unavailable", message: "gh api graphql failed: HTTP 503", transient: "server", retryAfterMs: 10 * MINUTE }];
    h.clock.advance(5 * MINUTE);
    await pollPullRequests(h.ctx, project());
    expect(h.ctx.forgeBackoffs.get("github.com")).toMatchObject({ until: h.clock.t + 10 * MINUTE });
  });

  const plannerRounds = () => h.bb.callsTo("send").filter(([id]) => id === "thr_plan").map(([, message]) => message as { summary: string; detail: string });

  it("tells the planner at once when a step waits on a fault of the machine Loom cannot fix, and keeps the project running for hours", async () => {
    await seedProject(h);
    await reachApproved(h);
    h.bb.checkout = null;
    await queue();
    expect(project()).toMatchObject({ state: "running", triage_pending: 1 });
    expect(await maybeSendTriage(h.ctx, project())).toBe(true);
    const round = plannerRounds().at(-1)!;
    expect(round.summary).toBe("[loom] Triage round 1 for csv: 1 ticket waits on something Loom cannot fix.");
    expect(round.detail).toContain("CSV-1 · ");
    expect(round.detail).toContain("has no checkout on the machine");
    for (let hour = 0; hour < 3 * 4; hour++) {
      h.clock.advance(15 * MINUTE);
      await queue();
    }
    expect(project().state).toBe("running");
    expect(ticketOf(h, "CSV-1").state).toBe("merging");
    expect(systemPosts("CSV-1")).toHaveLength(1);
    expect(project().triage_pending).toBe(0);
  });

  it("classifies a host method the machine does not know as a lasting fault of the machine", () => {
    expect(decide(null, { ...at(0), failure: failure("lasting", "host") })).toMatchObject({ do: "wait", wait: { noted: true } });
  });

  it("tells the planner only after an hour when the machine stops answering", async () => {
    await seedProject(h);
    await reachApproved(h);
    h.host.errors.merge = new Error(DEADLINE);
    await queue();
    expect(project().triage_pending).toBe(0);
    for (const minutes of [1, 2, 5, 10, 15, 15]) {
      h.clock.advance(minutes * MINUTE);
      await queue();
    }
    expect(project().triage_pending).toBe(0);
    h.clock.advance(15 * MINUTE);
    await queue();
    expect(project()).toMatchObject({ state: "running", triage_pending: 1 });
    expect(await maybeSendTriage(h.ctx, project())).toBe(true);
    expect(plannerRounds().at(-1)!.detail).toContain(`CSV-1 · "Order rows"`);
    expect(plannerRounds().at(-1)!.detail).toContain(`Failing 8 times since`);
  });

  it("keeps a read failure of an old pull request off the ticket's new one", async () => {
    await seedProject(h, pr);
    await reachApproved(h);
    await queue();
    const seen = ticketOf(h, "CSV-1");
    const call = h.host.call.bind(h.host);
    h.host.call = (async (hostId: string, method: string, input: never) => {
      if (method !== "prBatch") return call(hostId, method as never, input);
      h.store.updateTicket(seen.id, { pr_url: "https://github.com/acme/shop/pull/999", attempt: seen.attempt + 1 });
      return { outcome: "unavailable", message: "gh pr view failed: HTTP 404: Not Found" };
    }) as typeof h.host.call;
    h.clock.advance(5 * MINUTE);
    await pollPullRequests(h.ctx, project());
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "pr_open", pr_url: "https://github.com/acme/shop/pull/999", retry_json: null });
    expect(systemPosts("CSV-1")).toEqual([]);
  });

  it("starts a new streak of read failures for a new pull request", () => {
    const first = nextRetry(null, { step: "read", pr: "https://github.com/acme/shop/pull/1", now: 0, failure: failure("temporary", "ticket") });
    expect(nextRetry(first, { step: "read", pr: "https://github.com/acme/shop/pull/2", now: 5 * MINUTE, failure: failure("temporary", "ticket") })).toMatchObject({ failures: 1, since: 5 * MINUTE, pr: "https://github.com/acme/shop/pull/2" });
  });

  it("keeps the streak of a closed pull request's settling through reads that work, and blocks the ticket after its tries", async () => {
    await seedProject(h, pr);
    await reachApproved(h);
    await queue();
    const seen = ticketOf(h, "CSV-1");
    h.store.updateTicket(seen.id, { pr_base: "loom/gone" });
    h.host.prStates.set(seen.pr_url!, "CLOSED");
    h.host.prMeta.set(seen.pr_url!, { base: "loom/gone" });
    h.host.errors.remoteBranch = new Error("unrecognized branch-read failure");
    const streak: Array<number | undefined> = [];
    for (let i = 0; i < 5; i++) {
      h.clock.advance(15 * MINUTE);
      await pollPullRequests(h.ctx, project());
      streak.push(retryOf(ticketOf(h, "CSV-1"), "settle")?.failures);
    }
    expect(streak).toEqual([1, 2, 3, 4, undefined]);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "blocked", blocked_reason: expect.stringContaining("failed 5 times in a row") });
  });

  it("goes on with a merge's wait after a restart, settling the push whose answer was lost instead of pushing again, and opens the pull request once", async () => {
    await seedProject(h, pr);
    await reachApproved(h);
    h.host.lost.push = [new Error(DEADLINE)];
    await queue();
    const first = h.clock.t;
    expect(ticketOf(h, "CSV-1").state).toBe("merging");
    expect(retryOf(ticketOf(h, "CSV-1"), "merge")).toMatchObject({ failures: 1, until: first + MINUTE, kind: "unknown", scope: "host" });

    restart();
    const calls = h.host.calls.length;
    await queue();
    expect(h.host.calls.length).toBe(calls);
    expect(retryOf(ticketOf(h, "CSV-1"), "merge")).toMatchObject({ failures: 1, until: first + MINUTE });

    h.clock.advance(MINUTE);
    await queue();
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "pr_open", pr_url: "https://github.com/acme/shop/pull/1", retry_json: null });
    expect(h.host.callsTo("prCreate")).toHaveLength(1);
    expect(h.host.callsTo("push")).toHaveLength(1);
    expect(ticketOf(h, "CSV-1").push_json).toBeNull();
    expect(systemPosts("CSV-1")).toHaveLength(1);
    expect(h.store.posts(ticketOf(h, "CSV-1").id).filter((post) => post.kind === "merge" && JSON.parse(post.data_json).outcome === "pr_opened")).toHaveLength(1);
  });
});
