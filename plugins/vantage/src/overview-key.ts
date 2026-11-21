import type { OverviewInput } from "./contract";

export function overviewKey({
  target,
  scope,
  includeArchived,
  hours,
}: Omit<OverviewInput, "refresh"> & { hours?: number }): string {
  return JSON.stringify([
    target.kind,
    target.kind === "tree" ? target.threadId : (hours ?? null),
    scope,
    includeArchived,
  ]);
}
