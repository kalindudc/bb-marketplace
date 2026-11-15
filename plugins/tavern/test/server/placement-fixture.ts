import type { PlacementRecord, SourceSnapshot } from "../../src/shared/placement";

export const gitSha = "a".repeat(40);
export const digest = "b".repeat(64);
export const endpoint = { hostId: "local", environmentId: "env", root: "/checkout" };

export function placementRecord(overrides: Partial<PlacementRecord> = {}): PlacementRecord {
  return {
    id: "placement", generation: 1, desiredState: "running", hireToken: "hire",
    keeperThreadId: "keeper", memberThreadId: null, projectId: "project", questId: "quest",
    classId: "smith", slot: "maker",
    rule: {
      id: "local", settingsRevision: 1, definitionDigest: digest,
      acceptedConsent: { guardInstall: false, remoteDetectionOnly: false, linuxUncontainedChecks: false },
    },
    matchEvidence: [], target: { type: "reuse", environmentId: "env" },
    allocationKey: "allocation", ownsNewMachine: false, workspaceKind: "linked-worktree",
    hostId: null, environmentId: null, root: null, sourceSnapshotId: null, reviewTarget: null,
    phase: "reserved", resumePhase: null, blocked: null,
    preservation: {
      source: "not-needed", artifacts: "not-declared", snapshotId: null,
      artifactManifestId: null, liveOwnerThreadId: null, stopConfirmed: false, reason: null,
    },
    posture: {
      aggregate: "local-detection-only", guard: "unavailable", toolGate: "not-established",
      filesystem: "not-established", network: "not-established", checker: "not-a-checker",
      watcher: "active", ruleConsentId: "local", warnings: [],
    },
    desiredScopeRevision: 1, acknowledgedScopeRevision: null, createdAt: 1, updatedAt: 1,
    ...overrides,
  };
}

export function sourceSnapshot(overrides: Partial<SourceSnapshot> = {}): SourceSnapshot {
  return {
    id: "snapshot", purpose: "initial", keeperThreadId: "keeper", projectId: "project",
    sourceThreadId: "keeper", makerThreadId: null, makerSubmissionId: null, journalTarget: null,
    objectFormat: "sha1", base: gitSha, sourceHead: gitSha, tree: gitSha,
    source: endpoint, home: endpoint, homeCommit: null,
    homeRef: "refs/tavern/snapshots/snapshot", createdAt: 1,
    ...overrides,
  };
}
