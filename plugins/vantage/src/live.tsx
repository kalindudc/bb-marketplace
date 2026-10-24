import { createContext, useContext, useMemo, type ReactNode } from "react";
import { defineContract } from "./define-contract";
import {
  experimental_useRpcKeyedQuery, experimental_useSidebarThreads, type PluginSidebarThread, type PluginSidebarThreadIndicator,
} from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import type { ThreadSummary } from "./contract";

export interface LiveThread {
  id: string;
  title: string;
  indicator: PluginSidebarThreadIndicator;
  archived: boolean;
  sidebar: PluginSidebarThread | null;
}

const LIFECYCLES = ["active", "archived"] as const;
const RUNNING_STATUSES = new Set(["active", "starting", "pending"]);
const WORKING: ReadonlySet<PluginSidebarThreadIndicator> = new Set(["runtime", "background-agent", "background-command", "workflow", "goal", "working-draft"]);

export type SidebarIndex = ReadonlyMap<string, PluginSidebarThread>;
const LiveThreadsContext = createContext<SidebarIndex | null>(null);

// One shared subscription to bb's sidebar data, so every row reads the same snapshot.
export function LiveThreadsProvider({ children }: { children: ReactNode }) {
  const index = useSidebarIndex();
  return <LiveThreadsContext.Provider value={index}>{children}</LiveThreadsContext.Provider>;
}

export function useSidebarIndex(): SidebarIndex {
  const { threads } = experimental_useSidebarThreads({ experimental_lifecycles: LIFECYCLES });
  return useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
}

export function useLiveIndex(): SidebarIndex {
  return useContext(LiveThreadsContext) ?? EMPTY;
}
const EMPTY: SidebarIndex = new Map();

export function resolveLive(sidebar: PluginSidebarThread | null, fallback: ThreadSummary | undefined, threadId: string): LiveThread {
  // bb's sidebar leaves out hidden threads, such as a study's workers; the overview still knows when one is running.
  const indicator = sidebar?.indicator ?? (fallback !== undefined && RUNNING_STATUSES.has(fallback.status) ? "runtime" : "none");
  return {
    id: threadId,
    title: sidebar?.displayTitle ?? fallback?.title ?? threadId,
    indicator,
    archived: sidebar?.isArchived ?? fallback?.archived ?? false,
    sidebar,
  };
}

export function useLiveThread(threadId: string, fallback: ThreadSummary | undefined): LiveThread {
  return resolveLive(useLiveIndex().get(threadId) ?? null, fallback, threadId);
}

export const isWorking = (live: Pick<LiveThread, "indicator" | "archived">): boolean => !live.archived && WORKING.has(live.indicator);
export const needsYou = (live: Pick<LiveThread, "indicator" | "archived">): boolean =>
  !live.archived && (live.indicator === "waiting-for-input" || live.indicator === "unread-error");

// The parts of GitHub PR Status's `pullRequests` reply Vantage reads; `bb plugin rpc inspect bb--github-pr-status pullRequests` has it all.
const githubPrStatus = defineContract({
  pullRequests: {
    input: z.object({ keys: z.array(z.string()) }),
    output: z.record(z.string(), z.discriminatedUnion("outcome", [
      z.object({
        outcome: z.literal("available"),
        pullRequest: z.object({
          number: z.number(),
          title: z.string(),
          url: z.string(),
          state: z.enum(["draft", "open", "merged", "closed"]),
          attention: z.string(),
          checks: z.object({ state: z.string() }),
        }),
      }),
      z.object({ outcome: z.literal("absent") }),
      z.object({ outcome: z.literal("unavailable"), message: z.string() }),
    ])),
  },
});

export interface PullRequest { number: number; title: string; url: string; state: "draft" | "open" | "merged" | "closed"; attention: string; checks: string }

export function usePullRequest(environmentId: string | null | undefined): PullRequest | null {
  const { data } = experimental_useRpcKeyedQuery({
    pluginId: "bb--github-pr-status",
    contract: githubPrStatus,
    method: "pullRequests",
    keys: environmentId ? [environmentId] : [],
  });
  const row = environmentId ? data?.[environmentId] : undefined;
  if (row?.outcome !== "available") return null;
  const { pullRequest } = row;
  return { ...pullRequest, checks: pullRequest.checks.state };
}
