import { createHash } from "node:crypto";
import type { PlacementRule } from "../../shared/placement-settings";

export function targetModelName(target: PlacementRule["target"]): string {
  if (target.kind !== "provider") return "The Keeper's machine";
  return `${target.machine.type === "new" ? target.machine.machineProviderId : target.machine.type}/${target.environmentProviderId}`;
}

export function targetModelKey(target: PlacementRule["target"], model: string | undefined, providerId: string): string | null {
  if (target.kind !== "provider" || !model) return null;
  return createHash("sha256").update(JSON.stringify([targetModelName(target), providerId, model])).digest("hex");
}

export function modelResolutionFailure(message: string): boolean {
  return /failed to resolve (?:Pi )?model|(?:unknown|unrecognized|not found) model|model[^\n]*(?:not found|does not exist|cannot be resolved|can't be resolved)/i.test(message);
}
