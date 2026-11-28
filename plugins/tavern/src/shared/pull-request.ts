import { z } from "zod";
export const pullRequestDraftOperationSchema = z.enum(["comment", "review", "approve", "close", "edit"]);
export type PullRequestDraftOperation = z.infer<typeof pullRequestDraftOperationSchema>;
export const reviewCommentIdSchema = z.string().regex(/^[1-9]\d*$/);
export const reviewThreadIdSchema = z.string().regex(/^[\w-]+$/);
export const pullRequestReviewerSchema = z.string().max(100).regex(/^[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\/[a-z\d](?:[a-z\d-]*[a-z\d])?)?$/i);
export const pullRequestSchema = z.object({
  id: z.string().min(1), keeperThreadId: z.string().min(1), boardQuestId: z.string().nullable(), projectId: z.string().min(1),
  url: z.string().url().regex(/^https?:\/\//), forge: z.string().min(1).nullable(), forgeVerified: z.literal(true).optional(), head: z.string().min(1), base: z.string().min(1), owner: z.string().min(1),
  memberThreadId: z.string().min(1), memberHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), pushedHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable(),
  verifiedCommit: z.string().nullable(),
  verdict: z.object({ commit: z.string(), entryId: z.string(), wardenThreadId: z.string(), at: z.number() }).optional(),
  readyDecisionId: z.string().optional(),
  state: z.enum(["draft", "ready", "merged", "closed"]),
  closeRequest: z.object({ askId: z.string(), error: z.string().optional() }).optional(),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;
export const githubPullRequestUrl = (url: string) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?$/i.test(url);
export const pullRequestHead = (pr: PullRequest) => pr.pushedHead ?? pr.memberHead;
export const pullRequestVerified = (pr: PullRequest) => pr.verifiedCommit === pullRequestHead(pr);
export const pullRequestLine = (pr: PullRequest) => `Draft PR: ${pr.url} (${pr.state}; owner: ${pr.owner}; ${pullRequestVerified(pr) ? "head verified" : "head not verified"})`;
