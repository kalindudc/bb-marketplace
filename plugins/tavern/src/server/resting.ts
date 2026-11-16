import type { Member } from "../shared/schema";

export interface RestingMember {
  threadId: string;
  displayName: string;
  classId: string;
  state: Member["state"];
  boardQuestId: string | null;
  waypointId?: string | null;
}

/** Advisory only: a resting member is a cheaper, better-informed option than a fresh hire for a bounded follow-up on familiar ground. */
export function restingAdvisory(
  members: readonly RestingMember[],
  request: { classId: string; boardQuestId?: string | null; reviewedWaypoints?: ReadonlySet<string> },
): string | null {
  const resting = members.filter(member => member.state === "done" || member.state === "stopped");
  if (!resting.length) return null;
  const relevant = resting.filter(member => !request.boardQuestId || member.boardQuestId === request.boardQuestId);
  if (!relevant.length) return null;
  const matching = (classId: string) => relevant.filter(member => member.classId === classId);
  const named = (classId: string) => matching(classId)
    .map(member => `${member.displayName} (${member.state === "stopped" ? "released" : "resting"}${member.waypointId ? `, ${member.waypointId}` : ""}, ${member.threadId})`);
  const scouts = named("ranger"), wanderers = named("wanderer"), wardens = named("warden");
  const builders = named("smith");
  const midReview = matching("smith").some(member => member.waypointId !== null && member.waypointId !== undefined && request.reviewedWaypoints?.has(member.waypointId));
  const lines: string[] = [];
  if (scouts.length) lines.push(`Resting scouts: ${scouts.join("; ")}. Re-brief one for a bounded follow-up on familiar ground instead of hiring.`);
  if (builders.length)
    lines.push(`Resting builders: ${builders.join("; ")}. Re-brief one only for a bounded follow-up on the same work; an unrelated task, a new domain${midReview ? " or a builder whose work is mid-review" : " or an independence check"} needs a fresh hire, not a re-brief.`);
  if (wanderers.length) lines.push(`Resting errand helpers: ${wanderers.join("; ")}. Reuse one only for the same bounded work.`);
  if (wardens.length) lines.push(`Resting Wardens: ${wardens.join("; ")}. Never re-brief a Warden; a check needs a fresh context.`);
  return lines.length ? `Resting party you could reuse (advisory, never a refusal):\n- ${lines.join("\n- ")}` : null;
}

export function restingMembers(members: readonly Member[], reviewedWaypoints: ReadonlySet<string>, request: { classId: string; boardQuestId?: string | null }): string | null {
  return restingAdvisory(
    members.map(member => ({
      threadId: member.threadId,
      displayName: member.displayName ?? member.title ?? member.threadId,
      classId: member.classId,
      state: member.state,
      boardQuestId: member.boardQuestId ?? null,
      waypointId: member.waypointId ?? null,
    })),
    { ...request, reviewedWaypoints },
  );
}
