import { useEffect } from "react";
import type { NextStep } from "../contract";
import { NextStepBar } from "./next-step-bar";
import { PlannerPage } from "./planner-page";
import { useLoom } from "./common";

const PLANNING: NextStep = { stage: 0, tone: "normal", title: "Next: answer the planner.", text: "It asks about the goal here, then proposes a draft.", action: null };

/**
 * A planning conversation started from the page. Before it proposes, the Planner page stands alone under the Plan stage;
 * once it proposes, the conversation is the project's Planner tab, so the page opens that.
 */
export function PlanningView({ threadId, openProject }: { threadId: string; openProject(slug: string): void }) {
  const remote = useLoom("planningSession", { threadId });
  const slug = remote.data?.slug ?? null;
  useEffect(() => {
    if (slug !== null) openProject(slug);
  }, [slug, openProject]);
  if (remote.data === undefined) {
    return remote.error === null ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading…</p> : <p role="alert" className="p-4 text-sm text-destructive-text">Could not load the conversation: {remote.error}</p>;
  }
  const session = remote.data;
  if (session === null) return <p className="p-4 text-sm text-muted-foreground">This thread is not a Loom planning thread.</p>;
  if (slug !== null) return <p role="status" className="p-4 text-sm text-muted-foreground">The planner proposed {slug}; opening its Planner tab…</p>;
  return (
    <div data-planning-view className="space-y-1">
      <div className="space-y-3 px-4 pt-4">
        <h1 className="text-sm font-semibold [overflow-wrap:anywhere]">{session.title}</h1>
        <NextStepBar next={PLANNING} busy={false} onAct={() => undefined} />
      </div>
      <PlannerPage threadId={threadId} project={null} />
    </div>
  );
}
