import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const text = z.string().max(4096);
const relativePath = z.string().min(1).max(4096);
const absolutePath = z.string().min(1).max(4096).regex(/^(\/|[A-Za-z]:[\\/]|\\\\)/);
const count = z.number().int().nonnegative();

export const scopeSchema = z.enum(["uncommitted", "branch"]);
export type Scope = z.infer<typeof scopeSchema>;

export const shaSchema = z.string().regex(/^[0-9a-f]{7,64}$/);

export const commitSchema = z.object({
  sha: text,
  shortSha: text,
  subject: text,
  authorName: text,
  authoredAt: z.number().nonnegative(),
}).strict();
export type Commit = z.infer<typeof commitSchema>;

const GIT_STATUSES = ["added", "modified", "deleted", "renamed", "copied", "type-changed", "unmerged", "untracked"] as const;

const gitFileShape = {
  path: relativePath,
  previousPath: relativePath.nullable(),
  status: z.enum(GIT_STATUSES),
  additions: count.nullable(),
  deletions: count.nullable(),
  binary: z.boolean(),
};

export const gitFileSchema = z.object(gitFileShape).strict();
export type GitFile = z.infer<typeof gitFileSchema>;

export const hostTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("uncommitted") }).strict(),
  z.object({ type: z.literal("merge-base"), base: text.nullable() }).strict(),
  z.object({ type: z.literal("range"), base: text.nullable(), head: text }).strict(),
  z.object({ type: z.literal("commit"), sha: shaSchema }).strict(),
]);
export type HostTarget = z.infer<typeof hostTargetSchema>;

export const hostUnavailableSchema = z.object({
  outcome: z.literal("unavailable"),
  reason: z.enum(["not-a-repo", "missing-ref", "invalid-input", "git-failed"]),
  message: text,
}).strict();
export type HostUnavailable = z.infer<typeof hostUnavailableSchema>;

export const hostContract = defineRpcContract({
  resolveRoots: {
    input: z.object({ paths: z.array(absolutePath).max(2000) }).strict(),
    output: z.object({
      results: z.array(z.object({
        path: absolutePath,
        root: absolutePath.nullable(),
        relative: z.string().max(4096).nullable(),
      }).strict()),
    }).strict(),
  },
  repoFiles: {
    input: z.object({ root: absolutePath, target: hostTargetSchema }).strict(),
    output: z.discriminatedUnion("outcome", [
      z.object({
        outcome: z.literal("available"),
        branch: text.nullable(),
        base: text.nullable(),
        aheadCount: count.nullable(),
        behindCount: count.nullable(),
        commits: z.array(commitSchema).max(100),
        files: z.array(gitFileSchema),
        truncated: z.boolean(),
      }).strict(),
      hostUnavailableSchema,
    ]),
  },
  repoPatch: {
    input: z.object({
      root: absolutePath,
      path: relativePath,
      previousPath: relativePath.nullable(),
      untracked: z.boolean(),
      target: hostTargetSchema,
    }).strict(),
    output: z.discriminatedUnion("outcome", [
      z.object({
        outcome: z.literal("available"),
        patch: z.string(),
        truncated: z.boolean(),
        binary: z.boolean(),
      }).strict(),
      hostUnavailableSchema,
    ]),
  },
});

export type HostMethod = keyof typeof hostContract & string;
export type HostInput<M extends HostMethod> = z.input<(typeof hostContract)[M]["input"]>;
export type HostOutput<M extends HostMethod> = z.output<(typeof hostContract)[M]["output"]>;

const workspaceRefSchema = z.object({ kind: z.literal("workspace"), environmentId: text, base: text.nullable() }).strict();
const branchRefSchema = z.object({ kind: z.literal("branch"), hostId: text, root: absolutePath, base: text.nullable(), head: text }).strict();

export const repoRefSchema = z.discriminatedUnion("kind", [
  workspaceRefSchema,
  z.object({ kind: z.literal("checkout"), hostId: text, root: absolutePath, base: text.nullable() }).strict(),
  branchRefSchema,
  z.object({ kind: z.literal("recorded") }).strict(),
]);
export type RepoRef = z.infer<typeof repoRefSchema>;

const editsSchema = z.object({
  threadIds: z.array(text),
  rawPaths: z.array(text),
  count,
}).strict();

export const fileChangeSchema = z.object({
  ...gitFileShape,
  status: z.enum([...GIT_STATUSES, "clean"]),
  untracked: z.boolean(),
  tooLarge: z.boolean(),
  edits: editsSchema.nullable(),
}).strict();
export type FileChange = z.infer<typeof fileChangeSchema>;

export const repoSchema = z.object({
  key: text,
  ref: repoRefSchema,
  label: text,
  root: text.nullable(),
  hostId: text.nullable(),
  hostName: text.nullable(),
  branch: text.nullable(),
  base: text.nullable(),
  aheadCount: count.nullable(),
  threadIds: z.array(text),
  state: z.enum(["ready", "unavailable"]),
  message: text.nullable(),
  files: z.array(fileChangeSchema),
  otherFiles: z.array(fileChangeSchema),
  truncated: z.boolean(),
  totals: z.object({ files: count, additions: count, deletions: count }).strict(),
}).strict();
export type Repo = z.infer<typeof repoSchema>;

export const worktreeSchema = z.object({
  key: text,
  ref: z.discriminatedUnion("kind", [workspaceRefSchema, branchRefSchema]),
  label: text,
  projectId: text,
  hostId: text,
  hostName: text,
  root: text,
  branch: text.nullable(),
  base: text.nullable(),
  kind: z.enum(["workspace", "branch"]),
  threadIds: z.array(text),
  state: z.enum(["ready", "unavailable"]),
  message: text.nullable(),
  aheadCount: count.nullable(),
  behindCount: count.nullable(),
  uncommitted: z.array(fileChangeSchema),
  committed: z.array(fileChangeSchema),
  commits: z.array(commitSchema),
}).strict();
export type Worktree = z.infer<typeof worktreeSchema>;

export const sharedFileSchema = z.object({
  projectId: text,
  path: relativePath,
  worktreeKeys: z.array(text).min(2),
}).strict();
export type SharedFile = z.infer<typeof sharedFileSchema>;

export const threadSummarySchema = z.object({
  id: text,
  title: text,
  parentThreadId: text.nullable(),
  archived: z.boolean(),
  depth: count,
  environmentId: text.nullable(),
  status: text,
}).strict();
export type ThreadSummary = z.infer<typeof threadSummarySchema>;

export const overviewSchema = z.object({
  threadId: text,
  scope: scopeSchema,
  threads: z.array(threadSummarySchema),
  repos: z.array(repoSchema),
  worktrees: z.array(worktreeSchema),
  sharedFiles: z.array(sharedFileSchema).max(200),
  otherFiles: z.array(fileChangeSchema),
  environmentIds: z.array(text),
  warnings: z.array(z.string()),
  truncatedThreads: z.boolean(),
  generatedAt: count,
}).strict();
export type Overview = z.infer<typeof overviewSchema>;

export const overviewInputSchema = z.object({
  threadId: text.min(1),
  scope: scopeSchema,
  refresh: z.boolean().optional(),
}).strict();
export type OverviewInput = z.infer<typeof overviewInputSchema>;

export const patchScopeSchema = z.enum(["uncommitted", "branch", "committed"]);
export type PatchScope = z.infer<typeof patchScopeSchema>;

export const patchInputSchema = z.object({
  ref: repoRefSchema,
  path: relativePath,
  previousPath: relativePath.nullable(),
  untracked: z.boolean(),
  scope: patchScopeSchema,
  sha: shaSchema.nullable().default(null),
}).strict();
export type PatchInput = z.infer<typeof patchInputSchema>;
export type PatchRequest = z.input<typeof patchInputSchema>;

export const patchOutputSchema = z.object({
  patch: z.string(),
  truncated: z.boolean(),
  binary: z.boolean(),
}).strict();
export type PatchOutput = z.infer<typeof patchOutputSchema>;

export const recordedEditsInputSchema = z.object({
  threadIds: z.array(text.min(1)).max(200),
  rawPaths: z.array(text.min(1)).max(20),
}).strict();
export type RecordedEditsInput = z.infer<typeof recordedEditsInputSchema>;

export const recordedEditsOutputSchema = z.object({
  edits: z.array(z.object({
    threadId: text,
    at: count,
    kind: z.enum(["add", "delete", "update"]),
    diff: z.string().nullable(),
    truncated: z.boolean(),
  }).strict()).max(50),
}).strict();
export type RecordedEditsOutput = z.infer<typeof recordedEditsOutputSchema>;

export const commitFilesInputSchema = z.object({ ref: repoRefSchema, sha: shaSchema }).strict();
export type CommitFilesInput = z.infer<typeof commitFilesInputSchema>;

export const commitFilesOutputSchema = z.object({ files: z.array(fileChangeSchema) }).strict();
export type CommitFilesOutput = z.infer<typeof commitFilesOutputSchema>;

export const rpcContract = defineRpcContract({
  overview: { input: overviewInputSchema, output: overviewSchema },
  patch: { input: patchInputSchema, output: patchOutputSchema },
  commitFiles: { input: commitFilesInputSchema, output: commitFilesOutputSchema },
  recordedEdits: { input: recordedEditsInputSchema, output: recordedEditsOutputSchema },
});
