// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SyncStep } from "../src/contract";
import { describeFailure, failureAdvice, failureKind } from "../src/failures";
import { serverText } from "../src/format";
import { RECHECK_MS, RETRY_PAUSE_MS } from "../src/sync";
import { harness, pr, RawRun, testConfig, type Harness } from "./helpers";

const RESTARTING = "Error: 503: walgit: the host serving this repository is restarting; retry in a few seconds (git: rerun the command)";
const FORGE = { name: "Forge", kind: "command" };

/** Answers an operation from a queue, one answer per call, then `rest` for every later call. */
function answer(h: Harness, operation: string, queue: unknown[], rest: unknown = []) {
  Object.defineProperty(h.lists, operation, { configurable: true, enumerable: true, get: () => (queue.length > 0 ? queue.shift() : rest) });
}

const calls = (h: Harness, operation: string) => h.runner.calls.filter((c) => c.operation === operation).length;
const steps = (h: Harness) => JSON.parse(h.store.lastSyncRun("forge")!.steps) as SyncStep[];
const step = (h: Harness, operation: string) => steps(h).find((s) => s.operation === operation)!;

describe("why a sync step failed", () => {
  it("names the cause of the failures seen on GitHub and Delta in plain words", () => {
    const cases: Array<[string, string, string]> = [
      [`whoami printed nothing: ${RESTARTING}`, "unavailable", "Forge was restarting (HTTP 503)"],
      ["gh exited 1: gh: HTTP 502", "unavailable", "Forge had a server error (HTTP 502)"],
      ["gh exited 1: unexpected end of JSON input", "cut_short", "Forge cut its answer short"],
      ["authored took longer than 60s", "timeout", "Forge took too long to answer"],
      ["view exited 1: 0: client error (Connect) 1: dns error 2: failed to lookup address information", "network", "Shuttle could not reach Forge"],
      ["gh exited 1: gh: API rate limit exceeded (HTTP 403)", "rate_limit", "Forge is limiting how often Shuttle asks (HTTP 403)"],
      ["whoami exited 1: Error: 401: walgit: unauthorized", "auth", "Forge did not accept your sign-in (HTTP 401)"],
      ["authored printed JSON in the wrong shape: 0.number: Invalid input", "failed", "authored printed JSON in the wrong shape: 0.number: Invalid input"],
    ];
    for (const [message, kind, summary] of cases) expect(describeFailure(FORGE, { message }), message).toMatchObject({ kind, summary });
  });

  it("finds the fix a command printed, and offers gh auth login for GitHub", () => {
    const delta = describeFailure(FORGE, { message: "whoami exited 1: Error: 401", output: "Error: 401\ndelta.sh: Delta did not accept your sign-in; run `dt auth login`, then sync again", exit: 1, command: "sh delta.sh" });
    expect(delta).toMatchObject({ kind: "auth", fix: "dt auth login", exit: 1, command: "sh delta.sh" });
    expect(describeFailure({ name: "GitHub", kind: "github", hostname: "ghe.test" }, { message: "gh exited 4: To get started with GitHub CLI, please run:  gh auth login" }).fix).toBe("gh auth login --hostname ghe.test");
    expect(failureAdvice(delta, "11:38")).toBe("Run dt auth login, then sync again.");
    expect(failureAdvice({ kind: "unavailable", fix: null }, "11:38")).toBe("This usually passes by itself. Shuttle tries again around 11:38.");
  });

  it("does not read an exit code or a PR number as an HTTP status", () => {
    expect(failureKind("authored exited 127: sh: delta.sh: not found")).toBe("failed");
    expect(failureKind("shop/world#503: was not found")).toBe("failed");
  });
});

describe("sync steps", () => {
  it("keeps what the command printed when it exits 0 with nothing on stdout", async () => {
    const h = harness();
    h.lists.review_requested = [pr(3)];
    answer(h, "authored", [new RawRun({ code: 0, stdout: "", stderr: RESTARTING })], []);
    await h.shuttle.sync();
    expect(step(h, "authored")).toMatchObject({ status: "ok", attempts: 2 });
    answer(h, "authored", [], new RawRun({ code: 0, stdout: "", stderr: RESTARTING }));
    await h.shuttle.sync();
    const failed = step(h, "authored");
    expect(failed).toMatchObject({ status: "failed", attempts: 2 });
    expect(failed.failure).toMatchObject({ kind: "unavailable", summary: "Forge was restarting (HTTP 503)", output: RESTARTING, exit: 0, command: "a" });
    expect(failed.failure!.message).toBe(`authored printed nothing: ${RESTARTING}`);
  });

  it("tries a list that failed with a server error once more after a pause, and passes", async () => {
    const h = harness();
    answer(h, "team_requested", [new Error(RESTARTING)], [pr(4, { teams: ["@shop/edge"] })]);
    await h.shuttle.sync();
    expect(h.pauses).toEqual([RETRY_PAUSE_MS]);
    expect(step(h, "team_requested")).toMatchObject({ status: "ok", attempts: 2, detail: "1 PR" });
    expect(h.shuttle.overview().servers[0]).toMatchObject({ ok: true, state: "ok", failures: 0, alert: false });
  });

  it("never tries again after a rate limit or an error that will not pass, and leaves the rest after a rate limit", async () => {
    const h = harness();
    h.lists.authored = new Error("authored printed JSON in the wrong shape: 0.number: Invalid input") as unknown as unknown[];
    h.lists.team_requested = new Error("Error: 429: slow down") as unknown as unknown[];
    await h.shuttle.sync();
    expect(h.pauses).toEqual([]);
    expect(calls(h, "authored")).toBe(1);
    expect(calls(h, "team_requested")).toBe(1);
    expect(calls(h, "mentioned")).toBe(0);
    expect(step(h, "mentioned")).toMatchObject({ status: "skipped", detail: "Not run: Forge is limiting how often Shuttle asks (HTTP 429)" });
  });

  it("does not run a request that timed out again in the same sync", async () => {
    const h = harness();
    h.lists.review_requested = new RawRun({ code: null, stdout: "", stderr: "", timedOut: true }) as unknown as unknown[];
    await h.shuttle.sync();
    expect(h.pauses).toEqual([]);
    expect(calls(h, "review_requested")).toBe(1);
    expect(step(h, "review_requested").failure).toMatchObject({ kind: "timeout", summary: "Forge took too long to answer" });
    expect(step(h, "team_requested").status).toBe("ok");
  });

  it("asks a server that is down only a little more: two retries a sync, then nothing after two failed steps in a row", async () => {
    const h = harness();
    for (const operation of ["authored", "review_requested", "team_requested", "mentioned"]) h.lists[operation] = new Error(RESTARTING) as unknown as unknown[];
    await h.shuttle.sync();
    // authored: open and closed lists are one step; it and review_requested each fail twice, then the rest wait.
    expect(h.pauses).toEqual([RETRY_PAUSE_MS, RETRY_PAUSE_MS]);
    expect(calls(h, "authored")).toBe(2);
    expect(calls(h, "review_requested")).toBe(2);
    expect(calls(h, "team_requested") + calls(h, "mentioned")).toBe(0);
    expect(steps(h).map((s) => [s.operation, s.status])).toEqual([
      ["whoami", "ok"], ["authored", "failed"], ["review_requested", "failed"], ["team_requested", "skipped"], ["mentioned", "skipped"],
    ]);
    expect(step(h, "mentioned").detail).toBe("Not run: Forge failed twice in a row, so Shuttle leaves it until the next sync");
    expect(h.shuttle.overview().servers[0]!.state).toBe("failed");
  });

  it("skips every list when Shuttle cannot tell who you are, and keeps the login it had", async () => {
    const h = harness();
    await h.shuttle.sync();
    h.answers.whoami = new Error("boom");
    await h.shuttle.sync();
    expect(steps(h).map((s) => [s.operation, s.status, s.detail])).toEqual([
      ["whoami", "failed", null],
      ["authored", "skipped", "Not run: Shuttle could not tell who you are"],
      ["review_requested", "skipped", "Not run: Shuttle could not tell who you are"],
      ["team_requested", "skipped", "Not run: Shuttle could not tell who you are"],
      ["mentioned", "skipped", "Not run: Shuttle could not tell who you are"],
    ]);
    expect(h.shuttle.overview().servers[0]).toMatchObject({ ok: false, state: "failed", login: "me", error: "whoami: whoami exited 1: boom" });
  });
});

describe("a partial sync", () => {
  it("is a warning: only the PRs of the list that failed are stale, with the time that list last passed", async () => {
    const h = harness();
    h.lists.review_requested = [pr(3)];
    h.lists.team_requested = [pr(4, { teams: ["@shop/edge"] }), pr(3, { teams: ["@shop/edge"] })];
    await h.shuttle.sync();
    const passed = h.clock.now;
    h.clock.now += 180_000;
    h.lists.team_requested = new Error("team_requested printed JSON in the wrong shape: items: Invalid input") as unknown as unknown[];
    await h.shuttle.sync();
    const status = h.shuttle.overview().servers[0]!;
    expect(status).toMatchObject({ ok: false, state: "partial", failedSteps: ["team_requested"], failures: 1, alert: false });
    expect(status.failure).toMatchObject({ operation: "team_requested", kind: "failed" });
    const reviews = h.shuttle.list("reviews");
    expect(reviews.find((p) => p.number === 3)).toMatchObject({ stale: false, staleSince: null });
    expect(reviews.find((p) => p.number === 4)).toMatchObject({ stale: true, staleSince: passed });
    expect(h.store.events({ kinds: ["sync_partial"], limit: 5 }).map((e) => e.text)).toEqual([
      "Forge synced, except team requests: team_requested exited 1: team_requested printed JSON in the wrong shape: items: Invalid input. Those PRs show the last good data.",
    ]);
  });

  it("still runs auto reviews for the lists that passed", async () => {
    const h = harness();
    h.store.saveConfig({ ...h.shuttle.config(), autoReview: { ...h.shuttle.config().autoReview, enabled: true, when: ["requested"] } });
    await h.shuttle.sync();
    h.clock.now += 180_000;
    h.lists.review_requested = [pr(3)];
    h.lists.mentioned = new Error("mentioned printed JSON in the wrong shape: x") as unknown as unknown[];
    await h.shuttle.sync();
    expect(h.shuttle.overview().servers[0]!.state).toBe("partial");
    expect(h.port.spawned).toHaveLength(1);
  });
});

describe("a server that failed before 0.3.6", () => {
  it("marks all of its PRs as old until its next sync records each step", async () => {
    const h = harness();
    h.lists.review_requested = [pr(3)];
    await h.shuttle.sync();
    const row = h.store.server("forge")!;
    h.store.saveServer({ ...row, ok: 0, state: "failed", failures: 1, failed_steps: null });
    expect(h.shuttle.list("reviews")[0]).toMatchObject({ stale: true, staleSince: row.last_ok_at });
  });
});

describe("telling the user", () => {
  it("raises the alert at the second failed sync in a row, keeps when it started, and clears it with a passing sync", async () => {
    const h = harness();
    await h.shuttle.sync();
    h.answers.whoami = new Error(RESTARTING);
    h.clock.now += 180_000;
    const first = h.clock.now;
    await h.shuttle.sync();
    expect(h.shuttle.overview().servers[0]).toMatchObject({ state: "failed", failures: 1, alert: false, failingSince: first + RETRY_PAUSE_MS });
    h.clock.now += RECHECK_MS;
    await h.shuttle.sync();
    const status = h.shuttle.overview().servers[0]!;
    expect(status).toMatchObject({ failures: 2, alert: true, failingSince: first + RETRY_PAUSE_MS });
    expect(status.failure).toMatchObject({ operation: "whoami", kind: "unavailable", summary: "Forge was restarting (HTTP 503)" });
    expect(h.store.events({ kinds: ["sync_failed"], limit: 5 }).map((e) => e.text)).toEqual([
      "Forge sync failed: Forge was restarting (HTTP 503) when Shuttle asked for who you are. Its PRs show the last good data.",
    ]);
    delete h.answers.whoami;
    await h.shuttle.sync();
    expect(h.shuttle.overview().servers[0]).toMatchObject({ ok: true, state: "ok", failures: 0, failingSince: null, alert: false, failure: null, failedSteps: [] });
    expect(h.store.events({ kinds: ["sync_ok"], limit: 5 })).toHaveLength(1);
  });

  it("raises the alert at once when the server needs the user to sign in", async () => {
    const h = harness();
    h.answers.whoami = new RawRun({ code: 1, stdout: "", stderr: "Error: 401: walgit: unauthorized\ndelta.sh: Delta did not accept your sign-in; run `dt auth login`, then sync again" });
    await h.shuttle.sync();
    expect(h.pauses).toEqual([]);
    const status = h.shuttle.overview().servers[0]!;
    expect(status).toMatchObject({ failures: 1, alert: true });
    expect(status.failure).toMatchObject({ kind: "auth", fix: "dt auth login" });
  });

  it("syncs a server that failed once again a minute later, only that server and only once", async () => {
    const h = harness();
    await h.shuttle.tick();
    h.answers.whoami = new Error(RESTARTING);
    h.clock.now += h.settings.syncMinutes * 60_000;
    await h.shuttle.tick();
    const failedAt = h.shuttle.overview().servers[0]!.lastSyncAt!;
    expect(h.shuttle.overview().servers[0]!.nextSyncAt).toBe(failedAt + RECHECK_MS);
    const before = calls(h, "whoami");
    h.clock.now = failedAt + RECHECK_MS - 1_000;
    await h.shuttle.tick();
    expect(calls(h, "whoami")).toBe(before);
    h.clock.now = failedAt + RECHECK_MS;
    await h.shuttle.tick();
    // The recheck: whoami and its one retry.
    expect(calls(h, "whoami")).toBe(before + 2);
    expect(h.shuttle.overview().servers[0]).toMatchObject({ failures: 2, alert: true });
    h.clock.now += RECHECK_MS;
    await h.shuttle.tick();
    expect(calls(h, "whoami")).toBe(before + 2);
  });

  it("never syncs sooner after a rate limit", async () => {
    const h = harness();
    await h.shuttle.tick();
    h.answers.whoami = new Error("Error: 429: too many requests");
    h.clock.now += h.settings.syncMinutes * 60_000;
    await h.shuttle.tick();
    const before = calls(h, "whoami");
    h.clock.now += RECHECK_MS * 2;
    await h.shuttle.tick();
    expect(calls(h, "whoami")).toBe(before);
  });
});

describe("asking a server in trouble less", () => {
  it("does not check watched PRs on a server that rate-limited Shuttle or is down", async () => {
    const h = harness();
    h.lists.authored = [pr(1, { author: "me" })];
    await h.shuttle.sync();
    h.port.addThread("thr_owner");
    await h.shuttle.link("forge:shop/world#1", "thr_owner");
    expect(h.shuttle.view("forge:shop/world#1").agent?.mode).not.toBe("off");
    await h.shuttle.sync();
    const polled = calls(h, "activity");
    expect(polled).toBeGreaterThan(0);
    for (const error of ["Error: 429: too many requests", RESTARTING]) {
      h.answers.whoami = new Error(error);
      await h.shuttle.sync();
      expect(calls(h, "activity"), error).toBe(polled);
    }
    delete h.answers.whoami;
    await h.shuttle.sync();
    expect(calls(h, "activity")).toBe(polled + 1);
  });

  it("never retries a gateway timeout", async () => {
    const h = harness();
    h.lists.review_requested = new Error("Error: 504: Gateway Timeout") as unknown as unknown[];
    await h.shuttle.sync();
    expect(h.pauses).toEqual([]);
    expect(step(h, "review_requested").failure).toMatchObject({ kind: "timeout", summary: "Forge took too long to answer (HTTP 504)" });
  });

  it("does not sync sooner when any step of the failed sync was rate-limited", async () => {
    const h = harness();
    await h.shuttle.tick();
    h.lists.review_requested = new Error(RESTARTING) as unknown as unknown[];
    h.lists.team_requested = new Error("Error: 429: too many requests") as unknown as unknown[];
    h.clock.now += h.settings.syncMinutes * 60_000;
    await h.shuttle.tick();
    // The rate limit is what the status shows: it explains why the rest did not run.
    expect(h.shuttle.overview().servers[0]!.failure).toMatchObject({ kind: "rate_limit", operation: "team_requested" });
    expect(step(h, "review_requested").failure?.kind).toBe("unavailable");
    const before = calls(h, "whoami");
    h.clock.now += RECHECK_MS;
    await h.shuttle.tick();
    expect(calls(h, "whoami")).toBe(before);
  });
});

describe("the refresh of linked PRs", () => {
  async function linked() {
    const h = harness();
    h.lists.authored = [pr(1, { author: "me" })];
    h.port.addThread("thr_owner");
    await h.shuttle.sync();
    await h.shuttle.link("forge:shop/world#1", "thr_owner");
    h.views[8] = pr(8, { author: "dana" });
    h.views[9] = pr(9, { author: "dana" });
    await h.shuttle.link("forge:shop/world#8", "thr_owner", "reference");
    await h.shuttle.link("forge:shop/world#9", "thr_owner", "reference");
    h.clock.now += 180_000;
    return h;
  }

  it("reports a rate limit on any PR, backs off and skips the recheck", async () => {
    const h = await linked();
    h.views[8] = new Error("view printed JSON in the wrong shape: x");
    h.views[9] = new Error("Error: 429: too many requests");
    const polled = calls(h, "activity");
    await h.shuttle.sync();
    expect(step(h, "refresh")).toMatchObject({ status: "failed", detail: "2 of 2 could not be read: shop/world#8, shop/world#9" });
    expect(step(h, "refresh").failure).toMatchObject({ kind: "rate_limit", message: "shop/world#9: view exited 1: Error: 429: too many requests" });
    expect(calls(h, "activity")).toBe(polled);
    expect(h.shuttle.overview().servers[0]!.nextSyncAt).toBeGreaterThan(h.clock.now + RECHECK_MS);
  });

  it("counts one PR that could not be reached once, so watched PRs are still checked", async () => {
    const h = await linked();
    h.views[9] = new Error("view exited 1: dns error: failed to lookup address information");
    const polled = calls(h, "activity");
    await h.shuttle.sync();
    expect(step(h, "refresh").failure?.kind).toBe("network");
    expect(calls(h, "activity")).toBe(polled + 1);
  });

  it("keeps a PR current when its own read passed, even though the list that brings it failed", async () => {
    const h = await linked();
    h.lists.review_requested = [pr(8, { author: "dana" })];
    h.clock.now += 180_000;
    await h.shuttle.sync();
    h.clock.now += 180_000;
    h.lists.review_requested = new Error("review_requested printed JSON in the wrong shape: x") as unknown as unknown[];
    await h.shuttle.sync();
    expect(h.shuttle.overview().servers[0]!.failedSteps).toEqual(["review_requested"]);
    expect(h.shuttle.view("forge:shop/world#8")).toMatchObject({ stale: false, staleSince: null });
  });
});

describe("what the status tells the user", () => {
  it("puts a refused sign-in first, even when an earlier step failed for another reason", async () => {
    const h = harness();
    await h.shuttle.sync();
    h.lists.review_requested = new Error("review_requested printed JSON in the wrong shape: x") as unknown as unknown[];
    h.lists.team_requested = new RawRun({ code: 1, stdout: "", stderr: "Error: 401: walgit: unauthorized\ndelta.sh: Delta did not accept your sign-in; run `dt auth login`, then sync again" }) as unknown as unknown[];
    h.clock.now += 180_000;
    await h.shuttle.sync();
    const status = h.shuttle.overview().servers[0]!;
    expect(status).toMatchObject({ alert: true, error: "team_requested: Forge did not accept your sign-in (HTTP 401)" });
    expect(status.failure).toMatchObject({ operation: "team_requested", kind: "auth", fix: "dt auth login" });
    expect(h.shuttle.syncHistory().servers[0]!.failures[0]).toMatchObject({ operation: "team_requested" });
  });
});

describe("syncing some servers", () => {
  const forge = testConfig().servers[0]!;
  const two = () => testConfig({ servers: [forge, { ...forge, id: "other", name: "Other", pattern: "^https://other\\.test/(?<repo>[^/]+/[^/]+)/pull/(?<number>\\d+)", link: "https://other.test/{repo}/pull/{number}" }] });

  it("runs a request for another server after the sync in progress, instead of answering it with that sync", async () => {
    const h = harness(two());
    await Promise.all([h.shuttle.sync(undefined, ["forge"]), h.shuttle.sync(undefined, ["other"])]);
    expect(h.shuttle.overview().servers.map((s) => [s.id, s.state])).toEqual([["forge", "ok"], ["other", "ok"]]);
  });

  it("does not let a sync of one server put off the others' full sync before 0.3.6 recorded one", async () => {
    const h = harness(two());
    await h.shuttle.sync();
    h.store.setKv("full_sync_at", "0");
    h.clock.now += 120_000;
    await h.shuttle.sync(undefined, ["other"]);
    const before = calls(h, "whoami");
    h.clock.now += 60_000;
    await h.shuttle.tick();
    expect(calls(h, "whoami")).toBe(before + 2);
  });

  it("answers a request the sync in progress already covers with that sync", async () => {
    const h = harness(two());
    await Promise.all([h.shuttle.sync(), h.shuttle.sync(undefined, ["other"])]);
    expect(calls(h, "whoami")).toBe(2);
  });
});

describe("auto reviews after a partial sync", () => {
  it("start only from lists that passed, since a list that failed may hold a withdrawn request", async () => {
    const h = harness();
    h.store.saveConfig({ ...h.shuttle.config(), autoReview: { ...h.shuttle.config().autoReview, enabled: true, when: ["requested"] } });
    await h.shuttle.sync();
    h.settings.pauseAutomations = true;
    h.clock.now += 180_000;
    h.lists.review_requested = [pr(3)];
    await h.shuttle.sync();
    expect(h.port.spawned).toHaveLength(0);
    h.settings.pauseAutomations = false;
    h.lists.review_requested = new Error("review_requested printed JSON in the wrong shape: x") as unknown as unknown[];
    await h.shuttle.sync();
    expect(h.shuttle.overview().servers[0]!.state).toBe("partial");
    expect(h.port.spawned).toHaveLength(0);
    h.lists.review_requested = [pr(3)];
    await h.shuttle.sync();
    expect(h.port.spawned).toHaveLength(1);
  });
});

describe("linked PRs no list brings", () => {
  it("are old only when their own read failed", async () => {
    const h = harness();
    h.port.addThread("thr_a");
    h.views[8] = pr(8, { author: "dana" });
    h.views[9] = pr(9, { author: "dana" });
    await h.shuttle.link("forge:shop/world#8", "thr_a");
    await h.shuttle.link("forge:shop/world#9", "thr_a");
    const linkedAt = h.clock.now;
    h.clock.now += 180_000;
    h.views[9] = new Error("view printed JSON in the wrong shape: x");
    await h.shuttle.sync();
    expect(h.shuttle.overview().servers[0]).toMatchObject({ state: "partial", failedSteps: ["refresh"] });
    expect(h.shuttle.view("forge:shop/world#8")).toMatchObject({ stale: false });
    expect(h.shuttle.view("forge:shop/world#9")).toMatchObject({ stale: true, staleSince: linkedAt });
  });
});

describe("bb shuttle status", () => {
  it("says a server that failed before 0.3.6 is failing, with its stored error", async () => {
    const h = harness();
    await h.shuttle.sync();
    h.store.saveServer({ ...h.store.server("forge")!, ok: 0, state: "failed", failures: 1, failed_steps: null, error: "whoami did not print JSON: no output" });
    expect(serverText(h.shuttle.overview().servers[0]!, h.clock.now)).toMatch(/^forge {3}failing: whoami did not print JSON: no output · synced \d\d:\d\d$/u);
  });

  it("says why a server fails, what its command printed and what happens next", async () => {
    const h = harness();
    await h.shuttle.sync();
    expect(serverText(h.shuttle.overview().servers[0]!, h.clock.now)).toMatch(/^forge {3}ok as me · synced \d\d:\d\d$/u);
    h.answers.whoami = new RawRun({ code: 1, stdout: "", stderr: RESTARTING });
    await h.shuttle.sync();
    await h.shuttle.sync();
    expect(serverText(h.shuttle.overview().servers[0]!, h.clock.now).split("\n")).toEqual([
      expect.stringMatching(/^forge {3}failing since \d\d:\d\d: Forge was restarting \(HTTP 503\) \(whoami\)$/u),
      `        | ${RESTARTING}`,
      expect.stringMatching(/^ {8}last good sync \d\d:\d\d · 2 syncs in a row$/u),
      expect.stringMatching(/^ {8}This usually passes by itself\. Shuttle tries again around \d\d:\d\d\.$/u),
    ]);
  });
});

describe("sync history", () => {
  it("has the last three hours of syncs, the last failed one in full, and a week of failures", async () => {
    const h = harness();
    await h.shuttle.sync();
    h.clock.now += 180_000;
    h.lists.mentioned = new Error("mentioned printed JSON in the wrong shape: x") as unknown as unknown[];
    await h.shuttle.sync();
    const [forge] = h.shuttle.syncHistory().servers;
    expect(forge!.runs.map((r) => r.state)).toEqual(["ok", "partial"]);
    expect(forge!.lastFailure!.steps.find((s) => s.operation === "mentioned")).toMatchObject({ status: "failed" });
    expect(forge!.failures).toEqual([{ at: h.clock.now, state: "partial", operation: "mentioned", summary: "mentioned exited 1: mentioned printed JSON in the wrong shape: x", output: "mentioned printed JSON in the wrong shape: x" }]);
    expect(forge!.averageMs).toBe(0);
  });

  it("keeps passing syncs a day and the others a week", () => {
    const h = harness();
    const at = h.clock.now;
    const run = (offset: number, state: "ok" | "failed") => h.store.addSyncRun({ server: "forge", at: at - offset, duration_ms: 1, state, steps: "[]" });
    run(25 * 3_600_000, "ok");
    run(25 * 3_600_000, "failed");
    run(8 * 86_400_000, "failed");
    run(0, "ok");
    expect(h.store.syncRuns("forge", 0).map((r) => [at - r.at, r.state])).toEqual([[25 * 3_600_000, "failed"], [0, "ok"]]);
  });
});
