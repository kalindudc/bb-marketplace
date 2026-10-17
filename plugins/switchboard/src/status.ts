import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

export type RowState = "failed" | "needs" | "running" | "unread" | "idle";
export const STATE_ORDER: readonly RowState[] = ["failed", "needs", "running", "unread", "idle"];
export const STATE_LABEL: Readonly<Record<RowState, string>> = {
  failed: "Failed", needs: "Needs you", running: "Running", unread: "Finished, unread", idle: "Idle",
};
export type StateCounts = Readonly<Record<Exclude<RowState, "idle">, number>>;
export const EMPTY_COUNTS: StateCounts = { failed: 0, needs: 0, running: 0, unread: 0 };

export function rowState(thread: PluginSidebarThread): RowState {
  if (thread.status === "error" || thread.queuedWork === "failed" ||
      thread.indicator === "unread-error" || thread.indicator === "queued-failed") return "failed";
  if (thread.hasPendingInteraction || thread.indicator === "waiting-for-input") return "needs";
  if (thread.status === "starting" || thread.status === "active" || thread.status === "stopping" ||
      thread.runtimeStatus === "provisioning" || thread.runtimeStatus === "waiting-for-host" ||
      Object.values(thread.activity).some((count) => count > 0) ||
      ["runtime", "background-agent", "background-command", "workflow", "goal", "plan-mode", "queued-waiting"].includes(thread.indicator)) return "running";
  return thread.isUnread ? "unread" : "idle";
}

export function worstState(states: Iterable<RowState>): RowState {
  let worst: RowState = "idle";
  for (const state of states) if (STATE_ORDER.indexOf(state) < STATE_ORDER.indexOf(worst)) worst = state;
  return worst;
}

export function countStates(states: Iterable<RowState>): StateCounts {
  const counts = { ...EMPTY_COUNTS };
  for (const state of states) if (state !== "idle") counts[state]++;
  return counts;
}
