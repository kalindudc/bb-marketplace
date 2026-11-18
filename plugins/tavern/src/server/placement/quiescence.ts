/** A thread is quiescent when its last turn has ended, successfully or not, and no background agent is running. */
export function isQuiescentThread(thread: { status: string; activeBackgroundAgentCount: number }): boolean {
  return (thread.status === "idle" || thread.status === "error") && thread.activeBackgroundAgentCount === 0;
}
