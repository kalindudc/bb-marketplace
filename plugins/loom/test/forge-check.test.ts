import { experimental_PluginRpcCallError as PluginRpcCallError } from "@get-bb/plugin-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { createCli } from "../src/cli";
import { forgeCheck, formatForgeCheck } from "../src/forge-check";
import { FakePort, makeCtx, makeHost, seedProject, seedRepoProject, specToml, ticketOf, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;
beforeEach(() => {
  h = makeCtx();
});

const URL = "https://github.com/acme/shop/pull/7";
// A forge that reports no checks has no CI for Loom to rely on.
const pr = (more: Doc = {}) => (doc: Doc) => {
  doc.merge = { strategy: "pr", ...more };
  if (more.forge?.kind === "none" || (more.forge?.kind === "command" && more.forge.feedback === undefined)) doc.checks.ci = false;
};
const opened = (key = "CSV-1", url = URL) => h.store.updateTicket(ticketOf(h, key).id, { state: "pr_open", pr_url: url, pr_branch: `loom/csv/${key.toLowerCase()}-1`, pushed_sha: "sq1" });
const check = (target: string, more: { repo?: string; version?: number } = {}) => forgeCheck(h.ctx, { slug: "csv", target, ...more });
const FEEDBACK = {
  base: "main",
  review: "CHANGES_REQUESTED" as const,
  checks: [
    { key: "check:3", name: "build", state: "passed" as const, url: null },
    { key: "check:9", name: "lint", state: "failed" as const, url: "https://ci.example.com/9" },
  ],
  items: [{ key: "review:1:a", kind: "review" as const, author: "alice", bot: false, body: "Rename the column.\n\nIt reads oddly.", url: null, state: "changes_requested", path: null, line: null }],
};

describe("forgeCheck", () => {
  it("reads a ticket's pull request with gh's batch read, as a poll does, and changes nothing in Loom", async () => {
    await seedProject(h, pr());
    opened();
    h.host.feedback.set(URL, FEEDBACK);
    h.host.prMeta.set(URL, { mergeable: false });
    const events = h.store.events(h.store.projectBySlug("csv")!.id).length;
    const before = ticketOf(h, "CSV-1");

    const result = await check("CSV-1");
    expect(h.host.callsTo("prBatch")).toEqual([{ repo: "/repo", host: "github.com", owner: "acme", name: "shop", numbers: [7], feedback: true }]);
    expect(result).toMatchObject({ slug: "csv", url: URL, ticket: "CSV-1", repo: null, version: 1, forge: "gh", call: "prBatch", runs: "gh api graphql", hostId: "host_1", checkout: "/repo", failure: null, noFeedback: null });
    expect(result.read).toEqual({
      state: "OPEN",
      draft: false,
      review: null,
      base: null,
      mergeable: false,
      head: "sq1",
      author: "kalindudc",
      checks: [
        { name: "build", state: "passed", key: "check:3", url: null },
        { name: "lint", state: "failed", key: "check:9", url: "https://ci.example.com/9" },
      ],
      ignored: [],
      items: [{ kind: "review", author: "alice", bot: false, key: "review:1:a", line: "Rename the column." }],
      description: null,
    });
    expect(h.store.events(h.store.projectBySlug("csv")!.id)).toHaveLength(events);
    expect(ticketOf(h, "CSV-1")).toEqual(before);

    const text = formatForgeCheck(result);
    expect(text).toContain(`Read ${URL} (CSV-1) as a poll of csv would: the forge of spec v1 (gh), prBatch on host_1 in /repo.`);
    expect(text).toContain("State OPEN · draft no · review unknown · base unknown · mergeable no · head sq1 · author kalindudc");
    expect(text).toContain("  failed  lint  (check:9)");
    expect(text).toContain("  review  alice  review:1:a  Rename the column.");
  });

  it("shows the checks ignore_checks drops, and whether the description has Loom's markers", async () => {
    await seedProject(h, pr({ forge: { kind: "gh", ignore_checks: ["lint"] } }));
    opened();
    h.host.feedback.set(URL, FEEDBACK);
    h.host.texts.set(URL, { title: "Add rows", body: "Why\n\n<!-- loom:begin -->\nOpened by Loom for CSV-1.\n<!-- loom:end -->" });
    const result = await check("CSV-1");
    expect(result.read).toMatchObject({ checks: [{ name: "build" }], ignored: ["lint"], description: { chars: 68, block: "one" } });
    const text = formatForgeCheck(result);
    expect(text).toContain("Checks: 1\n");
    expect(text).toContain("Dropped by ignore_checks: 1\n  lint");
    expect(text).toContain("Description: 68 characters, with Loom's markers, so Loom can refresh its Rollout section.");
    h.host.texts.set(URL, { title: "Add rows", body: "Why" });
    expect(formatForgeCheck(await check("CSV-1"))).toContain("Description: 3 characters, with no Loom markers, so Loom cannot refresh its Rollout section.");
    h.host.texts.set(URL, { title: "Add rows", body: "<!-- loom:begin -->\na\n<!-- loom:end -->\n<!-- loom:begin -->\nb\n<!-- loom:end -->" });
    expect(formatForgeCheck(await check("CSV-1"))).toContain("with Loom's markers more than once, so Loom cannot tell its own section and does not refresh it.");
  });

  it("reads no feedback when the spec follows only merged and closed", async () => {
    await seedProject(h, pr({ max_fix_rounds: 0 }));
    const result = await check(URL);
    expect(h.host.callsTo("prBatch")[0]).toMatchObject({ numbers: [7], feedback: false });
    expect(result.read).toMatchObject({ state: "OPEN", checks: null, items: null, head: null });
    expect(formatForgeCheck(result)).toContain("No checks or items: merge.max_fix_rounds is 0 in v1");
  });

  it("runs a command forge's feedback command, else its state command, and --version runs a pending version's forge", async () => {
    await seedProject(h, pr({ forge: { kind: "command", open: "open.sh", state: "state.sh" } }));
    const pull = "https://forge.example.com/shop/pull/12";
    opened("CSV-1", pull);
    h.host.prStates.set(pull, "MERGED");
    const stated = await check("CSV-1");
    expect(h.host.callsTo("prState")).toEqual([{ repo: "/repo", url: pull, forge: { kind: "command", state: "state.sh" } }]);
    expect(stated).toMatchObject({ forge: "command", call: "prState", runs: "state.sh", read: { state: "MERGED", draft: null, checks: null }, noFeedback: "this forge has no feedback command, so Loom reads only the state" });

    await h.projects.propose({ toml: specToml((doc) => pr({ forge: { kind: "command", open: "open.sh", state: "state.sh", feedback: "feedback.sh" } })(doc)), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_1" });
    const pending = await check("CSV-1", { version: 2 });
    expect(h.host.callsTo("prFeedback")).toEqual([{ repo: "/repo", url: pull, forge: { kind: "command", feedback: "feedback.sh" } }]);
    expect(pending).toMatchObject({ version: 2, call: "prFeedback", runs: "feedback.sh", read: { state: "MERGED" } });
    expect((await check("CSV-1")).call).toBe("prState");
  });

  it("reports a failed read with the kind of failure a poll waits out, and the fields the host contract refused", async () => {
    await seedProject(h, pr({ forge: { kind: "command", open: "open.sh", state: "state.sh", feedback: "feedback.sh" } }));
    const pull = "https://forge.example.com/shop/pull/12";
    h.host.scripted.prFeedback = [{ outcome: "unavailable", message: "The forge's feedback command failed (exit 1): HTTP 503", transient: "server" }];
    const busy = await check(pull);
    expect(busy).toMatchObject({ read: null, failure: { message: "The forge's feedback command failed (exit 1): HTTP 503", transient: "server", issues: [] } });
    expect(formatForgeCheck(busy)).toContain("A poll waits this out as a server error or timeout");

    h.host.scripted.prFeedback = [new PluginRpcCallError({ code: "invalid_output", message: "rpc output validation failed", issues: [{ path: ["checks", 0, "state"], message: 'Invalid option: expected one of "pending"|"passed"|"failed"|"neutral"' }] })];
    const refused = await check(pull);
    expect(refused.failure).toMatchObject({ transient: null, issues: [{ path: "checks[0].state", message: 'Invalid option: expected one of "pending"|"passed"|"failed"|"neutral"' }] });
    const text = formatForgeCheck(refused);
    expect(text).toContain("A poll pauses the project for a failure like this one.");
    expect(text).toContain('The host contract refused these fields:\n  checks[0].state: Invalid option: expected one of "pending"|"passed"|"failed"|"neutral"');
  });

  it("refuses a forge with no pull request, a ticket without one, an unknown ticket, a missing version and a repo it cannot tell", async () => {
    await seedProject(h, pr({ forge: { kind: "none" } }));
    await expect(check(URL)).rejects.toMatchObject({ code: "loom_invalid_input", message: expect.stringContaining("is none: Loom only pushes the branch") });
    await expect(check("CSV-1")).rejects.toMatchObject({ code: "loom_invalid_input", message: "CSV-1 has no pull request yet." });
    await expect(check("CSV-9")).rejects.toMatchObject({ code: "loom_not_found" });
    await expect(check(URL, { version: 4 })).rejects.toMatchObject({ code: "loom_not_found", message: "csv has no spec v4." });

    h = makeCtx();
    await seedRepoProject(h, pr());
    await expect(check(URL)).rejects.toMatchObject({ code: "loom_invalid_input", hint: expect.stringContaining("--repo, one of: web, api, docs") });
    await check(URL, { repo: "api" });
    expect(h.host.callsTo("prBatch")[0]).toMatchObject({ repo: "/src/api" });
    await expect(check(URL, { repo: "nope" })).rejects.toMatchObject({ code: "loom_invalid_input", message: expect.stringContaining('no repo "nope"') });
  });
});

describe("bb loom forge check", () => {
  it("prints the read for the human and for an agent thread, exits 1 on a failed read, and writes no human.action event", async () => {
    const host = makeHost({ port: new FakePort() });
    host.bb.cli.register(createCli(host.projects, host.engine, host.store, Date.now));
    await host.projects.propose({ toml: specToml(pr()), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_env" });
    await host.projects.approve("csv", "human");
    const run = (argv: string[], threadId?: string) => host.harness.runCli(argv, threadId === undefined ? undefined : { threadId });

    const out = await run(["forge", "check", "csv", URL], "thr_plan");
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("State OPEN");
    expect(JSON.parse((await run(["forge", "check", "csv", URL, "--json"])).stdout)).toMatchObject({ call: "prBatch", read: { state: "OPEN" } });

    host.hostPort.scripted.prBatch = [{ outcome: "unavailable", message: "gh api graphql failed: HTTP 502", transient: "server" }];
    const failed = await run(["forge", "check", "csv", URL]);
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout).toContain("The read failed: gh api graphql failed: HTTP 502");
    expect(host.store.events(host.store.projectBySlug("csv")!.id).filter((event) => event.kind === "human.action")).toEqual([]);
  });
});
