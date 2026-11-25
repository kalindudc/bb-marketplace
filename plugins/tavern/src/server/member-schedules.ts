import type { Keeper } from "./keeper/service";
import type { MemberSchedule, ScheduleControl, ScheduleInput } from "../shared/schema";

export function nextScheduleAt(schedule: ScheduleInput, after: number): number {
  const date = new Date(after);
  const [hour, minute] = schedule.at.split(":").map(Number);
  let days = schedule.weekday === undefined ? 0 : (schedule.weekday - date.getDay() + 7) % 7;
  const at = () => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, hour, minute).getTime();
  if (at() <= after) days += schedule.cadence === "weekly" ? 7 : 1;
  return at();
}

export function startSchedules(k: Keeper, schedules: ScheduleInput[]): MemberSchedule[] {
  const now = k.now();
  return schedules.map(schedule => ({ ...schedule, id: k.store.id("schedule"), nextAt: nextScheduleAt(schedule, now) }));
}

export function updateMemberSchedule(k: Keeper, threadId: string, control: ScheduleControl, keeperId?: string) {
  const member = k.member(threadId), permanent = member?.permanent;
  if (!member?.boardQuestId || !permanent || (keeperId && member.keeperThreadId !== keeperId)) throw new Error("This permanent member is unavailable.");
  const schedules = permanent.schedules ?? [];
  const row = schedules.find(schedule => schedule.id === control.id);
  if (!row || (control.action === "pause" && row.paused)) return;
  k.store.atomic(() => {
    const next = control.action === "pause"
      ? schedules.map(schedule => schedule === row ? { ...schedule, paused: true as const } : schedule)
      : schedules.filter(schedule => schedule !== row);
    k.store.put("members", threadId, { ...member, permanent: { ...permanent, schedules: next } });
    k.store.event(k.now(), member.keeperThreadId, member.boardQuestId, "member.schedule-updated",
      `${control.action === "pause" ? "Paused" : "Removed"} a schedule for ${k.name(member)}.`,
      { memberThreadId: threadId, scheduleId: row.id, action: control.action }, keeperId ? { kind: "agent", threadId: keeperId } : { kind: "user" });
  });
  k.changed(threadId, member.boardQuestId);
}
