// Auto post's decisions replayed: the facts each check read, judged again under any settings, so Insights can show what
// would post with your settings today, or with settings you are trying. It mirrors the gate's rules (src/gate.ts) for
// what a setting decides, and keeps what the check found that no setting here can change, such as an unsafe summary.
// Pure: the page runs it on every change, and the tests hold it to the gate's own decisions.
import type { AutoPost, ConcernKind } from "./config";
import type { ReplayDraft, ReplayFinding } from "./contract";

const RANK = { nit: 0, low: 1, medium: 2, high: 3 } as const;
const APPROVAL_RANK = { nit: 0, low: 1, medium: 2 } as const;

/** The settings a replay can change: the ones a decision reads that Insights lets you try. */
export interface ReplaySettings {
  holdComment: ConcernKind[];
  holdApprove: ConcernKind[];
  minSeverity: AutoPost["minSeverity"];
  holds: number;
  worth: number;
  maxLines: number;
  checks: AutoPost["approvals"]["checks"];
  apprMaxLines: number;
  apprSeverity: AutoPost["approvals"]["maxSeverity"];
}

export function replaySettingsOf(config: AutoPost): ReplaySettings {
  return {
    holdComment: [...config.holdConcerns.comment], holdApprove: [...config.holdConcerns.approve], minSeverity: config.minSeverity,
    holds: config.floors.holds, worth: config.floors.worth, maxLines: config.maxLines, checks: config.approvals.checks,
    apprMaxLines: config.approvals.maxLines, apprSeverity: config.approvals.maxSeverity,
  };
}

/** The settings with the replay's values in place, every other field as it was: what Save sends. */
export function withReplaySettings(config: AutoPost, s: ReplaySettings): AutoPost {
  return {
    ...config,
    minSeverity: s.minSeverity, maxLines: s.maxLines,
    floors: { ...config.floors, holds: s.holds, worth: s.worth },
    holdConcerns: { ...config.holdConcerns, comment: [...s.holdComment], approve: [...s.holdApprove] },
    approvals: { ...config.approvals, checks: s.checks, maxLines: s.apprMaxLines, maxSeverity: s.apprSeverity },
  };
}

/** The fields of two settings that differ, by name. */
export function changedSettings(a: ReplaySettings, b: ReplaySettings): Array<keyof ReplaySettings> {
  const same = (x: unknown, y: unknown) => (Array.isArray(x) && Array.isArray(y) ? [...x].sort().join() === [...y].sort().join() : x === y);
  return (Object.keys(a) as Array<keyof ReplaySettings>).filter((key) => !same(a[key], b[key]));
}

/**
 * What holds a draft or an approval. `kept` is something the check found that no setting here changes, with its text;
 * `concern` is a concern of a kind set to hold.
 */
export type Hold =
  | { k: "timing" | "route-approve" | "route-changes" | "route-comment" | "bot" | "size" | "no-size" | "no-risk" | "high-risk" | "not-low-risk" }
  | { k: "checks-failed" | "checks-running" | "checks-none" | "review-changes" | "severity-above" | "findings" | "findings-fixed" | "no-findings" }
  | { k: "concern"; kind: ConcernKind }
  | { k: "kept"; text: string };
export type FindingHold = { k: "nit" | "severity" | "no-line" | "unjudged" | "v-holds" | "v-worth" } | { k: "other"; text: string };
/** Finding holds the page's settings decide: the lowest severity and the verifier's floors. */
const TUNABLE = new Set<FindingHold["k"]>(["severity", "v-holds", "v-worth"]);

export interface ReplayedFinding extends ReplayFinding {
  pass: boolean;
  why: FindingHold[];
}

export interface Replayed {
  draft: ReplayDraft;
  findings: ReplayedFinding[];
  /** What holds its comments; empty when they would post. */
  comment: Hold[];
  /** What holds an approval of the PR, for the record; empty when the rules approve. */
  approval: Hold[];
  posts: boolean;
  /** The rules approve, whatever the draft suggested: the record counts this. */
  approves: boolean;
  /** Shuttle would approve it itself: the rules approve a draft that suggested approving. */
  acts: boolean;
  /** The rules approve, but the verifier's blocking check has not read the diff, which it does before any approval. */
  unchecked: boolean;
}

export const holdKey = (hold: Hold) => (hold.k === "concern" ? `concern:${hold.kind}` : hold.k === "kept" ? `kept:${hold.text}` : hold.k);

function judge(f: ReplayFinding, s: ReplaySettings): ReplayedFinding {
  const why: FindingHold[] = [];
  if (f.severity === "nit") why.push({ k: "nit" });
  else if (RANK[f.severity] < RANK[s.minSeverity]) why.push({ k: "severity" });
  if (f.line === null) why.push({ k: "no-line" });
  if (f.other !== null) why.push({ k: "other", text: f.other });
  if (why.length === 0) {
    if (f.holds === null || f.worth === null) why.push({ k: "unjudged" });
    else {
      if (f.holds < s.holds) why.push({ k: "v-holds" });
      if (f.worth < s.worth) why.push({ k: "v-worth" });
    }
  }
  return { ...f, pass: why.length === 0, why };
}

/** One draft under settings `s`. */
export function replay(draft: ReplayDraft, s: ReplaySettings): Replayed {
  const findings = draft.findings.map((f) => judge(f, s));
  const kinds = [...new Set(draft.concerns)];
  const comment: Hold[] = [];
  const approval: Hold[] = [];
  if (draft.timing !== null) { comment.push({ k: "timing" }); approval.push({ k: "timing" }); }
  if (draft.verdict === "approve") comment.push({ k: "route-approve" });
  if (draft.verdict === "changes") { comment.push({ k: "route-changes" }); approval.push({ k: "route-changes" }); }
  if (draft.bot) { comment.push({ k: "bot" }); approval.push({ k: "bot" }); }
  if (draft.size === null) { comment.push({ k: "no-size" }); approval.push({ k: "no-size" }); }
  else {
    if (draft.size > s.maxLines) comment.push({ k: "size" });
    if (draft.size > s.apprMaxLines) approval.push({ k: "size" });
  }
  if (draft.risk === null) { comment.push({ k: "no-risk" }); approval.push({ k: "no-risk" }); }
  else {
    if (draft.risk === "high") comment.push({ k: "high-risk" });
    if (draft.risk !== "low") approval.push({ k: "not-low-risk" });
  }
  for (const kind of kinds) {
    if (s.holdComment.includes(kind)) comment.push({ k: "concern", kind });
    if (s.holdApprove.includes(kind)) approval.push({ k: "concern", kind });
  }
  if (draft.checks === "failed") approval.push({ k: "checks-failed" });
  else if (draft.checks === "pending" && s.checks === "passed") approval.push({ k: "checks-running" });
  else if ((draft.checks === "none" || draft.checks === null) && s.checks === "passed") approval.push({ k: "checks-none" });
  if (draft.review === "changes") approval.push({ k: "review-changes" });
  if (draft.findings.some((f) => RANK[f.severity] > APPROVAL_RANK[s.apprSeverity])) approval.push({ k: "severity-above" });
  for (const text of draft.kept) comment.push({ k: "kept", text });
  for (const text of draft.keptApproval) approval.push({ k: "kept", text });
  // "findings" when some finding would pass with other floors or severity; "findings-fixed" when none can here.
  if (!findings.some((f) => f.pass)) {
    const tunable = findings.some((f) => f.why.every((w) => TUNABLE.has(w.k)));
    comment.push({ k: !draft.findings.length ? "no-findings" : tunable ? "findings" : "findings-fixed" });
  }
  const approves = approval.length === 0;
  return { draft, findings, comment, approval, posts: comment.length === 0, approves, acts: approves && draft.verdict === "approve", unchecked: approves && draft.blocking === null };
}

/** The 95% lower bound of a proportion (Wilson), or null with nothing decided. */
export function wilsonLower(agreed: number, decided: number, z = 1.96): number | null {
  if (decided === 0) return null;
  const p = agreed / decided;
  return (p + (z * z) / (2 * decided) - z * Math.sqrt((p * (1 - p)) / decided + (z * z) / (4 * decided * decided))) / (1 + (z * z) / decided);
}

/** Agreeing items in a row still needed for the lower bound to reach the target; null when out of reach. */
export function neededFor(agreed: number, against: number, target: number): number | null {
  for (let more = 0; more <= 1000; more++) {
    const lower = wilsonLower(agreed + more, agreed + against + more);
    if (lower !== null && lower >= target) return more;
  }
  return null;
}

/** How a replay of many drafts adds up, for the page's headline and its record. */
export function summarize(rows: readonly Replayed[]) {
  const passing = rows.flatMap((row) => row.findings.filter((f) => f.pass));
  const findingsAgreed = passing.filter((f) => f.you === "posted").length;
  const findingsAgainst = passing.filter((f) => f.you === "dropped").length;
  const approved = rows.filter((row) => row.approves);
  const approvalsAgreed = approved.filter((row) => row.draft.you === "approved").length;
  const approvalsAgainst = approved.filter((row) => ["commented", "changes", "discarded", "mistake"].includes(row.draft.you)).length;
  return {
    posts: rows.filter((row) => row.posts).length,
    acts: rows.filter((row) => row.acts).length,
    actsAgreed: rows.filter((row) => row.acts && row.draft.you === "approved").length,
    actsPending: rows.filter((row) => row.acts && row.draft.you === "pending").length,
    passing: passing.length, findingsAgreed, findingsAgainst, approvalsAgreed, approvalsAgainst,
  };
}
