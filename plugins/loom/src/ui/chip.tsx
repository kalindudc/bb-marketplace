import { experimental_DetailRow as DetailRow, experimental_Icon as Icon, useBbNavigate, type ExperimentalThreadInfoProps, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import type { ThreadInfo } from "../contract";
import { useLoom } from "./common";

const ROLES: Record<ThreadInfo["role"], string> = { planner: "Planner", worker: "Worker", reviewer: "Reviewer" };

/** Where a Loom thread opens on the Loom page: its ticket, its project, or, before a spec exists, its planning conversation. */
const subPathOf = (info: ThreadInfo, threadId: string) => (info.slug === null ? `_plan/${threadId}` : info.key === null ? info.slug : `${info.slug}/${info.key}`);

/** A worker, reviewer or planner thread's link to its ticket (or project) on the Loom page; a planning conversation without a spec links to itself there. Other threads show nothing. */
export function TicketChip({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  // Its state moves with the ticket; a thread that was not a Loom thread a moment ago may have become one.
  const info = useLoom("threadInfo", { threadId }, { enabled: !isCompactViewport }).data ?? null;
  if (isCompactViewport || info === null) return null;
  const label = info.slug === null ? "Planning" : info.key === null ? info.slug : `${info.key} · ${info.state}`;
  return (
    <button
      type="button"
      aria-label={info.slug === null ? "Open this planning conversation in Loom" : `Open ${info.key ?? info.slug} in Loom`}
      onClick={() => navigate.toPluginPanel("loom", { subPath: subPathOf(info, threadId) })}
      className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Icon name="loom/loom" className="size-3.5" aria-hidden />
      {label}
    </button>
  );
}

/** The thread Info tab's Loom row: the ticket or project the thread works on, in what state, and the thread's role, linked to the Loom page. It shows on phones too, where the header has no chip. */
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
