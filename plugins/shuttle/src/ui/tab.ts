import { toast } from "sonner";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_useAppPanel } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import { PANEL_ACTION_ID } from "./constants";

const SHUTTLE_TAB = { id: PANEL_ACTION_ID, context: { kind: "thread" }, availability: "action" } as const;

/** The params the tab's launcher opens it with, so every opener focuses the same tab. */
export const tabParams = (threadId: string) => ({ threadId });

export function useOpenShuttleTab() {
  const panel = experimental_useAppPanel();
  return (threadId: string) => {
    if (!panel.experimental_openTab({ surface: { kind: "current" }, tab: SHUTTLE_TAB, params: tabParams(threadId) })) toast.error("bb could not open the Shuttle tab here");
  };
}

export const GITHUB_PR_STATUS = "bb--github-pr-status";

/** The part of GitHub PR Status's contract Shuttle reads: the PR of each environment's branch. */
export const githubPrStatus = defineRpcContract({
  pullRequests: {
    input: z.object({ keys: z.array(z.string()) }),
    output: z.record(
      z.string(),
      z.discriminatedUnion("outcome", [
        z.object({
          outcome: z.literal("available"),
          pullRequest: z.object({
            number: z.number(),
            title: z.string(),
            url: z.string(),
            state: z.enum(["draft", "open", "merged", "closed"]),
          }),
        }),
        z.object({ outcome: z.literal("absent") }),
        z.object({ outcome: z.literal("unavailable"), message: z.string() }),
      ]),
    ),
  },
});
