import type { Plan, ScheduleInput } from "./schema";

export function scheduleLabel(schedule: ScheduleInput) {
  return schedule.cadence === "weekly"
    ? `weekly ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][schedule.weekday!]} ${schedule.at}`
    : `daily ${schedule.at}`;
}

export function scheduledSlots(plan: Pick<Plan, "party">) {
  return plan.party.flatMap((slot, index) => slot.permanent?.schedules
    ? [{ slot: index + 1, purpose: slot.purpose, schedules: slot.permanent.schedules }]
    : []);
}
