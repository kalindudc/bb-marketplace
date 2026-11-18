import type { Phase } from "../../shared/schema";

export const PHASE_STEPS: { id: Phase; label: string; plain: string | null }[] = [
  { id: "scout", label: "Rangers out", plain: "scout" }, { id: "greenlight", label: "Form the party", plain: "greenlight" }, { id: "build", label: "Build", plain: null },
  { id: "check", label: "Warden's trial", plain: "check" }, { id: "wrap", label: "Return", plain: "wrap" },
];
/** Stopping and stopped light no segment: the path's strip is struck instead. */
export const phaseIndex = (phase: Phase) => phase === "done" ? 5 : phase === "closing" ? 4 : phase === "stopped" || phase === "stopping" ? -1 : PHASE_STEPS.findIndex((p) => p.id === phase);
export const phaseWord = (phase: Phase) => phase === "closing" ? "Waiting for you to conclude" : phase === "held" ? "Held by you" : phase === "done" ? "Returned" : phase === "stopped" ? "Stopped" : phase === "stopping" ? "Stopping" : phase.charAt(0).toUpperCase() + phase.slice(1);
