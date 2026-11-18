import type { PlacementView } from "../../../src/shared/placement-view";

export const pendingPlacement: PlacementView = {
  placementId: "placement-juno", generation: 3,
  where: { kind: "pending", label: "Vendor sandbox, starting" },
  rule: { id: "project-remote", label: "Project on a machine" },
  phase: "provisioning", hold: null, blocker: null,
  posture: { label: "Detection only (remote)", detail: null },
  source: null, preservation: "not-needed", preservationReason: null,
};
export const readyPlacement: PlacementView = {
  ...pendingPlacement, where: { kind: "host", hostId: "remote-host", label: "Builder machine 17" }, phase: "ready",
  posture: { label: "Detection only (remote)", detail: "pre-exec checks only, no containment" },
};
export const blockedPlacement: PlacementView = {
  ...pendingPlacement, phase: "blocked",
  blocker: { stage: "provision", message: "The provider refused this machine: quota reached.", retryable: true },
};
export const placementHolds: NonNullable<PlacementView["hold"]>[] = [
  { kind: "maker-slot", message: "Waiting for a maker slot: 5 of 5 in use" },
  { kind: "checker-slot", message: "Waiting for a checker slot: 2 of 2 in use" },
  { kind: "transfer-slots", message: "Waiting for transfer slots: 32 in use (limit 32)" },
  { kind: "maker-busy", message: "Waiting for Juno to finish its turn before its work can be checked." },
];
