import { experimental_useRpcKeyedQuery, type PluginRpcContract } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import type { Resource } from "./info-data";

const pullRequestSchema = z.object({
  number: z.number().int().positive(), title: z.string(), url: z.string().url(),
  state: z.enum(["draft", "open", "merged", "closed"]),
  checks: z.object({ state: z.string() }), review: z.object({ state: z.string() }),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

// Read-only subset of bb--github-pr-status's environment-keyed contract; extra provider fields are ignored.
export const pullRequestContract = {
  pullRequests: {
    input: z.object({ keys: z.array(z.string().min(1)).min(1).max(200) }),
    output: z.record(z.string(), z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("available"), pullRequest: pullRequestSchema }),
      z.object({ outcome: z.literal("absent") }),
      z.object({ outcome: z.literal("unavailable"), message: z.string() }),
    ])),
    keyTags: (key: string) => [`environment:${key}`],
  },
} satisfies PluginRpcContract;

export function usePullRequest(environmentId: string | null | undefined): Resource<PullRequest | null> | null {
  const { data, error, isLoading } = experimental_useRpcKeyedQuery({
    contract: pullRequestContract, pluginId: "bb--github-pr-status", method: "pullRequests",
    keys: environmentId ? [environmentId] : [],
  });
  const result = environmentId ? data?.[environmentId] : undefined;
  if (!environmentId) return null;
  if (error || result?.outcome === "unavailable") return { status: "error" };
  if (!result) return { status: isLoading ? "loading" : "error" };
  return { status: "ready", value: result.outcome === "available" ? result.pullRequest : null };
}
