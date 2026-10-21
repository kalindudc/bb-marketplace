// The calls the server makes on the machine that owns a project's checkout and worktrees.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const absPath = z.string().min(1).max(4096).regex(/^\//, "must be an absolute path");

// A branch or a remote-prefixed base. Git itself rejects the rest; this keeps option-like and multi-word values out of argv.
const ref = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.includes("..") && !value.startsWith("-") && !/[\u0000-\u0020\u007f~^:?*[\\]/.test(value), "is not a safe git ref");

const sha = z.string().min(1).max(64);
const commit = z.string().regex(/^[0-9a-fA-F]{4,64}$/, "must be a commit hash");
const slug = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, "must be a project slug");

export const hostContract = defineRpcContract({
  ensureBranch: {
    input: z.object({ repo: absPath, branch: ref, from: ref }).strict(),
    output: z.object({ sha, created: z.boolean() }).strict(),
  },
  worktreeState: {
    // trackedOnly leaves untracked files out of `dirty`: a build or a test run may leave some behind, and they cannot reach a commit.
    input: z.object({ worktree: absPath, base: ref, trackedOnly: z.boolean().optional() }).strict(),
    output: z.object({ branch: z.string().nullable(), head: sha, dirty: z.boolean(), changed: z.array(z.string()) }).strict(),
  },
  commitAll: {
    input: z.object({ worktree: absPath, message: z.string().min(1).max(500) }).strict(),
    output: z.object({ sha, committed: z.boolean() }).strict(),
  },
  exec: {
    input: z.object({ cwd: absPath, command: z.string().min(1).max(4096), timeoutMs: z.number().int().min(1000).max(1_770_000) }).strict(),
    output: z.object({ exitCode: z.number().int().nullable(), timedOut: z.boolean(), durationMs: z.number(), output: z.string() }).strict(),
  },
  diff: {
    input: z.object({ repo: absPath, base: ref, head: commit, maxBytes: z.number().int().min(1000).max(200_000) }).strict(),
    output: z.object({ stat: z.string(), patch: z.string(), truncated: z.boolean() }).strict(),
  },
  ensureWorktree: {
    input: z.object({ repo: absPath, key: slug, branch: ref }).strict(),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("ok"), path: z.string() }).strict(),
      z.object({ outcome: z.literal("unavailable"), reason: z.enum(["branch_checked_out", "git"]), message: z.string() }).strict(),
    ]),
  },
  merge: {
    // before is the rollback point the caller persisted ahead of the first attempt. A rerun that finds the merge made reports it back.
    input: z.object({ worktree: absPath, ref: commit, message: z.string().min(1).max(500), before: commit.optional() }).strict(),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("merged"), sha, before: sha, already: z.boolean() }).strict(),
      z.object({ outcome: z.literal("conflict"), files: z.array(z.string()) }).strict(),
    ]),
  },
  resetHard: {
    input: z.object({ worktree: absPath, sha: commit }).strict(),
    output: z.object({ sha }).strict(),
  },
  push: {
    input: z.object({ repo: absPath, remote: ref, src: ref, branch: ref }).strict(),
    output: z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("ok") }).strict(), z.object({ outcome: z.literal("unavailable"), message: z.string() }).strict()]),
  },
  prCreate: {
    input: z.object({ repo: absPath, remote: ref, base: ref, head: ref, title: z.string().min(1).max(256), body: z.string().max(60_000), draft: z.boolean() }).strict(),
    output: z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("ok"), url: z.string() }).strict(), z.object({ outcome: z.literal("unavailable"), message: z.string() }).strict()]),
  },
  // gh pr view <url> --json state
  prState: {
    input: z.object({ repo: absPath, url: z.string().regex(/^https?:\/\/\S+$/, "must be a pull request URL").max(500) }).strict(),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("ok"), state: z.enum(["OPEN", "MERGED", "CLOSED"]) }).strict(),
      z.object({ outcome: z.literal("unavailable"), message: z.string() }).strict(),
    ]),
  },
});

export type HostMethod = keyof typeof hostContract & string;
export type HostInput<M extends HostMethod> = z.input<(typeof hostContract)[M]["input"]>;
export type HostOutput<M extends HostMethod> = z.output<(typeof hostContract)[M]["output"]>;
