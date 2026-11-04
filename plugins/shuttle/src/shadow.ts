// Auto post's shadow record: what the gate would have posted, set against what the user did with the same drafts.
import type { AutoPostInsights, Finding, ShadowLabel } from "./contract";
import type { Ctx } from "./ctx";
import type { DraftRow } from "./db/store";
import type { FindingOutcome } from "./drafts";
import { APPROVAL_ROUTE, ASKS_CHANGES, CHANGES_ROUTE, NO_FINDING_PASSED, parseGate, unreadable } from "./gate";
import { shortKey } from "./prs";
import { globMatch } from "./sync";

const DAY = 86_400_000;
const RANGE_DAYS = { "7d": 7, "30d": 30, "90d": 90 } as const;
const RANK = { nit: 0, low: 1, medium: 2, high: 3 } as const;

/** The 95% Wilson lower bound of k successes in n tries; null without tries. */
export function wilsonLower(k: number, n: number, z = 1.96): number | null {
  if (n === 0) return null;
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (centre - spread) / denominator;
}

/** Agreeing findings in a row the record still needs for its lower bound to reach the target; null past 1000. */
export function neededFor(agreed: number, against: number, target: number): number | null {
  for (let more = 0; more <= 1000; more++) {
    const lower = wilsonLower(agreed + more, agreed + against + more);
    if (lower !== null && lower >= target) return more;
  }
  return null;
}

type Decided = "kept" | "edited" | "dropped" | "pending" | "superseded";

/** What the user did with each finding: from what they posted, from their discard, or not yet. */
export function decisionsOf(draft: DraftRow): Map<string, Decided> {
  const findings = JSON.parse(draft.findings) as Finding[];
  const out = new Map<string, Decided>();
  if (draft.state === "posted" && draft.outcome) {
    for (const row of JSON.parse(draft.outcome) as FindingOutcome[]) out.set(row.id, row.outcome);
  }
  for (const finding of findings) {
    if (out.has(finding.id)) continue;
    if (draft.state === "discarded") out.set(finding.id, draft.discard_reason === "user" ? "dropped" : "superseded");
    // A draft posted without a record of its findings, such as from another device's older Shuttle, says nothing per finding.
    else out.set(finding.id, draft.state === "posted" ? "superseded" : "pending");
  }
  return out;
}

/**
 * The shape of a reason, so the same cause counts once: numbers become N, and the free text after a concern, a path or
 * a list of places is dropped.
 */
export function bucket(reason: string): string {
  return reason
    .replace(/^(the reviewer raised a concern about [^:]+):.*$/u, "$1")
    .replace(/^(the reviewer raised a concern):.*$/u, "$1")
    .replace(/^(the summary):.*$/u, "$1 is not safe to post")
    .replace(/^could not read .+ at the head$/u, "could not read a file at the head")
    .replace(/^it changes .+, a path held for you$/u, "it changes a path held for you")
    .replace(/^.+ is a path held for you$/u, "the finding is in a path held for you")
    .replace(/^".*" is not a path inside the repository$/u, "a path is not inside the repository")
    .replace(/ \([^)]*\)$/u, "")
    .replace(/^could not read the PR's files: .*$/u, "could not read the PR's files")
    .replace(/\d+(\.\d+)?/gu, "N")
    .replace(/\bN finding\b/gu, "N findings");
}

type Tally = { agreed: number; against: number; pending: number; missed: number; held: number };
const tally = (): Tally => ({ agreed: 0, against: 0, pending: 0, missed: 0, held: 0 });

/** Where a shadow decision lands against the user's: `would` is what auto post would do, `took` what the user did. */
function labelOf(would: boolean, took: "yes" | "no" | "pending" | null): ShadowLabel | null {
  if (took === null) return null;
  if (would) return took === "yes" ? "agreed" : took === "no" ? "against" : "pending";
  return took === "yes" ? "missed" : took === "no" ? "held" : null;
}

function finish<T extends Tally>(row: T, target: number): T & { precision: number | null; lowerBound: number | null; needed: number | null } {
  const decided = row.agreed + row.against;
  return { ...row, precision: decided ? row.agreed / decided : null, lowerBound: wilsonLower(row.agreed, decided), needed: neededFor(row.agreed, row.against, target) };
}

export function autoPostInsights(ctx: Ctx, range: AutoPostInsights["range"]): AutoPostInsights {
  const config = ctx.config().autoPost;
  const from = ctx.now() - RANGE_DAYS[range] * DAY;
  const repos = config.repos.map((repo) => ({
    repo: repo.repo, mode: repo.mode, drafts: 0,
    findings: { ...tally(), edited: 0, judged: 0 },
    policy: { drafts: 0, findings: 0, agreed: 0, against: 0 },
    approvals: { ...tally(), drafts: 0, wouldApprove: 0 },
  }));
  const reasons = new Map<string, { check: string; reason: string; count: number }>();
  const count = (check: string, reason: string) => {
    const shape = bucket(reason);
    const row = reasons.get(`${check}:${shape}`) ?? { check, reason: shape, count: 0 };
    row.count++;
    reasons.set(`${check}:${shape}`, row);
  };
  const points: AutoPostInsights["points"] = [];
  const recent: AutoPostInsights["recent"] = [];
  let runs = 0;
  let failures = 0;
  const durations: number[] = [];

  for (const draft of ctx.store.gatedDrafts()) {
    const pr = ctx.store.prById(draft.pr_id);
    if (!pr) continue;
    const gate = parseGate(draft.gate);
    if (gate === null || gate.at < from) continue;
    const findings = JSON.parse(draft.findings) as Finding[];
    const severity = new Map(findings.map((f) => [f.id, f.severity]));
    const decided = decisionsOf(draft);
    const index = config.repos.findIndex((repo) => globMatch(repo.repo, pr.repo));
    const row = index >= 0 ? repos[index]! : null;
    durations.push(gate.ms);
    for (const reason of gate.reasons) if (reason !== NO_FINDING_PASSED && reason !== APPROVAL_ROUTE && reason !== CHANGES_ROUTE) count("draft", reason);
    for (const reason of gate.approval?.reasons ?? []) if (reason !== ASKS_CHANGES) count("approval", reason);
    let agreed = 0;
    let against = 0;
    for (const finding of gate.findings) {
      const verdict = decided.get(finding.id) ?? "pending";
      const failedVerifier = finding.checks.some((c) => c.reason.startsWith("verifier failed"));
      for (const check of finding.checks) if (!check.ok) count(check.check, check.reason.startsWith("verifier failed") ? "verifier failed" : check.reason);
      if (finding.holds !== null || failedVerifier) runs++;
      if (failedVerifier) failures++;
      // Not a judgment: a finding past the verifier's limit, one held only because a file or the verifier could not be read,
      // and a passing one the verifier never scored (from a check before every finding went to it).
      const failedChecks = finding.checks.filter((c) => !c.ok);
      const unread = failedChecks.length > 0 && failedChecks.every((c) => unreadable(c.reason));
      if (finding.unjudged || unread || (finding.pass && finding.holds === null)) continue;
      const took = verdict === "kept" || verdict === "edited" ? "yes" : verdict === "dropped" ? "no" : verdict === "pending" ? "pending" : null;
      // A finding below the minimum severity is not the gate's to post, so posting it is no miss.
      const label = labelOf(finding.pass, finding.pass || RANK[severity.get(finding.id) ?? "nit"] >= RANK[config.minSeverity] || took !== "yes" ? took : null);
      if (row && label) {
        row.findings[label]++;
        if (label === "agreed" && verdict === "edited") row.findings.edited++;
      }
      if (row && finding.holds !== null) row.findings.judged++;
      if (row && gate.posting.includes(finding.id)) {
        if (took === "yes") row.policy.agreed++;
        if (took === "no") row.policy.against++;
      }
      if (label === "agreed") agreed++;
      if (label === "against") against++;
      if (finding.holds !== null && finding.worth !== null && label) points.push({ holds: finding.holds, worth: finding.worth, label });
    }
    if (row) {
      row.drafts++;
      if (gate.decision === "post") {
        row.policy.drafts++;
        row.policy.findings += gate.posting.length;
      }
      if (gate.approval) {
        row.approvals.drafts++;
        const would = gate.approval.decision === "approve";
        if (would) row.approvals.wouldApprove++;
        const took = draft.state === "draft" ? "pending"
          : draft.state === "posted" ? (draft.posted_verdict === null ? null : draft.posted_verdict === "approve" ? "yes" : "no")
          : draft.discard_reason === "user" ? "no" : null;
        const label = labelOf(would, took);
        if (label) row.approvals[label]++;
      }
    }
    const outcome = draft.state === "posted" ? "posted" : draft.state === "draft" ? "pending" : draft.discard_reason === "user" ? "discarded" : "superseded";
    const failed = gate.findings.flatMap((f) => f.checks.filter((c) => !c.ok)).map((c) => c.reason);
    recent.push({
      draftId: draft.id, key: pr.key, display: shortKey(ctx, pr), title: pr.title, at: gate.at, verdict: draft.verdict,
      decision: gate.decision, findings: findings.length, passing: gate.findings.filter((f) => f.pass).length, posting: gate.posting.length,
      approval: gate.approval?.decision ?? null, outcome, posted: draft.state === "posted" ? draft.posted_verdict : null, agreed, against,
      reason: gate.decision === "post" ? null : (gate.reasons[0] ?? failed[0] ?? null),
    });
  }

  durations.sort((a, b) => a - b);
  return {
    range,
    target: config.targetPrecision,
    approvalTarget: config.approvals.target,
    repos: repos.map((row) => ({ ...row, findings: finish(row.findings, config.targetPrecision), approvals: finish(row.approvals, config.approvals.target) })),
    reasons: [...reasons.values()].sort((a, b) => b.count - a.count).slice(0, 14),
    points,
    verifier: { runs, failures, medianMs: durations.length ? durations[Math.floor(durations.length / 2)]! : null },
    recent: recent.reverse().slice(0, 50),
  };
}
