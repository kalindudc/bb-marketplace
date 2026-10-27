// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BLOB_MAX_BYTES, type HostInput, type HostMethod, type HostOutput } from "../src/host-contract";
import * as ops from "../src/host/ops";
import type { EnvironmentInfo, HostPort } from "../src/ports";
import { bringHome, carryTo, homeBranch, reviewedRef } from "../src/transport";
import { specOf, type EngineCtx } from "../src/workers";
import { makeCtx, seedProject, ticketOf, type EngineHarness } from "./helpers";

const ENV: Record<string, string> = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const saved: Record<string, string | undefined> = {};
let scratch: string;
let counter = 0;

const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const put = (root: string, path: string, content: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
};

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "loom-transport-")));
  for (const key of Object.keys(ENV)) saved[key] = process.env[key];
  Object.assign(process.env, ENV);
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** Loom's host entry on each machine, over real repositories, with a data directory of its own per host. */
class RepoHost implements HostPort {
  calls: Array<{ hostId: string; method: HostMethod; input: unknown }> = [];
  /** Throws once, at the call to `method` after `after` earlier calls to it. */
  breakOn: { method: HostMethod; after: number } | null = null;
  /** Changes what each call to `method` answers. */
  rewrite: { method: HostMethod; change: (output: unknown) => unknown } | null = null;
  async call<M extends HostMethod>(hostId: string, method: M, input: HostInput<M>): Promise<HostOutput<M>> {
    const before = this.calls.filter((call) => call.method === method).length;
    this.calls.push({ hostId, method, input });
    if (this.breakOn?.method === method && this.breakOn.after === before) {
      this.breakOn = null;
      throw new Error(`${method} timed out`);
    }
    const dataDir = join(scratch, `data-${hostId}`);
    const handlers = ops as unknown as Record<string, (input: unknown, extra?: unknown) => Promise<unknown>>;
    const extra = method === "importChunk" || method === "importCommit" || method === "dropUploads" ? dataDir : undefined;
    const output = await handlers[method]!(input, extra);
    return (this.rewrite?.method === method ? this.rewrite.change(output) : output) as HostOutput<M>;
  }
  methods(hostId: string): HostMethod[] {
    return this.calls.filter((call) => call.hostId === hostId).map((call) => call.method);
  }
}

function repos() {
  const seed = join(scratch, `seed-${counter++}`);
  mkdirSync(seed);
  sh(seed, "init", "-q", "-b", "main");
  sh(seed, "config", "user.email", "dev@example.com");
  sh(seed, "config", "user.name", "Dev");
  put(seed, "README.md", "hello\n");
  put(seed, "old.txt", "old\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "-q", "-m", "init");
  const remote = join(scratch, `origin-${counter++}.git`);
  execFileSync("git", ["clone", "-q", "--bare", seed, remote]);
  const clone = () => {
    const dir = join(scratch, `clone-${counter++}`);
    execFileSync("git", ["clone", "-q", remote, dir]);
    sh(dir, "config", "user.email", "worker@example.com");
    sh(dir, "config", "user.name", "Worker");
    return dir;
  };
  return { clone };
}

describe("transport", () => {
  let h: EngineHarness;
  let host: RepoHost;
  let ctx: EngineCtx;
  let laptop: string;
  let clone: () => string;

  beforeEach(async () => {
    h = makeCtx();
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr", stack: false }));
    ({ clone } = repos());
    laptop = clone();
    h.bb.checkout = laptop;
    host = new RepoHost();
    ctx = { ...h.ctx, host };
  });

  const project = () => h.store.projectBySlug("csv")!;
  const on = (hostId: string, path: string): EnvironmentInfo => ({ path, branchName: "loom/csv/csv-1-1", hostId });

  it("brings a worker's commit from its own machine home, on the home branch and, for a submit, the reviewed ref", async () => {
    const worker = clone();
    put(worker, "src/a.ts", "export const a = 1;\n");
    sh(worker, "rm", "-q", "old.txt");
    sh(worker, "add", "-A");
    sh(worker, "commit", "-q", "-m", "CSV-1: Order rows");

    const spec = specOf(h.store, project());
    const home = await bringHome(ctx, project(), spec, ticketOf(h, "CSV-1"), on("host_box", worker), "submit");
    expect(home).toEqual({ sha: expect.stringMatching(/^[0-9a-f]{40}$/u), tree: sh(worker, "rev-parse", "HEAD^{tree}"), copied: true });
    expect(sh(laptop, "rev-parse", `${home.sha}^{tree}`)).toBe(home.tree);
    expect(sh(laptop, "rev-parse", homeBranch("csv", "CSV-1"))).toBe(home.sha);
    expect(sh(laptop, "rev-parse", reviewedRef("csv", "CSV-1"))).toBe(home.sha);
    expect(host.methods("host_box")).toEqual(["exportChanges", "readBlob"]);
    expect(host.methods("host_1")).toEqual(["importChunk", "importCommit"]);

    put(worker, "src/b.ts", "export const b = 2;\n");
    sh(worker, "add", "-A");
    sh(worker, "commit", "-q", "-m", "WIP CSV-1 (attempt 1)");
    const wip = await bringHome(ctx, project(), spec, ticketOf(h, "CSV-1"), on("host_box", worker), "wip");
    expect(sh(laptop, "rev-parse", homeBranch("csv", "CSV-1"))).toBe(wip.sha);
    expect(sh(laptop, "rev-parse", reviewedRef("csv", "CSV-1"))).toBe(home.sha);
  });

  it("names each transfer's uploads apart, so two bring-homes of one ticket never share a file", async () => {
    const worker = clone();
    put(worker, "src/a.ts", "export const a = 1;\n");
    sh(worker, "add", "-A");
    sh(worker, "commit", "-q", "-m", "CSV-1: Order rows");
    const spec = specOf(h.store, project());

    await bringHome(ctx, project(), spec, ticketOf(h, "CSV-1"), on("host_box", worker), "wip");
    await bringHome(ctx, project(), spec, ticketOf(h, "CSV-1"), on("host_box", worker), "submit");
    const uploads = host.calls.filter((call) => call.method === "importChunk").map((call) => (call.input as HostInput<"importChunk">).upload);
    expect(uploads).toHaveLength(2);
    expect(uploads[0]).not.toBe(uploads[1]);
    for (const upload of uploads) expect(upload).toMatch(/^csv-1-[0-9a-f]{8}-[0-9a-f]{40}$/u);
  });

  it("refuses a file over the limit before it uploads anything", async () => {
    const worker = clone();
    put(worker, "src/a.ts", "export const a = 1;\n");
    put(worker, "big.bin", "big\n");
    sh(worker, "add", "-A");
    sh(worker, "commit", "-q", "-m", "CSV-1: Order rows");
    host.rewrite = {
      method: "exportChanges",
      change: (output) => {
        const exported = output as HostOutput<"exportChanges">;
        return { ...exported, changes: exported.changes.map((change) => (change.path === "big.bin" ? { ...change, size: BLOB_MAX_BYTES + 1 } : change)) };
      },
    };

    await expect(bringHome(ctx, project(), specOf(h.store, project()), ticketOf(h, "CSV-1"), on("host_box", worker), "submit")).rejects.toThrow("big.bin is 101 MiB, and files over 100 MiB can't move between machines");
    expect(host.methods("host_box")).toEqual(["exportChanges"]);
    expect(host.methods("host_1")).toEqual([]);
  });

  it("removes the uploads of a bring-home that fails before its commit", async () => {
    const worker = clone();
    put(worker, "src/a.ts", "export const a = 1;\n");
    put(worker, "src/b.ts", "export const b = 2;\n");
    sh(worker, "add", "-A");
    sh(worker, "commit", "-q", "-m", "CSV-1: Order rows");
    host.breakOn = { method: "readBlob", after: 1 };

    await expect(bringHome(ctx, project(), specOf(h.store, project()), ticketOf(h, "CSV-1"), on("host_box", worker), "submit")).rejects.toThrow("readBlob timed out");
    expect(host.methods("host_1")).toEqual(["importChunk", "dropUploads"]);
    expect(readdirSync(join(scratch, "data-host_1", "imports"))).toEqual([]);
  });

  it("carries a commit from the project's checkout into a worktree on another machine", async () => {
    sh(laptop, "switch", "-q", "-c", "loom/csv/csv-1-home");
    put(laptop, "src/a.ts", "export const a = 1;\n");
    sh(laptop, "add", "-A");
    sh(laptop, "commit", "-q", "-m", "CSV-1: Order rows");
    const sha = sh(laptop, "rev-parse", "HEAD");
    sh(laptop, "switch", "-q", "main");
    const reviewer = clone();

    const carried = await carryTo(ctx, project(), specOf(h.store, project()), ticketOf(h, "CSV-1"), sha, on("host_box", reviewer));
    expect(carried).toEqual({ tree: sh(laptop, "rev-parse", `${sha}^{tree}`) });
    expect(sh(reviewer, "rev-parse", "HEAD^{tree}")).toBe(carried.tree);
    expect(host.methods("host_1")).toEqual(["exportChanges", "readBlob"]);
    expect(host.methods("host_box")).toEqual(["carryStart", "carryWrite", "carryFinish"]);

    host.calls = [];
    const head = sh(reviewer, "rev-parse", "HEAD");
    expect(await carryTo(ctx, project(), specOf(h.store, project()), ticketOf(h, "CSV-1"), sha, on("host_box", reviewer))).toEqual(carried);
    expect(host.methods("host_box")).toEqual(["carryStart"]);
    expect(sh(reviewer, "rev-parse", "HEAD")).toBe(head);
  });

  it("puts a worktree back at the base when a carry fails part-way, so the next one succeeds", async () => {
    sh(laptop, "switch", "-q", "-c", "loom/csv/csv-1-home");
    sh(laptop, "rm", "-q", "old.txt");
    put(laptop, "src/a.ts", "export const a = 1;\n");
    put(laptop, "src/b.ts", "export const b = 2;\n");
    sh(laptop, "add", "-A");
    sh(laptop, "commit", "-q", "-m", "CSV-1: Order rows");
    const sha = sh(laptop, "rev-parse", "HEAD");
    sh(laptop, "switch", "-q", "main");
    const reviewer = clone();
    const base = sh(reviewer, "rev-parse", "HEAD");

    host.breakOn = { method: "readBlob", after: 1 };
    await expect(carryTo(ctx, project(), specOf(h.store, project()), ticketOf(h, "CSV-1"), sha, on("host_box", reviewer))).rejects.toThrow("readBlob timed out");
    expect(host.methods("host_box")).toEqual(["carryStart", "carryDelete", "carryWrite", "carryAbort"]);
    expect(sh(reviewer, "rev-parse", "HEAD")).toBe(base);
    expect(sh(reviewer, "status", "--porcelain")).toBe("");

    const carried = await carryTo(ctx, project(), specOf(h.store, project()), ticketOf(h, "CSV-1"), sha, on("host_box", reviewer));
    expect(carried).toEqual({ tree: sh(laptop, "rev-parse", `${sha}^{tree}`) });
    expect(sh(reviewer, "rev-parse", "HEAD^{tree}")).toBe(carried.tree);
  });

  it("copies nothing for an environment on the checkout's own machine", async () => {
    sh(laptop, "worktree", "add", "-q", "-b", "loom/csv/csv-1-1", join(scratch, `wt-${counter}`), "main");
    const worktree = join(scratch, `wt-${counter++}`);
    put(worktree, "src/a.ts", "a\n");
    sh(worktree, "add", "-A");
    sh(worktree, "commit", "-q", "-m", "a");
    const spec = specOf(h.store, project());

    const home = await bringHome(ctx, project(), spec, ticketOf(h, "CSV-1"), on("host_1", worktree), "submit");
    expect(home).toEqual({ sha: sh(worktree, "rev-parse", "HEAD"), tree: sh(worktree, "rev-parse", "HEAD^{tree}"), copied: false });
    sh(laptop, "worktree", "add", "-q", "--detach", join(scratch, `wt-${counter}`), "main");
    const reviewer = join(scratch, `wt-${counter++}`);
    expect(await carryTo(ctx, project(), spec, ticketOf(h, "CSV-1"), home.sha, on("host_1", reviewer))).toEqual({ tree: home.tree });
    expect(sh(reviewer, "rev-parse", "HEAD")).toBe(home.sha);
    expect(host.calls.map((call) => call.method)).toEqual(["worktreeState", "detach"]);
    expect(sh(laptop, "branch", "--list", "loom/csv/csv-1-home")).toBe("");
  });
});
