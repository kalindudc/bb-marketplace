import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const git = vi.hoisted(() => ({ inside: 0, most: 0, gate: null as Promise<void> | null, started: [] as string[] }));

// Every git process takes a moment, so two calls that overlapped would show as two git processes at once.
vi.mock("../src/host/process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/host/process")>();
  const runProcess = (async (...args: Parameters<typeof actual.runProcess>) => {
    git.inside += 1;
    git.most = Math.max(git.most, git.inside);
    git.started.push(args[1].join(" "));
    try {
      if (git.gate !== null) await git.gate;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return await actual.runProcess(...args);
    } finally {
      git.inside -= 1;
    }
  }) as typeof actual.runProcess;
  return { ...actual, runProcess };
});

const { CheckoutBusy, onCheckout } = await import("../src/host/queue");
const { hostCallTransient } = await import("../src/forge-waits");

const scratch = mkdtempSync(join(tmpdir(), "loom-queue-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Work that records when it starts and ends, and how many are inside at once. */
function probe() {
  const log: string[] = [];
  let inside = 0;
  let most = 0;
  const work = (name: string, ms: number, fail = false) => async () => {
    inside += 1;
    most = Math.max(most, inside);
    log.push(`start ${name}`);
    await sleep(ms);
    log.push(`end ${name}`);
    inside -= 1;
    if (fail) throw new Error(`${name} failed`);
    return name;
  };
  return { log, work, most: () => most };
}

describe("onCheckout", () => {
  it("runs parallel calls on one checkout one after another, in the order they came", async () => {
    const p = probe();
    const results = await Promise.all([onCheckout(scratch, undefined, p.work("a", 40)), onCheckout(scratch, undefined, p.work("b", 10)), onCheckout(scratch, undefined, p.work("c", 0))]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(p.log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(p.most()).toBe(1);
  });

  it("runs calls on different checkouts side by side", async () => {
    const other = mkdtempSync(join(tmpdir(), "loom-queue-other-"));
    try {
      const p = probe();
      await Promise.all([onCheckout(scratch, undefined, p.work("a", 40)), onCheckout(other, undefined, p.work("b", 40))]);
      expect(p.most()).toBe(2);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("treats two spellings of one path as one checkout", async () => {
    const p = probe();
    await Promise.all([onCheckout(scratch, undefined, p.work("a", 30)), onCheckout(`${scratch}/../${scratch.split("/").at(-1)}`, undefined, p.work("b", 0))]);
    expect(p.log).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("moves on to the next call when one fails", async () => {
    const p = probe();
    const first = onCheckout(scratch, undefined, p.work("a", 10, true));
    const second = onCheckout(scratch, undefined, p.work("b", 0));
    await expect(first).rejects.toThrow("a failed");
    await expect(second).resolves.toBe("b");
  });

  it("ends the wait of a call that is aborted in the queue, and never runs its work", async () => {
    const p = probe();
    const controller = new AbortController();
    const first = onCheckout(scratch, undefined, p.work("a", 60));
    const waiting = onCheckout(scratch, controller.signal, p.work("b", 0));
    const third = onCheckout(scratch, undefined, p.work("c", 0));
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await Promise.all([first, third]);
    expect(p.log).toEqual(["start a", "end a", "start c", "end c"]);
  });

  it("rejects at once for a signal that is already aborted, without waiting for the running call", async () => {
    const p = probe();
    const running = onCheckout(scratch, undefined, p.work("a", 80));
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await expect(onCheckout(scratch, controller.signal, p.work("b", 0))).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(40);
    await running;
    expect(p.log).toEqual(["start a", "end a"]);
  });

  describe("admission by the call's deadline", () => {
    const deferred = () => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => (release = resolve));
      return { promise, release };
    };

    it("starts a queued call whose work still fits in what is left of its deadline, and refuses one whose work no longer does", async () => {
      let clock = 0;
      const now = () => clock;
      const admission = { budgetMs: 570_000, needMs: 540_000, now };
      const first = deferred();
      const ran: string[] = [];
      const running = onCheckout(scratch, undefined, async () => {
        ran.push("first");
        await first.promise;
      });
      const soon = onCheckout(
        scratch,
        undefined,
        async () => {
          ran.push("soon");
          clock = 200_000;
        },
        admission,
      );
      const late = onCheckout(scratch, undefined, async () => ran.push("late"), admission);
      clock = 20_000;
      first.release();
      await running;
      await soon;
      const refused = await late.then(
        () => null,
        (error: unknown) => error as Error,
      );
      expect(refused).toBeInstanceOf(CheckoutBusy);
      expect(ran).toEqual(["first", "soon"]);
    });

    it("is waited out by Loom's retry rules, and the next call after the refused one still runs", async () => {
      let clock = 0;
      const admission = { budgetMs: 100_000, needMs: 90_000, now: () => clock };
      const first = deferred();
      const running = onCheckout(scratch, undefined, () => first.promise);
      const refused = onCheckout(scratch, undefined, async () => "never", admission);
      const after = onCheckout(scratch, undefined, async () => "after");
      clock = 50_000;
      first.release();
      await running;
      const error = await refused.then(
        () => null,
        (thrown: unknown) => thrown as Error,
      );
      expect(error?.message).toMatch(/^the project's checkout is busy with another call, so this one did not start after waiting 50 seconds/u);
      expect(hostCallTransient(error)).toEqual({ transient: "server" });
      await expect(after).resolves.toBe("after");
    });

    it("never refuses a call that did not have to wait", async () => {
      const admission = { budgetMs: 100_000, needMs: 100_000, now: () => 0 };
      await expect(onCheckout(scratch, undefined, async () => "ran", admission)).resolves.toBe("ran");
    });
  });

  it("runs the importCommit, stackBase and mergeOnto calls of one repo one at a time", async () => {
    const { importCommit, mergeOnto, stackBase } = await import("../src/host/ops");
    const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
    const repo = join(scratch, "repo");
    const origin = join(scratch, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    mkdirSync(repo);
    sh(repo, "init", "-q", "-b", "main");
    sh(repo, "config", "user.email", "dev@example.com");
    sh(repo, "config", "user.name", "Dev");
    writeFileSync(join(repo, "README.md"), "hello\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "init");
    sh(repo, "remote", "add", "origin", origin);
    sh(repo, "push", "-q", "origin", "main");
    const base = sh(repo, "rev-parse", "HEAD");
    const tree = sh(repo, "rev-parse", "HEAD^{tree}");
    const branch = (name: string) => {
      sh(repo, "checkout", "-q", "-b", name, base);
      writeFileSync(join(repo, `${name}.txt`), `${name}\n`);
      sh(repo, "add", "-A");
      sh(repo, "commit", "-q", "-m", name);
      const sha = sh(repo, "rev-parse", "HEAD");
      sh(repo, "checkout", "-q", "main");
      return sha;
    };
    const [a, b, c] = [branch("a"), branch("b"), branch("c")];

    git.most = 0;
    const done = await Promise.all([
      importCommit({ repo, remote: "origin", baseBranch: "main", base, tree, message: "m\n", author: { name: "a", email: "a@b.c", date: "1700000000 +0000" }, entries: [], refs: [] }, join(scratch, "data")),
      stackBase({ repo, branch: "loom/stack", commits: [a, b], message: "stack" }),
      mergeOnto({ repo, head: b, ref: c, message: "merge", refs: [] }),
    ]);
    expect(done.map((result) => result.outcome)).toEqual(["ok", "ok", "merged"]);
    expect(git.most).toBe(1);
  });
  it("refuses a stackBase that waited behind an importCommit past its deadline, without starting any git for it", async () => {
    const { importCommit, stackBase } = await import("../src/host/ops");
    const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
    const repo = join(scratch, "repo-busy");
    const origin = join(scratch, "origin-busy.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    mkdirSync(repo);
    sh(repo, "init", "-q", "-b", "main");
    sh(repo, "config", "user.email", "dev@example.com");
    sh(repo, "config", "user.name", "Dev");
    writeFileSync(join(repo, "README.md"), "hello\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "init");
    sh(repo, "remote", "add", "origin", origin);
    sh(repo, "push", "-q", "origin", "main");
    const base = sh(repo, "rev-parse", "HEAD");
    const tree = sh(repo, "rev-parse", "HEAD^{tree}");

    let offset = 0;
    const realNow = Date.now.bind(Date);
    const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    let release!: () => void;
    git.gate = new Promise<void>((resolve) => (release = resolve));
    git.started = [];
    try {
      const importing = importCommit({ repo, remote: "origin", baseBranch: "main", base, tree, message: "m\n", author: { name: "a", email: "a@b.c", date: "1700000000 +0000" }, entries: [], refs: [] }, join(scratch, "data-busy"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const stacking = stackBase({ repo, branch: "loom/stack", commits: [base], message: "stack" }).catch((error: unknown) => error as Error);
      offset = 4 * 60_000;
      release();
      git.gate = null;
      expect(await importing).toMatchObject({ outcome: "ok" });
      const refused = await stacking;
      expect(refused).toBeInstanceOf(CheckoutBusy);
      expect(hostCallTransient(refused)).not.toBeNull();
      // stackBase lists worktrees and moves its branch as its last steps; neither ran.
      expect(git.started.some((argv) => argv.includes("worktree") || argv.includes("update-ref") && argv.includes("loom/stack"))).toBe(false);
    } finally {
      spy.mockRestore();
      git.gate = null;
    }
  });
});
