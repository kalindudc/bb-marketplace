import { beforeEach, describe, expect, it } from "vitest";
import type { HostPort } from "../src/ports";
import { recordingHost, RUN_OUTPUT_MAX, stepSummary } from "../src/runs";
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
});

describe("stepSummary", () => {
  it("describes each git step", () => {
    expect(stepSummary("commitAll", { sha: "0123456789abcdef", committed: false })).toEqual({ ok: true, text: "Nothing new to commit; HEAD is 0123456789ab." });
    expect(stepSummary("worktreeState", { branch: "wt", head: "c1", dirty: false, changed: ["src/a.ts", "src/b.ts"] })).toEqual({
      ok: true,
      text: "HEAD c1 on wt, clean. 2 files differ from the base:\nsrc/a.ts\nsrc/b.ts",
    });
    expect(stepSummary("worktreeState", { branch: null, head: "c1", dirty: true, changed: ["src/a.ts"] }).text).toBe("HEAD c1 on a detached HEAD, with uncommitted changes. 1 file differs from the base:\nsrc/a.ts");
    expect(stepSummary("worktreeState", { branch: "wt", head: "c1", dirty: false, changed: [] }).text).toBe("HEAD c1 on wt, clean. No files differ from the base.");
    expect(stepSummary("resetHard", { sha: "base000" })).toEqual({ ok: true, text: "Reset to base000." });
    expect(stepSummary("ensureWorktree", { outcome: "ok", path: "/data/worktrees/csv" })).toEqual({ ok: true, text: "Ready at /data/worktrees/csv." });
    expect(stepSummary("ensureWorktree", { outcome: "unavailable", reason: "git", message: "not a repository" })).toEqual({ ok: false, text: "not a repository" });
    expect(stepSummary("merge", { outcome: "merged", sha: "m1", before: "base000", already: false })).toEqual({ ok: true, text: "Merged as m1; the branch was at base000." });
    expect(stepSummary("merge", { outcome: "merged", sha: "m1", before: "base000", already: true }).text).toBe("Merged as m1; the branch was at base000. (already merged)");
    expect(stepSummary("push", { outcome: "ok" })).toEqual({ ok: true, text: "Pushed." });
    expect(stepSummary("prCreate", { outcome: "ok", url: "https://github.com/o/r/pull/1" })).toEqual({ ok: true, text: "Opened https://github.com/o/r/pull/1." });
    expect(stepSummary("push", { outcome: "unavailable", message: "no remote" })).toEqual({ ok: false, text: "no remote" });
    const read = { outcome: "ok", pulls: [{ number: 4, state: "MERGED", draft: false, review: null, base: "main", feedback: null }], missing: [{ number: 5, message: "gh found no pull request #5 in o/r" }] };
    expect(stepSummary("prBatch", read)).toEqual({ ok: false, text: "#4 is merged on main.\ngh found no pull request #5 in o/r" });
    expect(stepSummary("ensureBranch", { sha: "base000", created: true })).toEqual({ ok: true, text: '{"sha":"base000","created":true}' });
  });
});
