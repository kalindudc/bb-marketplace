// The gate tests' harness: a shadow repository on a command server with file reads, and a verifier the test controls.
import type { RunOptions, Runner } from "../src/adapters/exec";
import type { Gate } from "../src/contract";
import { BLOCKING_INSTRUCTIONS, gatesSettled } from "../src/gate";
import { harness, pr, testConfig, TEST_SERVER } from "./helpers";

export const SERVER = { ...TEST_SERVER, enabled: true, sep: "#" as const, commands: { ...TEST_SERVER.commands, review: "rv", comment: "c", files: "fl", file: "fi" } };
export const NO_AUTO = { enabled: false, when: ["requested" as const], drafts: false, preset: "", repos: [], maxPerDay: 8, rerun: "never" as const };
export const KEY = (n: number) => `forge:acme/app#${n}`;
export const VERIFY = "verify-cmd";
export const FILE = ["package main", "", "func run() {", "\tgo work()", "\tshared++", "}", ""].join("\n");
export const PATCH = "@@ -1,3 +1,6 @@\n package main\n+func run() {\n+\tgo work()\n+\tshared++\n+}";
export const LOW = { risk: "low" as const, concerns: [] };

export type Verdict = { code?: number; stdout?: string; timedOut?: boolean };

/** A shadow repo on a command server with file reads, and a verifier whose answers and prompts the test controls. */
export const BLOCKING_OK = '{"blocking": 0.05, "reason": "Nothing blocks it."}';

export async function shadow(options: {
  autoPost?: Record<string, unknown>; verdict?: (prompt: string) => Verdict; blocking?: (prompt: string) => Verdict; view?: Record<string, unknown>;
  contents?: Record<string, string | null>; onVerify?: () => Promise<void>;
} = {}) {
  const autoPost = { repos: [{ repo: "acme/*", mode: "shadow" }], verifier: VERIFY, ...options.autoPost };
  const h = harness(testConfig({ servers: [SERVER as never], autoReview: NO_AUTO, autoPost: autoPost as never }));
  h.answers.review = "";
  h.answers.files = [{ path: "main.go", patch: PATCH }, { path: "docs/readme.md", patch: "@@ -1 +1 @@\n-# App\n+# The app" }];
  h.answers.file = { content: FILE };
  const view = { head: "h1", additions: 12, deletions: 3, ...options.view };
  h.lists.review_requested = [pr(3, view)];
  await h.shuttle.sync();
  h.views[3] = pr(3, view);
  const prompts: string[] = [];
  const blockingPrompts: string[] = [];
  const real = h.shuttle.run;
  const run: Runner = async (bin: string, args: readonly string[], opts: RunOptions) => {
    if (bin === "/bin/sh" && args[1] === VERIFY && (opts.stdin ?? "").startsWith(BLOCKING_INSTRUCTIONS)) {
      blockingPrompts.push(opts.stdin ?? "");
      const answer = options.blocking?.(opts.stdin ?? "") ?? { stdout: BLOCKING_OK };
      return { code: answer.code ?? 0, stdout: answer.stdout ?? "", stderr: answer.code ? "model refused" : "", timedOut: answer.timedOut ?? false };
    }
    if (bin === "/bin/sh" && args[1] === VERIFY) {
      prompts.push(opts.stdin ?? "");
      await options.onVerify?.();
      const answer = options.verdict?.(opts.stdin ?? "") ?? { stdout: '{"holds": 0.9, "worth_posting": 0.85, "reason": "The counter races."}' };
      return { code: answer.code ?? 0, stdout: answer.stdout ?? "", stderr: answer.code ? "model refused" : "", timedOut: answer.timedOut ?? false };
    }
    return real(bin, args, opts);
  };
  (h.shuttle as unknown as { run: Runner }).run = run;
  const contents = options.contents;
  if (contents) h.shuttle.adapter("forge").fileAt = async (_repo, _ref, path) => (path in contents ? contents[path]! : FILE);
  return { h, prompts, blockingPrompts };
}

export const good = (patch: Record<string, unknown> = {}) => ({
  severity: "medium" as const, path: "main.go", line: 5, body: "`shared++` races with the goroutine started on line 4.",
  consensus: { keep: 3, total: 3 }, evidence: [{ path: "main.go", from: 4, to: 5, quote: "go work()\n\tshared++" }], ...patch,
});

export async function draft(h: Awaited<ReturnType<typeof shadow>>["h"], input: { findings: Array<Record<string, unknown>>; verdict?: "comment" | "approve" | "changes"; assessment?: unknown }) {
  const { threadId } = await h.shuttle.review({ key: KEY(3) });
  await h.shuttle.saveDraft(threadId, KEY(3), { summary: "One race", verdict: input.verdict ?? "comment", findings: input.findings as never, ...(input.assessment === null ? {} : { assessment: (input.assessment ?? LOW) as never }) });
  // Saving starts the gate in the background.
  await gatesSettled(h.shuttle);
  return h.shuttle.detail(KEY(3)).draft!;
}

export const gateOf = (d: { gate: Gate | null }) => d.gate!;
export const failed = (gate: Gate, id = "f1") => gate.findings.find((f) => f.id === id)!.checks.filter((c) => !c.ok).map((c) => c.reason);
