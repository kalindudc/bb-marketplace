import { experimental_DetailRow as DetailRow, useBbNavigate, type ExperimentalThreadInfoProps } from "@get-bb/plugin-sdk/app";
import type { ThreadInfo } from "../contract";
import { useLoom } from "./common";
import { subPathOf } from "./thread-surfaces";

const ROLES: Record<ThreadInfo["role"], string> = { planner: "Planner", worker: "Worker", reviewer: "Reviewer" };

/** The thread Info tab's Loom row: the ticket or project the thread works on, in what state, and the thread's role, linked to the Loom page. */
export function LoomInfoRow({ threadId }: ExperimentalThreadInfoProps) {
  const navigate = useBbNavigate();
  const info = useLoom("threadInfo", { threadId }).data ?? null;
  if (info === null) return null;
  const what = info.slug === null ? "Planning conversation" : info.key === null ? info.slug : info.key;
  const detail = info.slug === null ? "no spec yet" : `${info.state.replace("_", " ")} · ${ROLES[info.role]}${info.key === null ? "" : ` on ${info.slug}`}`;
  return (
    <DetailRow label="Loom" icon="loom/loom">
      <span data-loom-info className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        <button type="button" className="cursor-pointer truncate underline-offset-2 hover:underline" onClick={() => navigate.toPluginPanel("loom", { subPath: subPathOf(info, threadId) })}>
          {what}
        </button>
        <span className="truncate text-muted-foreground">{detail}</span>
      </span>
    </DetailRow>
  );
}
