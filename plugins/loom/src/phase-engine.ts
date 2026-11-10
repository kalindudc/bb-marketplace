import { specOf, type EngineCtx } from "./ctx";
import type { ProjectRow } from "./db/store";
import { phaseMergeCommits, phasesOf } from "./phases";
import { phaseDoneText } from "./prompts";
import { LOOM_ACTOR } from "./states";

export async function followPhases(ctx: EngineCtx, project: ProjectRow): Promise<void> {
  const { store } = ctx;
  const fresh = store.project(project.id);
  if (fresh === null || (fresh.state !== "running" && fresh.state !== "paused")) return;
  const spec = specOf(store, fresh);
  const tickets = store.tickets(fresh.id);
  const phases = phasesOf(spec, tickets);
  if (phases === null) return;
  const recorded = new Set(store.eventsOfKind(fresh.id, "phase.done").map((event) => (JSON.parse(event.data_json) as { ref: string }).ref));
  phases.forEach((phase, index) => {
    const next = phases[index + 1];
    if (phase.state !== "done" || next?.state !== "planned" || recorded.has(phase.ref)) return;
    store.event(fresh.id, null, "phase.done", LOOM_ACTOR, { ref: phase.ref, title: phase.title, index: index + 1, done: phase.tickets.done, cancelled: phase.tickets.cancelled, next: next.ref });
  });
  const told = new Set(store.eventsOfKind(fresh.id, "phase.told").map((event) => (JSON.parse(event.data_json) as { ref: string }).ref));
  const pending = store.eventsOfKind(fresh.id, "phase.done").find((event) => {
    const { ref } = JSON.parse(event.data_json) as { ref: string };
    const index = phases.findIndex((phase) => phase.ref === ref);
    return !told.has(ref) && phases[index]?.state === "done" && phases[index + 1]?.state === "planned";
  });
  // A pending version already waits on the human (often the next phase itself); tell the planner once it is settled.
  if (pending === undefined || fresh.pending_version !== null) return;
  const planner = store.threads({ projectId: fresh.id, role: "planner", states: ["active"] })[0];
  if (planner?.thread_id == null || (await ctx.bb.getThread(planner.thread_id))?.status !== "idle") return;
  const data = JSON.parse(pending.data_json) as { ref: string };
  const index = phases.findIndex((entry) => entry.ref === data.ref);
  const phase = phases[index];
  const next = phases[index + 1];
  if (phase === undefined || next === undefined) return;
  await ctx.bb.send(planner.thread_id, { summary: `[loom] Phase ${phase.title} is done. Plan ${next.title} for human approval.`, detail: phaseDoneText(fresh, phase, next, tickets.filter((ticket) => ticket.phase === phase.ref), phaseMergeCommits(store, tickets)) });
  store.event(fresh.id, null, "phase.told", LOOM_ACTOR, { ref: phase.ref, next: next.ref });
}
