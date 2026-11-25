const explicit = { level: "user-explicit", proof: "act and surface" } as const;
const words = { level: "user-in-words", proof: "routed user message, quoted exactly" } as const;
const keeper = { level: "keeper", proof: "recorded reversible decision" } as const;
const pullRequest = { level: "keeper", proof: "receipt on a quest-owned pull request" } as const;
const invariant = { level: "tavern", proof: "invariant" } as const;
export const AUTHORITY = {
  delegateQuest: explicit, preapproveQuest: explicit, revokeQuestAuthority: explicit, revokeShellGrant: explicit,
  answerAsk: explicit, greenlight: explicit, conclude: explicit, closeEarly: explicit, updateMemberSchedule: explicit,
  resolveHandBack: explicit,
  releaseCheckerHandoff: explicit, awayClose: explicit, awayReturn: explicit,
  addRule: explicit, widenRule: explicit, confirmRule: explicit, undoDecision: explicit, resetUndoLane: explicit,
  correctRoute: explicit, stopBoardQuest: explicit, stopKeeperGoneQuests: explicit, resumeAll: explicit, prepareTellKeepers: explicit,
  placementRetry: explicit, placementModelFailureClear: explicit,
  holdBoardQuest: explicit, resumeBoardQuest: explicit, allowReview: explicit, setSpendBudget: explicit, renameBoardQuest: explicit,
  archiveBoardQuests: explicit, deleteBoardQuest: explicit, restoreDeletedQuest: explicit,
  setTaleKept: explicit, journalEdit: explicit, resumeKeeper: explicit, refreshKeeper: explicit, cancelKeeperRefresh: explicit, finishKeeperHandover: explicit,
  saveCharacterVoice: explicit, saveCharacterAvatar: explicit, saveClass: explicit, removeClassOverride: explicit,
  applyClassExecution: explicit, dismissClassNotice: explicit,
  settingsAgentChange: { level: "keeper", proof: "recorded user grant and calling thread", grant: "tavern.agentsMayChangeSettings" },
  settingsUpdate: explicit, settingsUndo: explicit, settingsImport: explicit,
  setupApply: explicit, setupDismiss: explicit,
  memoryConfigure: explicit, memoryManage: explicit,
  alertTestSend: explicit, alertTestConfirm: explicit,
  settingsFile: explicit, settingsApplySuggestion: explicit, settingsEndOverride: explicit, backupRestore: explicit,
  guardInstall: explicit, guardUninstall: explicit,
  releaseHold: explicit,
  openQuest: words, reopenQuest: words, weakenChecks: words, steerDecision: words,
  holdQuestFromMessage: words, resumeQuestFromMessage: words,
  keepMember: keeper, releaseMember: keeper, defaultDecision: keeper, acceptWaypoint: keeper, skipWaypoint: keeper, reopenWaypoint: keeper, exceedParty: keeper, exceedRangers: keeper,
  readyPullRequest: pullRequest, closePullRequest: pullRequest, replyPullRequest: pullRequest,
  verifyOwnWork: invariant, upgradeResolution: invariant, changeClosedCredits: invariant,
} as const;

export const USER_ONLY_CLI = [
  "ask", "release", "return", "rule", "stop", "settings set", "settings import", "settings undo",
  "settings apply", "settings file", "settings export --file", "guard install", "guard uninstall",
  "backup restore", "stop-all resume",
] as const;

export type Act = keyof typeof AUTHORITY;
export type AuthorityLevel = typeof AUTHORITY[Act]["level"];
