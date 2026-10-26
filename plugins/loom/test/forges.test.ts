import { beforeEach, describe, expect, it } from "vitest";
import { land, pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import type { SpawnArgs } from "../src/ports";
import { spawnReviewers } from "../src/review";
import { specOf } from "../src/workers";
import { GIT_WORKTREE_PROVIDER, makeCtx, reachApproved, reachReview, seedProject, specToml, ticketOf, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;

beforeEach(() => {
  h = makeCtx();
});

const project = () => h.store.projectBySlug("csv")!;
const queue = async () => {
  await runMergeQueue(h.ctx, project(), specOf(h.store, project()));
  await settleMerges(h.ctx);
};
const lastPost = (kind: string, key = "CSV-1") =>
  h.store
    .posts(ticketOf(h, key).id)
    .filter((post) => post.kind === kind)
    .at(-1)!;
const prStrategy = (forge: Doc) => (doc: Doc) => (doc.merge = { strategy: "pr", forge, describe: "loom", squash: false, max_fix_rounds: 0 });
const COMMAND_FORGE = { kind: "command", open: "review create", state: "review state", after_open: ['ci run --pr "$LOOM_PR_NUMBER"'] };

describe("a forge of the spec's own commands", () => {
  it("opens the pull request with the open command, follows it with the state command, and runs after_open with its URL", async () => {
    await seedProject(h, prStrategy(COMMAND_FORGE));
    await reachApproved(h);
    await queue();

    expect(h.host.callsTo("prCreate")[0]).toMatchObject({ forge: { kind: "command", open: "review create" } });
    const url = ticketOf(h, "CSV-1").pr_url!;
    expect(h.host.callsTo("exec").at(-1)).toMatchObject({ command: 'ci run --pr "$LOOM_PR_NUMBER"', env: { LOOM_URL: url, LOOM_PR_NUMBER: "1", LOOM_BASE: "main" } });

    h.host.prStates.set(url, "MERGED");
    h.clock.advance(5 * 60_000);
    await pollPullRequests(h.ctx, project());
    expect(h.host.callsTo("prState")).toEqual([{ repo: "/repo", url, forge: { kind: "command", state: "review state" } }]);
    expect(ticketOf(h, "CSV-1").state).toBe("done");
  });

  it("posts a failed after_open command and keeps the pull request open", async () => {
    await seedProject(h, prStrategy(COMMAND_FORGE));
    await reachApproved(h);
    h.host.onExec = (input) => {
      if (input.command.startsWith("ci run")) h.host.execResults.unshift({ exitCode: 3, output: "ci is down" });
    };
    await queue();
    expect(ticketOf(h, "CSV-1").state).toBe("pr_open");
    const post = lastPost("merge");
    expect(post.body).toContain("The after_open command `ci run --pr \"$LOOM_PR_NUMBER\"` failed (exit 3)");
    expect(post.body).toContain("ci is down");
    expect(JSON.parse(post.data_json!)).toMatchObject({ outcome: "after_open_failed" });
  });
});

describe("the push-only forge", () => {
  it("pushes the branch with no pull request, and completes the ticket once the remote base contains its commit", async () => {
    await seedProject(h, prStrategy({ kind: "none" }));
    await reachApproved(h);
    await queue();

    expect(h.host.callsTo("prCreate")).toEqual([]);
    const ticket = ticketOf(h, "CSV-1");
    expect(ticket).toMatchObject({ state: "pr_open", pr_url: null });
    expect(lastPost("merge").body).toBe(`Pushed ${ticket.branch} to origin. Open its pull request there; Loom completes the ticket when origin/main contains ${ticket.head_sha!.slice(0, 12)}.`);

    h.clock.advance(5 * 60_000);
    await pollPullRequests(h.ctx, project());
    expect(h.host.callsTo("landedOn")).toEqual([{ repo: "/repo", remote: "origin", base: "main", sha: ticket.head_sha }]);
    expect(ticketOf(h, "CSV-1").state).toBe("pr_open");

    h.host.landed.add(ticket.head_sha!);
    h.clock.advance(5 * 60_000);
    await pollPullRequests(h.ctx, project());
    expect(ticketOf(h, "CSV-1").state).toBe("done");
    expect(lastPost("merge").body).toBe("The branch landed on origin/main.");
  });

  it("lands the integration branch by pushing it, with no pull request", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "integration", forge: { kind: "none" } }));
    await reachApproved(h);
    await queue();
    const result = await land(h.ctx, "csv", { actor: "human", ready: false });
    expect(result).toMatchObject({ url: null, pushed: "origin/loom/csv" });
    expect(h.host.callsTo("prCreate")).toEqual([]);
    expect(project().pr_url).toBeNull();
  });
});

describe("a prepared integration worktree", () => {
  beforeEach(() => {
    h.bb.pluginList = [...h.bb.pluginList, { id: "trees", enabled: true, builtin: false }];
  });

  it("runs the command before the merge and merges in the path it printed last", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "integration", worktree: { command: "prepare-tree" } }));
    await reachApproved(h);
    const mark = h.host.calls.length;
    h.host.execResults.push({ output: "==> preparing\n/trees/loom-csv\n" });
    await queue();

    expect(h.host.calls.slice(mark).find((call) => call.method === "exec")!.input).toMatchObject({ cwd: "/repo", command: "prepare-tree", env: { LOOM_PROJECT_SLUG: "csv", LOOM_BRANCH: "loom/csv", LOOM_BASE: "main" } });
    expect(h.host.callsTo("ensureWorktree")[0]).toMatchObject({ key: "csv", branch: "loom/csv", path: "/trees/loom-csv" });
    expect(h.host.callsTo("merge")[0]).toMatchObject({ worktree: "/trees/loom-csv" });
  });

  it("runs a plugin's CLI command through bb plugin run", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "integration", worktree: { plugin: "trees", command: 'prepare "loom-$LOOM_PROJECT_SLUG"' } }));
    await reachApproved(h);
    const mark = h.host.calls.length;
    h.host.execResults.push({ output: "/trees/loom-csv" });
    await queue();
    expect(h.host.calls.slice(mark).find((call) => call.method === "exec")!.input).toMatchObject({ command: 'bb plugin run trees prepare "loom-$LOOM_PROJECT_SLUG"' });
  });

  it("pauses the project, merging nothing, when the command prints no absolute path", async () => {
    await seedProject(h, (doc) => (doc.merge = { strategy: "integration", worktree: { command: "prepare-tree" } }));
    await reachApproved(h);
    h.host.execResults.push({ output: "done" });
    await queue();
    expect(h.host.callsTo("merge")).toEqual([]);
    expect(project().state).toBe("paused");
    expect(project().system_reason).toContain("must print the worktree's absolute path on its last line");
  });
});

describe("an environment provider for workers and reviewers", () => {
  const withTrees = (doc: Doc) => (doc.environment = { provider: "trees", inputs: { pool: { branch: "{branch}", base: "{base}", paths: ["services/orders"] } } });

  beforeEach(() => {
    h.bb.environmentProviderList = [GIT_WORKTREE_PROVIDER, { ...GIT_WORKTREE_PROVIDER, id: "trees", displayName: "Trees", pluginId: "trees", acceptsEmptyInputs: false, inputs: { type: "object", required: ["pool"] } }];
    h.bb.pluginList = [...h.bb.pluginList, { id: "trees", enabled: true, builtin: false }];
  });

  it("starts the worker and the reviewer in the provider, each on its own branch from its base", async () => {
    await seedProject(h, (doc) => {
      doc.merge = { strategy: "pr" };
      withTrees(doc);
    });
    await reachReview(h);
    const worker = h.bb.callsTo("spawnThread")[0]![0] as SpawnArgs;
    expect(worker.environment).toEqual({ providerId: "trees", inputs: { pool: { branch: "loom/csv/csv-1-1", base: "origin/main", paths: ["services/orders"] } } });

    await spawnReviewers(h.ctx, project(), specOf(h.store, project()));
    const reviewer = h.bb.callsTo("spawnThread").at(-1)![0] as SpawnArgs;
    const row = h.store.threads({ ticketId: ticketOf(h, "CSV-1").id, role: "reviewer" }).at(-1)!;
    expect(reviewer.environment).toEqual({ providerId: "trees", inputs: { pool: { branch: `loom/csv/csv-1-review-1-${row.id}`, base: reviewer.baseBranch, paths: ["services/orders"] } } });
  });

  it("keeps the managed worktree for git-worktree with no inputs", async () => {
    await seedProject(h, (doc) => (doc.environment = { provider: "git-worktree" }));
    await reachReview(h);
    expect((h.bb.callsTo("spawnThread")[0]![0] as SpawnArgs).environment).toBeUndefined();
  });

  it("starts reviewers in the environment's reviewer table, and each ticket's threads with its own inputs patch", async () => {
    await seedProject(h, (doc) => {
      doc.merge = { strategy: "pr" };
      doc.environment = { provider: "trees", inputs: { pool: { branch: "{branch}", base: "{base}", paths: ["services/orders", "services/billing"] } }, reviewer: { inputs: { pool: { light: true } } } };
      doc.ticket[0].environment = { inputs: { pool: { paths: ["services/orders"] } } };
    });
    await reachReview(h);
    const worker = h.bb.callsTo("spawnThread")[0]![0] as SpawnArgs;
    expect(worker.environment).toEqual({ providerId: "trees", inputs: { pool: { branch: "loom/csv/csv-1-1", base: "origin/main", paths: ["services/orders"] } } });
    await spawnReviewers(h.ctx, project(), specOf(h.store, project()));
    const reviewer = h.bb.callsTo("spawnThread").at(-1)![0] as SpawnArgs;
    expect(reviewer.environment).toMatchObject({ providerId: "trees", inputs: { pool: { paths: ["services/orders"], light: true } } });
    expect(reviewer.prompt).toContain("This worktree may hold only part of the repository. Read any file at that commit, checked out or not, with `git show");
  });

  it("checks a reviewer provider and each ticket's patched inputs against bb's providers when the spec is proposed", async () => {
    const strict = { ...GIT_WORKTREE_PROVIDER, id: "trees", displayName: "Trees", pluginId: "trees", acceptsEmptyInputs: false, inputs: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { pool: { type: "object", properties: { paths: { type: "array", minItems: 1, items: { type: "string" } } } } }, required: ["pool"] } };
    h.bb.environmentProviderList = [GIT_WORKTREE_PROVIDER, strict];
    const error = await h.projects
      .propose({
        toml: specToml((doc) => {
          doc.environment = { provider: "trees", inputs: { pool: { paths: ["services/orders"] } }, reviewer: { provider: "readers" } };
          doc.ticket[1].environment = { inputs: { pool: { paths: [] } } };
        }),
        threadId: "thr_plan",
        bbProjectId: "proj_1",
        hostId: "host_1",
      })
      .catch((caught: Error) => caught);
    expect((error as Error).message).toContain('environment.reviewer.provider: bb has no environment provider "readers" for the project\'s repository on this machine.');
    expect((error as Error).message).toContain("ticket[1].environment.inputs: pool.paths:");
  });
});
