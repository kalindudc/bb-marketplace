import { beforeEach, describe, expect, it } from "vitest";
import { hostContract, type HostMethod } from "../src/host-contract";
import type { HostPort } from "../src/ports";
import { COPY_LABEL, recordingHost, RUN_OUTPUT_MAX, STEP_LABELS, stepSummary } from "../src/runs";
import { makeCtx, seedProject, ticketOf, type EngineHarness } from "./helpers";

let h: EngineHarness;
let host: HostPort;

beforeEach(async () => {
  h = makeCtx();
  await seedProject(h);
  host = recordingHost(h.store, h.host, ticketOf(h, "CSV-1"), "check");
});

const runs = () => h.store.runs(ticketOf(h, "CSV-1").id);
const lastOutput = () => h.store.runOutput(runs().at(-1)!.id);

describe("recordingHost", () => {
  it("returns a command's result unchanged and records it labelled with the command", async () => {
    h.host.execResults.push({ exitCode: 2, output: "boom" });
    const result = await host.call("host_1", "exec", { cwd: "/wt/env_1", command: "npm run lint", timeoutMs: 60_000 });
    expect(result).toEqual({ exitCode: 2, timedOut: false, durationMs: 12, output: "boom" });
    expect(runs()).toEqual([expect.objectContaining({ stage: "check", kind: "command", label: "npm run lint", ok: 0, exit_code: 2, timed_out: 0, duration_ms: 12, output_chars: 4 })]);
    expect(lastOutput()).toBe("boom");
  });

  it("records a git step with its summary", async () => {
    h.host.worktree("/wt/env_1").dirty = true;
    const result = await host.call("host_1", "commitAll", { worktree: "/wt/env_1", message: "Submit" });
    expect(result).toEqual({ sha: "c1", committed: true });
    expect(runs()).toEqual([expect.objectContaining({ kind: "git", label: "git commit", ok: 1, exit_code: null })]);
    expect(lastOutput()).toBe("Committed c1.");
  });

  it("records a merge conflict as a failed step that lists the files", async () => {
    h.host.scripted.merge = [{ outcome: "conflict", files: ["src/a.ts", "src/b.ts"] }];
    await host.call("host_1", "merge", { worktree: "/data/worktrees/csv", ref: "c1", message: "Merge CSV-1" });
    expect(runs()).toEqual([expect.objectContaining({ label: "git merge", ok: 0 })]);
    expect(lastOutput()).toBe("Conflicts in:\nsrc/a.ts\nsrc/b.ts");
  });

  it("rethrows a host error and records it as a failed step", async () => {
    h.host.errors.exec = new Error("the machine is offline");
    await expect(host.call("host_1", "exec", { cwd: "/wt/env_1", command: "npm test", timeoutMs: 60_000 })).rejects.toThrow("the machine is offline");
    expect(runs()).toEqual([expect.objectContaining({ label: "npm test", ok: 0, ended_at: h.clock.t })]);
    expect(lastOutput()).toBe("the machine is offline");
  });

  it("clips the output to RUN_OUTPUT_MAX", async () => {
    h.host.execResults.push({ output: "x".repeat(100_000) });
    await host.call("host_1", "exec", { cwd: "/wt/env_1", command: "npm test", timeoutMs: 60_000 });
    expect(runs()[0]).toMatchObject({ ok: 1, output_chars: RUN_OUTPUT_MAX });
  });

  it("records a copy of files between machines as one run with counts, and none of the bytes", async () => {
    const data = Buffer.alloc(3000, 7).toString("base64");
    await host.call("host_1", "carryStart", { worktree: "/wt/env_1", remote: "origin", baseBranch: "main", base: "base000", tree: "aaaa" });
    for (const path of ["src/a.ts", "src/b.ts"]) {
      h.host.scripted.readBlob = [{ data }];
      await host.call("host_1", "readBlob", { repo: "/repo", sha: "b10b", offset: 0, length: 3000 });
      await host.call("host_1", "carryWrite", { worktree: "/wt/env_1", path, mode: "100644", offset: 0, data });
    }
    await host.call("host_1", "carryFinish", { worktree: "/wt/env_1", base: "base000", message: "m", author: { name: "W", email: "w@example.com", date: "1800000000 +0000" }, tree: "aaaa", paths: ["src/a.ts", "src/b.ts"] });
    expect(runs().map((run) => run.label)).toEqual([STEP_LABELS.carryStart, COPY_LABEL, STEP_LABELS.carryFinish]);
    const copy = runs()[1]!;
    expect(copy).toMatchObject({ ok: 1, kind: "git" });
    expect(h.store.runOutput(copy.id)).toBe("Copied 2 files, 5.9 KiB, in 4 calls.");
    expect(runs().every((run) => run.output_chars < 200)).toBe(true);
  });

  it("records a copy that fails as a failed run with what it copied before", async () => {
    await host.call("host_1", "readBlob", { repo: "/repo", sha: "b10b", offset: 0, length: 10 });
    h.host.errors.carryWrite = new Error("disk full");
    await expect(host.call("host_1", "carryWrite", { worktree: "/wt/env_1", path: "a", mode: "100644", offset: 0, data: "" })).rejects.toThrow("disk full");
    expect(runs()).toEqual([expect.objectContaining({ label: COPY_LABEL, ok: 0 })]);
    expect(lastOutput()).toBe("disk full\nCopied 1 file, 0 B, in 2 calls.");
  });
});

describe("STEP_LABELS", () => {
  it("names every host method but exec, whose label is its command", () => {
    const methods = Object.keys(hostContract).filter((method) => method !== "exec") as HostMethod[];
    expect(methods.filter((method) => !(method in STEP_LABELS))).toEqual([]);
    expect("exec" in STEP_LABELS).toBe(false);
  });
});

describe("stepSummary", () => {
  it("says what a transfer moved in sizes, never its bytes", () => {
    const data = Buffer.alloc(2048, 1).toString("base64");
    expect(stepSummary("readBlob", { data })).toEqual({ ok: true, text: "Read 2.0 KiB." });
    expect(stepSummary("importChunk", { size: 5 * 1024 * 1024 })).toEqual({ ok: true, text: "The upload has 5.0 MiB." });
    expect(stepSummary("carryWrite", { size: 10 })).toEqual({ ok: true, text: "The file has 10 B." });
    const exported = { base: "base0000000000", head: "head0000000000", tree: "t", message: "m", author: { name: "W", email: "w@example.com", date: "1 +0000" } };
    const changes = [
      { status: "A" as const, path: "a", mode: "100644" as const, blob: "b1", size: 1024 },
      { status: "D" as const, path: "b" },
    ];
    expect(stepSummary("exportChanges", { ...exported, changes })).toEqual({ ok: true, text: "2 files changed from base00000000 to head00000000: 1 written (1.0 KiB) and 1 deleted." });
  });

  it("lists at most 20 files and counts the rest", () => {
    const changed = Array.from({ length: 25 }, (_, index) => `f${index}`);
    const text = stepSummary("worktreeState", { branch: "wt", head: "c1", tree: "t1", dirty: false, changed }).text;
    expect(text.split("\n")).toHaveLength(22);
    expect(text.endsWith("f19\nand 5 more.")).toBe(true);
  });

  it("describes each git step", () => {
    expect(stepSummary("commitAll", { sha: "0123456789abcdef", committed: false })).toEqual({ ok: true, text: "Nothing new to commit; HEAD is 0123456789ab." });
    expect(stepSummary("worktreeState", { branch: "wt", head: "c1", tree: "t1", dirty: false, changed: ["src/a.ts", "src/b.ts"] })).toEqual({
      ok: true,
      text: "HEAD c1 on wt, clean. 2 files differ from the base:\nsrc/a.ts\nsrc/b.ts",
    });
    expect(stepSummary("worktreeState", { branch: null, head: "c1", tree: "t1", dirty: true, changed: ["src/a.ts"] }).text).toBe("HEAD c1 on a detached HEAD, with uncommitted changes. 1 file differs from the base:\nsrc/a.ts");
    expect(stepSummary("worktreeState", { branch: "wt", head: "c1", tree: "t1", dirty: false, changed: [] }).text).toBe("HEAD c1 on wt, clean. No files differ from the base.");
    expect(stepSummary("resetHard", { sha: "base000" })).toEqual({ ok: true, text: "Reset to base000." });
    expect(stepSummary("ensureWorktree", { outcome: "ok", path: "/data/worktrees/csv" })).toEqual({ ok: true, text: "Ready at /data/worktrees/csv." });
    expect(stepSummary("ensureWorktree", { outcome: "unavailable", reason: "git", message: "not a repository" })).toEqual({ ok: false, text: "not a repository" });
    expect(stepSummary("merge", { outcome: "merged", sha: "m1", before: "base000", already: false })).toEqual({ ok: true, text: "Merged as m1; the branch was at base000." });
    expect(stepSummary("merge", { outcome: "merged", sha: "m1", before: "base000", already: true }).text).toBe("Merged as m1; the branch was at base000. (already merged)");
    expect(stepSummary("push", { outcome: "ok" })).toEqual({ ok: true, text: "Pushed." });
    expect(stepSummary("prCreate", { outcome: "ok", url: "https://github.com/o/r/pull/1" })).toEqual({ ok: true, text: "Opened https://github.com/o/r/pull/1." });
    expect(stepSummary("push", { outcome: "unavailable", message: "no remote" })).toEqual({ ok: false, text: "no remote" });
    const read = { outcome: "ok" as const, pulls: [{ number: 4, state: "MERGED" as const, draft: false, review: null, base: "main", feedback: null }], missing: [{ number: 5, message: "gh found no pull request #5 in o/r" }] };
    expect(stepSummary("prBatch", read)).toEqual({ ok: false, text: "#4 is merged on main.\ngh found no pull request #5 in o/r" });
    expect(stepSummary("ensureBranch", { sha: "base000", created: true })).toEqual({ ok: true, text: "Created the branch at base000." });
    expect(stepSummary("refTip", { outcome: "missing", message: "no such ref" })).toEqual({ ok: true, text: "no such ref" });
    expect(stepSummary("carryFinish", { outcome: "foreign", paths: ["a.ts", "b.ts"] })).toEqual({ ok: false, text: "The worktree has changes the copy did not make, so Loom committed nothing:\na.ts\nb.ts" });
    const carried = [
      { path: "a.ts", holds: "carry" as const },
      { path: "b.ts", holds: "before" as const },
      { path: "c.ts", holds: "absent" as const },
      { path: "d.ts", holds: "changed" as const },
    ];
    expect(stepSummary("carryAbort", { clean: false, kept: ["a.ts", "d.ts"], carried })).toEqual({
      ok: true,
      text: "Left the worktree as it is. What each file the copy wrote or deleted holds now:\na.ts: what the copy wrote\nb.ts: what it held before the copy\nc.ts: nothing\nd.ts: a change the copy did not make",
    });
    expect(stepSummary("carryAbort", { clean: true, kept: [], carried: [] })).toEqual({ ok: true, text: "Left the worktree as it is; the copy had written nothing." });
    expect(STEP_LABELS.carryAbort).toBe("stop the copy, leaving the worktree as it is");
    expect(stepSummary("prReady", { outcome: "ok" })).toEqual({ ok: true, text: "Marked the pull request ready for review." });
    expect(stepSummary("carryFinish", { outcome: "mismatch", tree: "t2" })).toEqual({ ok: false, text: "After the copy the worktree would have the tree t2, not the one sent, so Loom committed nothing." });
  });
});
