import { z } from "zod";
export const pullRequestSchema = z.object({
  id: z.string().min(1), keeperThreadId: z.string().min(1), boardQuestId: z.string().nullable(), projectId: z.string().min(1),
  url: z.string().url().regex(/^https?:\/\//), forge: z.string().min(1).nullable(), head: z.string().min(1), base: z.string().min(1), owner: z.string().min(1),
  memberThreadId: z.string().min(1), memberHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), pushedHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable(),
  verifiedCommit: z.string().nullable(), state: z.enum(["draft", "ready", "merged", "closed"]),
  closeRequest: z.object({ askId: z.string(), error: z.string().optional() }).optional(),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;
export const pullRequestHead = (pr: PullRequest) => pr.pushedHead ?? pr.memberHead;
export const pullRequestVerified = (pr: PullRequest) => pr.verifiedCommit === pullRequestHead(pr);
export const pullRequestLine = (pr: PullRequest) => `Draft PR: ${pr.url} (${pr.state}; owner: ${pr.owner}; ${pullRequestVerified(pr) ? "head verified" : "head not verified"})`;
