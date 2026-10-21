// @vitest-environment node
// The integration merge over the real host operations and a real git repository, with only bb and the workers' side faked.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as ops from "../src/host/ops";
import { runMergeQueue, settleMerges } from "../src/merge";
import type { HostPort } from "../src/ports";
import { specOf } from "../src/workers";
import { makeCtx, reachApproved, seedProject, ticketOf, type Doc, type EngineHarness } from "./helpers";

const saved: Record<string, string | undefined> = {};
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

let scratch: string;
let counter = 0;
let h: EngineHarness;
let repo: string;
let dataDir: string;
let failExecOnce = false;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "loom-merge-")));
  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) saved[key] = process.env[key];
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  failExecOnce = false;
});

// A commit on its own branch, off main, the way a reviewed worker leaves one.
function feature(branch: string, path: string, content: string): string {
  sh(repo, "checkout", "-q", "-b", branch, "main");
  writeFileSync(join(repo, path), content);
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", `${branch}: ${path}`);
  const sha = sh(repo, "rev-parse", "HEAD");
  sh(repo, "checkout", "-q", "main");
  return sha;
}

/** The workers and reviewers run over the fake host; only the Loom worktree, where the merge happens, is real. */
async function setup(edit: (doc: Doc) => void): Promise<string> {
  repo = join(scratch, `repo-${counter++}`);
  dataDir = join(scratch, `data-${counter++}`);
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "dev@example.com");
  sh(repo, "config", "user.name", "Dev");
  writeFileSync(join(repo, "README.md"), "hello\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "init");
  await ops.ensureBranch({ repo, branch: "loom/csv", from: "main" });
  const reviewed = feature("worker-1", "feature", "reviewed\n");

  h = makeCtx();
  await seedProject(h, edit);
  await reachApproved(h);
  h.store.updateTicket(ticketOf(h, "CSV-1").id, { head_sha: reviewed });
  h.bb.checkout = repo;
  const fake = h.ctx.host;
  const real = (method: string, input: Record<string, unknown>) => method === "ensureWorktree" || [input.worktree, input.cwd].some((path) => typeof path === "string" && path.startsWith(dataDir));
  const host: HostPort = {
    call: async (hostId, method, input) => {
      if (!real(method, input as Record<string, unknown>)) return fake.call(hostId, method, input);
      if (method === "exec" && failExecOnce) {
        failExecOnce = false;
        throw new Error("host disconnected");
      }
      if (method === "ensureWorktree") return (await ops.ensureWorktree(input as Parameters<typeof ops.ensureWorktree>[0], dataDir)) as never;
      return (await (ops[method as "merge"] as (input: unknown) => Promise<unknown>)(input)) as never;
    },
  };
  h.ctx.host = host;
  return reviewed;
}

const queue = async () => {
  const project = h.store.projectBySlug("csv")!;
  await runMergeQueue(h.ctx, project, specOf(h.store, project));
  await settleMerges(h.ctx);
};
const lastPost = (kind: string) => h.store.posts(ticketOf(h, "CSV-1").id).filter((post) => post.kind === kind).at(-1)!;

describe("the integration merge against a real repository", () => {
  it("rolls back an after_merge command that commits, instead of certifying the commit it made", async () => {
    await setup((doc) => (doc.checks.after_merge = ["printf 'unchecked\\n' > feature && git add feature && git commit -q -m unchecked"]));
    const before = sh(repo, "rev-parse", "loom/csv");
    await queue();

    expect(sh(repo, "rev-parse", "loom/csv")).toBe(before);
    expect(sh(repo, "ls-tree", "--name-only", "loom/csv")).not.toContain("feature");
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", check_failures: 1 });
    expect(lastPost("check").body).toContain("changed the branch: moved HEAD");
    expect(h.store.posts(ticketOf(h, "CSV-1").id).filter((post) => post.kind === "merge")).toEqual([]);
  });

  it("rolls back an after_merge command that edits a tracked file", async () => {
    await setup((doc) => (doc.checks.after_merge = ["printf 'edited\\n' > feature"]));
    const before = sh(repo, "rev-parse", "loom/csv");
    await queue();

    expect(sh(repo, "rev-parse", "loom/csv")).toBe(before);
    expect(ticketOf(h, "CSV-1").state).toBe("working");
    expect(lastPost("check").body).toContain("left tracked files modified");
  });

  it("completes the merge when an after_merge command only leaves untracked files behind", async () => {
    await setup((doc) => (doc.checks.after_merge = ["echo report > coverage.txt"]));
    await queue();

    expect(ticketOf(h, "CSV-1").state).toBe("done");
    expect(JSON.parse(lastPost("merge").data_json).sha).toBe(sh(repo, "rev-parse", "loom/csv"));
  });

  it("rolls back to the point persisted before the merge when a rerun finds it made and after_merge then fails", async () => {
    await setup((doc) => (doc.checks.after_merge = [`test ! -f ${scratch}/fail-${counter}`]));
    const before = sh(repo, "rev-parse", "loom/csv");
    failExecOnce = true;
    await queue();
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "merging", merge_before: before });
    expect(sh(repo, "rev-parse", "loom/csv^1")).toBe(before);

    writeFileSync(join(scratch, `fail-${counter}`), "");
    h.store.setProjectState(h.store.projectBySlug("csv")!.id, "running", "human");
    await queue();
    expect(sh(repo, "rev-parse", "loom/csv")).toBe(before);
    expect(ticketOf(h, "CSV-1").state).toBe("working");
  });

  it("leaves another ticket's completed merge in place when a second ticket's target was already merged", async () => {
    const reviewed = await setup((doc) => (doc.checks.after_merge = [`test ! -f ${scratch}/fail-${counter}`]));
    await queue();
    expect(ticketOf(h, "CSV-1").state).toBe("done");
    const merged = sh(repo, "rev-parse", "loom/csv");
    expect(sh(repo, "rev-parse", "loom/csv^2")).toBe(reviewed);

    await reachApproved(h, "CSV-2");
    h.store.updateTicket(ticketOf(h, "CSV-2").id, { head_sha: reviewed });
    writeFileSync(join(scratch, `fail-${counter}`), "");
    await queue();

    expect(ticketOf(h, "CSV-2").state).toBe("working");
    expect(sh(repo, "rev-parse", "loom/csv")).toBe(merged);
    expect(existsSync(join(dataDir, "worktrees", "csv", "feature"))).toBe(true);
  });
});
