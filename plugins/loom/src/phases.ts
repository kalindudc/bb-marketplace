import type { Spec } from "./spec";
import type { Store, TicketRow } from "./db/store";

export interface PhaseView {
  ref: string;
  title: string;
  goal: string;
  doneWhen: string[];
  outline: string[];
  report: string | null;
  maxTickets: number;
  state: "planned" | "active" | "done";
  tickets: { total: number; done: number; cancelled: number; open: number };
}

export function phasesOf(spec: Spec, tickets: readonly Pick<TicketRow, "phase" | "state">[]): PhaseView[] | null {
  return spec.phase?.map((phase) => {
    const rows = tickets.filter((ticket) => ticket.phase === phase.ref);
    const done = rows.filter((ticket) => ticket.state === "done").length;
    const cancelled = rows.filter((ticket) => ticket.state === "cancelled").length;
    const open = rows.length - done - cancelled;
    return { ref: phase.ref, title: phase.title, goal: phase.goal, doneWhen: phase.done_when, outline: phase.outline ?? [], report: phase.report ?? null, maxTickets: phase.max_tickets ?? 8, state: rows.length === 0 ? "planned" : open === 0 ? "done" : "active", tickets: { total: rows.length, done, cancelled, open } };
  }) ?? null;
}

export function phaseMergeCommits(store: Store, tickets: readonly TicketRow[]): ReadonlyMap<string, string> {
  return new Map(tickets.flatMap((ticket) => {
    const done = store.ticketEvents(ticket.id, ["ticket.state"]).filter((event) => (JSON.parse(event.data_json) as { to?: string }).to === "done").at(-1);
    const data = done === undefined ? null : JSON.parse(done.data_json) as { sha?: string };
    return data?.sha === undefined ? [] : [[ticket.key, data.sha] as const];
  }));
}

export function phaseErrors(spec: Spec): string[] {
  const errors: string[] = [];
  const phases = spec.phase ?? [];
  const phaseIndex = new Map(phases.map((phase, index) => [phase.ref, index]));
  let gap = false;
  phases.forEach((phase, index) => {
    if (phases.findIndex((other) => other.ref === phase.ref) !== index) errors.push(`phase[${index}].ref: phase refs must be unique.`);
    const count = spec.ticket.filter((ticket) => ticket.phase === phase.ref).length;
    if (count === 0) gap = true;
    else if (gap) errors.push(`phase[${index}]: phases with tickets must form a prefix of the roadmap.`);
    if (count > (phase.max_tickets ?? 8)) errors.push(`phase[${index}].max_tickets: ${count} tickets exceed the budget of ${phase.max_tickets ?? 8}.`);
    if (count === 0 && phase.report !== undefined) errors.push(`phase[${index}].report: a report is allowed only on a phase with tickets.`);
  });
  spec.ticket.forEach((ticket, index) => {
    if (spec.phase === undefined && ticket.phase !== undefined) errors.push(`ticket[${index}].phase: cannot name a phase without [[phase]] tables.`);
    if (spec.phase !== undefined && (ticket.phase === undefined || !phaseIndex.has(ticket.phase))) errors.push(`ticket[${index}].phase: name a phase ref from the roadmap; every ticket needs one.`);
    for (const field of ["depends_on", "merge_after"] as const) {
      for (const ref of ticket[field] ?? []) {
        const target = spec.ticket.find((other) => other.ref === ref);
        if (ticket.phase !== undefined && target?.phase !== undefined && phaseIndex.get(target.phase)! > phaseIndex.get(ticket.phase)!) errors.push(`ticket[${index}].${field}: "${ref}" belongs to a later phase.`);
      }
    }
  });
  return errors;
}

export function phaseRevisionErrors(before: Spec | null, after: Spec, tickets: readonly TicketRow[]): string[] {
  if (before === null) return (after.phase ?? []).slice(1).some((phase) => after.ticket.some((ticket) => ticket.phase === phase.ref)) ? ["phase: only the first phase may have tickets in the first proposal."] : [];
  if (before.phase === undefined && after.phase === undefined) return [];
  if (before.phase === undefined || after.phase === undefined) return ["phase: cannot add or remove the roadmap after approval. Keep the project's phase model."];
  const phases = phasesOf(before, tickets)!;
  const errors: string[] = [];
  const started = phases.filter((phase) => phase.state !== "planned");
  started.forEach((phase, index) => {
    if (after.phase![index]?.ref !== phase.ref) errors.push(`phase: cannot drop, rename or reorder started phase "${phase.title}".`);
    const count = tickets.filter((ticket) => ticket.phase === phase.ref).length;
    if ((after.phase!.find((entry) => entry.ref === phase.ref)?.max_tickets ?? 8) < count) errors.push(`phase: max_tickets cannot be less than the ${count} tickets already on "${phase.title}".`);
  });
  const added = after.phase.filter((phase) => !started.some((entry) => entry.ref === phase.ref) && after.ticket.some((ticket) => ticket.phase === phase.ref));
  const active = phases.find((phase) => phase.state === "active");
  if (added.length > 0) {
    if (active !== undefined) errors.push(`phase: ${active.title} is still running. Its tickets may change only through loom_add_tickets, loom_edit_ticket and loom_cancel_ticket.`);
    else if (added.length !== 1 || added[0]!.ref !== after.phase[started.length]?.ref) errors.push("phase: fill in only the first planned phase.");
    const finished = started.at(-1);
    if (finished !== undefined && after.phase.find((phase) => phase.ref === finished.ref)?.report === undefined) errors.push(`phase: write the report for "${finished.title}" before filling in the next phase.`);
    const batch = after.ticket.filter((ticket) => added.some((phase) => phase.ref === ticket.phase));
    const known = new Set([...tickets.map((ticket) => ticket.ref), ...batch.map((ticket) => ticket.ref)]);
    const milestones = new Set((after.rollout?.milestone ?? []).map((milestone) => milestone.ref));
    for (const ticket of batch) {
      if (tickets.some((row) => row.ref === ticket.ref)) errors.push(`ticket: "${ticket.ref}" already exists on the board; use a new ref for the next phase.`);
      for (const field of ["depends_on", "merge_after"] as const) {
        for (const ref of ticket[field] ?? []) if (!known.has(ref)) errors.push(`ticket[${ticket.ref}].${field}: "${ref}" is not on the board or in the next phase. Spec edits to earlier tickets are records only.`);
      }
      for (const ref of ticket.rollout?.requires_live ?? []) if (!known.has(ref) && !milestones.has(ref)) errors.push(`ticket[${ticket.ref}].rollout.requires_live: "${ref}" is not on the board, in the next phase or a milestone.`);
    }
  }
  return errors;
}
