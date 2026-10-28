import type { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

// The SDK's defineRpcContract only returns its argument. A git install leaves dev dependencies out, so the
// same identity lives here rather than as a runtime import of the SDK.
const defineContract: typeof defineRpcContract = ((contract: unknown) => contract) as typeof defineRpcContract;

const versionSchema = z.object({
  /** What bb compares: a commit id for git sources, a package version for npm. */
  version: z.string(),
  /** What a person reads: a release version when one is known, otherwise a short commit id. */
  label: z.string(),
});

export const updatePhaseSchema = z.enum(["preparing", "activating", "checking", "rolling-back"]);
export type UpdatePhase = z.infer<typeof updatePhaseSchema>;

/** The plugin's latest update job in bb's queue, which keeps finished jobs for ten minutes. */
const jobSchema = z.object({
  id: z.string(),
  state: z.enum(["queued", "running", "completed", "failed"]),
  phase: updatePhaseSchema.nullable(),
  /** 1 for the next job to run. */
  queuePosition: z.number().int().positive().nullable(),
  /** How a completed job ended; "rolled-back" means the new version failed its check and the old one is back. */
  outcome: z.enum(["updated", "current", "rolled-back"]).nullable(),
  error: z.string().nullable(),
});
export type UpdateJob = z.infer<typeof jobSchema>;

/** A plugin with a waiting update, an update in bb's queue, or one that finished in the last ten minutes. */
export const pendingUpdateSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  imageUrl: z.string().nullable(),
  installed: versionSchema,
  candidate: versionSchema,
  /** bb still offers the candidate. bb clears this as soon as it starts activating the new version. */
  updateAvailable: z.boolean(),
  lastFailure: z.string().nullable(),
  job: jobSchema.nullable(),
});
export type PendingUpdate = z.infer<typeof pendingUpdateSchema>;

export const changelogSchema = z.object({
  /** The release's package version, read from the candidate when the source names no release. */
  toVersion: z.string().nullable(),
  /** CHANGELOG.md sections newer than the installed version, newest first. */
  notes: z.array(z.object({ version: z.string(), title: z.string(), body: z.string() })),
  /** Commits between the installed and the candidate commit that touch the plugin, newest first. */
  commits: z.array(z.object({ sha: z.string(), title: z.string(), url: z.string() })),
  /** Commits read but not listed. */
  moreCommits: z.number().int().nonnegative(),
  /** GitHub returned a full page, so there may be more commits than were counted. */
  commitsCapped: z.boolean(),
  /** Why the release's CHANGELOG.md or package.json couldn't be read; the rest is still shown. */
  changelogError: z.string().nullable(),
  /** Why the plugin's commits couldn't be read; the rest is still shown. */
  commitsError: z.string().nullable(),
  compareUrl: z.string().nullable(),
  /** Why there is nothing to show: the source isn't on GitHub, or nothing could be read. */
  unavailable: z.string().nullable(),
});
export type Changelog = z.infer<typeof changelogSchema>;

export const rpcContract = defineContract({
  list: {
    input: z.null(),
    output: z.object({ updates: z.array(pendingUpdateSchema) }),
  },
  changelog: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: changelogSchema,
  },
  update: {
    input: z.object({ ids: z.array(z.string().min(1)).min(1).max(200) }).strict(),
    output: z.object({
      started: z.array(z.string()),
      failed: z.array(z.object({ id: z.string(), error: z.string() })),
    }),
  },
});
