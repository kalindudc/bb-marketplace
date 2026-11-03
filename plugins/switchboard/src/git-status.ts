import { useEffect, useState } from "react";
import { experimental_useRpcKeyedQuery, type PluginRpcContract } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import type { Resource } from "./info-data";

const changeStats = { insertions: z.number(), deletions: z.number(), fileCount: z.number() };
const statusRow = z.discriminatedUnion("outcome", [
  z.looseObject({ outcome: z.literal("available"), workspace: z.looseObject({
    workingTree: z.looseObject(changeStats),
    mergeBase: z.looseObject({ ...changeStats, aheadCount: z.number(), behindCount: z.number(), mergeBaseBranch: z.string() }).nullable(),
  }) }),
  z.looseObject({ outcome: z.literal("not_applicable"), message: z.string() }),
  z.looseObject({ outcome: z.literal("unavailable"), failure: z.looseObject({ message: z.string() }) }),
  z.looseObject({ outcome: z.literal("failed"), message: z.string() }),
]);
export type GitStatus = z.infer<typeof statusRow>;

// Read-only subset of bb--git's environment-keyed status; each row compares against its environment's merge base.
export const gitStatusContract = {
  status: {
    input: z.object({ keys: z.array(z.string().min(1)).min(1).max(200) }),
    output: z.record(z.string(), statusRow),
    keyTags: (key: string) => [`status:${key}`],
  },
} satisfies PluginRpcContract;

// git runs on the thread's machine, so a card that is only passed over reads nothing.
const READ_DELAY_MS = 250;
const MAX_WARM = 200;
const warm = new Set<string>();

export function resetGitStatus(): void {
  warm.clear();
}

export function useGitStatus(environmentId: string | null): Resource<GitStatus> | null {
  const [armed, setArmed] = useState<string | null>(() => environmentId !== null && warm.has(environmentId) ? environmentId : null);
  useEffect(() => {
    if (environmentId === null || warm.has(environmentId)) { setArmed(environmentId); return; }
    const timer = setTimeout(() => {
      warm.add(environmentId);
      if (warm.size > MAX_WARM) warm.delete(warm.values().next().value!);
      setArmed(environmentId);
    }, READ_DELAY_MS);
    return () => clearTimeout(timer);
  }, [environmentId]);
  const { data, error } = experimental_useRpcKeyedQuery({
    contract: gitStatusContract, pluginId: "bb--git", method: "status",
    keys: armed !== null && armed === environmentId ? [armed] : [],
  });
  if (environmentId === null) return null;
  const row = data?.[environmentId];
  if (row?.outcome === "failed" || (row === undefined && error)) return { status: "error" };
  return row === undefined ? { status: "loading" } : { status: "ready", value: row };
}
