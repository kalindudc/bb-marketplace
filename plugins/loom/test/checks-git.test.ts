// @vitest-environment node
// The submit pipeline over the real host operations and a real git repository, with only bb faked.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { settleChecks, submit } from "../src/checks";
import type { HostPort } from "../src/ports";
import * as ops from "../src/host/ops";
import { makeCtx, seedProject, seedRepoProject, startWorker, ticketOf, type Doc, type EngineHarness } from "./helpers";

const saved: Record<string, string | undefined> = {};
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const put = (root: string, path: string, content: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
};

const realHost: HostPort = { call: async (_hostId, method, input) => (await (ops[method] as (input: unknown) => Promise<unknown>)(input)) as never };

let scratch: string;
let counter = 0;
let h: EngineHarness;
let worktree: string;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "loom-checks-")));
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

/** CSV-1's worker in a fresh repository; with `repos`, the project is seedRepoProject's and CSV-1 is in its repo web. */
async function worker(edit?: (doc: Doc) => void, opts: { repos?: boolean } = {}) {
  const repo = join(scratch, `repo-${counter++}`);
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "dev@example.com");
  sh(repo, "config", "user.name", "Dev");
  put(repo, "README.md", "hello\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "init");
  await ops.ensureBranch({ repo, branch: "loom/csv", from: "main" });
  worktree = join(scratch, `wt-${counter++}`);
  sh(repo, "worktree", "add", "-q", "-b", "wt-feature", worktree, "loom/csv");

  h = makeCtx();
  h.ctx.host = realHost;
  await (opts.repos === true ? seedRepoProject : seedProject)(h, edit);
  await startWorker(h);
  h.bb.environments.get("env_1")!.path = worktree;
  h.bb.environments.get("env_1")!.branchName = "wt-feature";
}

beforeEach(() => {
  h = makeCtx();
});

const lastCheck = () => {
  const post = h.store.posts(ticketOf(h, "CSV-1").id).filter((p) => p.kind === "check").at(-1)!;
  return { body: post.body, data: JSON.parse(post.data_json) as { passed: boolean; outside: string[]; protectedHits: string[] } };
};

describe("submit against a real repository", () => {
  it("commits the worker's files, runs the checks in the worktree and moves the ticket to review at the commit it made", async () => {
    await worker((doc) => (doc.checks = { commands: ["test -f src/model/a.ts && echo mapped"] }));
    put(worktree, "src/model/a.ts", "export const a = 1;\n");
    submit(h.ctx, "thr_w1", "Mapped");
    await settleChecks(h.ctx);

    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "review", head_sha: sh(worktree, "rev-parse", "HEAD"), branch: "wt-feature" });
    expect(sh(worktree, "log", "-1", "--format=%s")).toBe("CSV-1: Order rows");
    expect(sh(worktree, "status", "--porcelain")).toBe("");
    expect(lastCheck().data).toMatchObject({ passed: true, outside: [], protectedHits: [] });
    expect(lastCheck().body).toContain("pass test -f src/model/a.ts && echo mapped");
  });

  it("flags a file outside the ticket's scope and fails a protected path, reporting the files", async () => {
    await worker((doc) => ((doc.scope = { protected: ["db/**"] }), (doc.checks = { commands: ["true"] })));
    put(worktree, "src/model/a.ts", "x");
    put(worktree, "docs/notes.md", "y");
    submit(h.ctx, "thr_w1", "one");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("review");
    expect(lastCheck().data.outside).toEqual(["docs/notes.md"]);

    h.store.setTicketState(ticketOf(h, "CSV-1").id, "working", "loom");
    put(worktree, "db/schema.sql", "z");
    submit(h.ctx, "thr_w1", "two");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("working");
    expect(lastCheck().data).toMatchObject({ passed: false, protectedHits: ["db/schema.sql"] });
  });

  it("runs only the ticket's repo's checks and fails a path only that repo protects, on a multi-repo project", async () => {
    await worker(
      (doc) => {
        doc.checks = { commands: ["echo top-level ran; exit 9"] };
        doc.repo[0].checks = ["test -f src/model/a.ts && echo web checks ran"];
        doc.repo[2].checks = ["echo docs ran; exit 8"];
      },
      { repos: true },
    );
    put(worktree, "src/model/a.ts", "x");
    submit(h.ctx, "thr_w1", "one");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("review");
    expect(lastCheck().body).toContain("pass test -f src/model/a.ts && echo web checks ran");
    expect(lastCheck().body).not.toContain("ran; exit");

    h.store.setTicketState(ticketOf(h, "CSV-1").id, "working", "loom");
    put(worktree, "web.lock", "z");
    submit(h.ctx, "thr_w1", "two");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("working");
    expect(lastCheck().data).toMatchObject({ passed: false, protectedHits: ["web.lock"] });
  });

  it("fails the run when a check command writes a tracked file, and reports the failing command's output", async () => {
    await worker((doc) => (doc.checks = { commands: ["echo more >> README.md"] }));
    put(worktree, "src/model/a.ts", "x");
    submit(h.ctx, "thr_w1", "done");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1")).toMatchObject({ state: "working", check_failures: 1, head_sha: null });
    expect(lastCheck().body).toContain("The worktree changed while the checks ran");

    sh(worktree, "checkout", "--", "README.md");
    submit(h.ctx, "thr_w1", "again");
    await settleChecks(h.ctx);
    expect(ticketOf(h, "CSV-1").state).toBe("working");
  });

  it("shows a failing command's exit code and output", async () => {
    await worker((doc) => (doc.checks = { commands: ["echo lint says no; exit 7"] }));
    put(worktree, "src/model/a.ts", "x");
    submit(h.ctx, "thr_w1", "done");
    await settleChecks(h.ctx);
    expect(lastCheck().body).toContain("FAIL echo lint says no; exit 7 (exit 7");
    expect(lastCheck().body).toContain("lint says no");
    expect(h.bb.sent("thr_w1").at(-1)).toContain("exited with 7");
  });
});
