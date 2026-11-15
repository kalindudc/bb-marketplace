// @vitest-environment node
import { expect, it } from "vitest";
import type { ExecutionPosture } from "../../src/shared/placement";
import { formatExecutionPosture } from "../../src/scope/posture";

const posture: ExecutionPosture = { aggregate: "local-pre-exec", guard: "armed", toolGate: "pi-observed", filesystem: "none", network: "not-enforced", checker: "not-a-checker", watcher: "active", ruleConsentId: "rule-a", warnings: [] };
it("labels an observed local pi gate without claiming filesystem containment", () => {
  expect(formatExecutionPosture(posture)).toBe("Local: pre-exec guard");
});
it("does not upgrade a prepared or failed guard into session proof", () => {
  expect(formatExecutionPosture({ ...posture, guard: "prepared", toolGate: "not-established" })).toBe("Local: detection only; guard prepared, session not observed");
  expect(formatExecutionPosture({ ...posture, guard: "failed" })).toBe("Local: detection only");
});
it("keeps remote execution detection-only even if host artifacts claim an armed guard", () => {
  expect(formatExecutionPosture({ ...posture, aggregate: "remote-detection-only", filesystem: "macos-sandbox" })).toBe("Remote: detection only");
  expect(formatExecutionPosture({ ...posture, aggregate: "remote-detection-only", checker: "contained", filesystem: "macos-sandbox", network: "macos-check-deny" })).toBe("Remote: detection only; checks have no verified containment");
});
it("labels Linux checks without containment", () => {
  expect(formatExecutionPosture({ ...posture, checker: "pre-exec-no-containment" })).toBe("Local: pre-exec checks only, no containment");
});
it("claims contained checks only when the filesystem field establishes them", () => {
  expect(formatExecutionPosture({ ...posture, checker: "contained", filesystem: "macos-sandbox", network: "macos-check-deny" })).toBe("Local: pre-exec guard and sandboxed checks; check network denied");
  expect(formatExecutionPosture({ ...posture, checker: "contained" })).toBe("Local: pre-exec checks only, no containment");
});
it("does not upgrade an explicitly detection-only checker and reports degraded observation", () => {
  expect(formatExecutionPosture({ ...posture, checker: "detection-only-no-containment", watcher: "degraded" })).toBe("Local: detection only; checks have no verified containment; watcher degraded");
});
it("keeps explicit local detection-only posture despite an armed marker", () => {
  expect(formatExecutionPosture({ ...posture, aggregate: "local-detection-only" })).toBe("Local: detection only");
});
