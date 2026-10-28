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

const jobSchema = z.object({
  state: z.enum(["queued", "running", "failed"]),
  detail: z.string().nullable(),
});

export const pendingUpdateSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  imageUrl: z.string().nullable(),
  installed: versionSchema,
  candidate: versionSchema,
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
  compareUrl: z.string().nullable(),
  /** Why nothing could be read, when nothing could. */
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
