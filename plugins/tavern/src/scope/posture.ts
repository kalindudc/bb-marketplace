import type { ExecutionPosture } from "../shared/placement";
import { postureText } from "../shared/placement-view";

export function formatExecutionPosture(posture: ExecutionPosture): string {
  const remote = posture.aggregate === "remote-detection-only";
  if (remote) {
    const text = postureText(posture);
    return text.label + (text.detail ? "; " + text.detail : "") + (posture.watcher === "degraded" ? "; watcher degraded" : "");
  }
  const observed = !remote && posture.aggregate === "local-pre-exec" &&
    posture.guard === "armed" && posture.toolGate === "pi-observed" &&
    posture.checker !== "detection-only-no-containment";
  let label: string;
  if (!observed) {
    label = remote ? "Remote: detection only" : "Local: detection only";
    if (posture.checker !== "not-a-checker") label += "; checks have no verified containment";
    else if (!remote && posture.guard === "prepared") label += "; guard prepared, session not observed";
  } else if (posture.checker !== "not-a-checker") {
    if (posture.checker === "contained" && posture.filesystem === "macos-sandbox") {
      label = "Local: pre-exec guard and sandboxed checks";
      label += posture.network === "macos-check-deny" ? "; check network denied" : "; network not enforced";
    } else label = "Local: pre-exec checks only, no containment";
  } else label = "Local: pre-exec act guard";
  return label + (posture.watcher === "degraded" ? "; watcher degraded" : "");
}
