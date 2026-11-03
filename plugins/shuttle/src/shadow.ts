// Auto post's shadow record: what the gate would have posted, set against what the user did with the same drafts.
import type { AutoPostInsights, Finding, ShadowLabel } from "./contract";
import type { Ctx } from "./ctx";
import type { DraftRow } from "./db/store";
import type { FindingOutcome } from "./drafts";
import { NO_FINDING_PASSED, parseGate } from "./gate";
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
    .replace(/^(the reviewer raised a concern):.*$/u, "$1")
    .replace(/^(the summary):.*$/u, "$1 is not safe to post")
    .replace(/^could not read .+ at the head$/u, "could not read a file at the head")
    .replace(/^it changes .+, a path held for you$/u, "it changes a path held for you")
    .replace(/^.+ is a path held for you$/u, "the finding is in a path held for you")
    .replace(/^".*" is not a path inside the repository$/u, "a path is not inside the repository")
    .replace(/ \([^)]*\)$/u, "")
    .replace(/^could not read the PR's files: .*$/u, "could not read the PR's files")
    .replace(/\d+(\.\d+)?/gu, "N");
}

export function autoPostInsights(ctx: Ctx, range: AutoPostInsights["range"]): AutoPostInsights {
  const config = ctx.config().autoPost;
  const from = ctx.now() - RANGE_DAYS[range] * DAY;
  const repos = config.repos.map((repo) => ({
    repo: repo.repo, mode: repo.mode, drafts: 0, wouldPost: 0, agreed: 0, edited: 0, against: 0, pending: 0, missed: 0, held: 0,
    precision: null as number | null, lowerBound: null as number | null, needed: null as number | null,
    approvals: { drafts: 0, posted: 0, discarded: 0 },
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

  // A range covers drafts checked in it, which may be older drafts checked again.
  for (const draft of ctx.store.gatedDrafts()) {
    const pr = ctx.store.prById(draft.pr_id);
    if (!pr) continue;
    const gate = parseGate(draft.gate);
    if (gate === null || gate.at < from) continue;
    // Holds of the whole draft, not the note that no finding passed.
    const draftHeld = gate.reasons.some((reason) => reason !== NO_FINDING_PASSED);
    const findings = JSON.parse(draft.findings) as Finding[];
    const severity = new Map(findings.map((f) => [f.id, f.severity]));
    const decided = decisionsOf(draft);
    const index = config.repos.findIndex((repo) => globMatch(repo.repo, pr.repo));
    const row = index >= 0 ? repos[index]! : null;
    durations.push(gate.ms);
    for (const reason of gate.reasons) count("draft", reason);
    let agreed = 0;
    let against = 0;
    for (const finding of gate.findings) {
      const verdict = decided.get(finding.id) ?? "pending";
      const posted = verdict === "kept" || verdict === "edited";
      const would = gate.posting.includes(finding.id);
      for (const check of finding.checks) if (!check.ok) count(check.check, check.reason.startsWith("verifier failed") ? "verifier failed" : check.reason);
      if (finding.holds !== null || finding.checks.some((c) => c.reason.startsWith("verifier failed"))) runs++;
      if (finding.checks.some((c) => c.reason.startsWith("verifier failed"))) failures++;
      let label: ShadowLabel | null = null;
      if (would) {
        if (posted) label = "agreed";
        else if (verdict === "dropped") label = "against";
        else if (verdict === "pending") label = "pending";
      } else if (posted && !draftHeld && RANK[severity.get(finding.id) ?? "nit"] >= RANK[config.minSeverity]) label = "missed";
      else if (verdict === "dropped") label = "held";
      if (row && label) {
        if (label === "agreed") { row.agreed++; if (verdict === "edited") row.edited++; }
        else if (label === "against") row.against++;
        else if (label === "pending") row.pending++;
        else if (label === "missed") row.missed++;
        else row.held++;
      }
      if (label === "agreed") agreed++;
      if (label === "against") against++;
      if (finding.holds !== null && finding.worth !== null && label) points.push({ holds: finding.holds, worth: finding.worth, label });
    }
    if (row) {
      row.drafts++;
      if (gate.decision === "post") row.wouldPost++;
      if (draft.verdict === "approve") {
        row.approvals.drafts++;
        if (draft.state === "posted") row.approvals.posted++;
        if (draft.state === "discarded" && draft.discard_reason === "user") row.approvals.discarded++;
      }
    }
    const outcome = draft.state === "posted" ? "posted" : draft.state === "draft" ? "pending" : draft.discard_reason === "user" ? "discarded" : "superseded";
    const failed = gate.findings.flatMap((f) => f.checks.filter((c) => !c.ok)).map((c) => c.reason);
    recent.push({
      draftId: draft.id, key: pr.key, display: shortKey(ctx, pr), title: pr.title, at: gate.at, verdict: draft.verdict,
      decision: gate.decision, findings: findings.length, posting: gate.posting.length, outcome, agreed, against,
      reason: gate.decision === "post" ? null : (gate.reasons[0] ?? failed[0] ?? null),
    });
  }

  for (const row of repos) {
    const decided = row.agreed + row.against;
    row.precision = decided ? row.agreed / decided : null;
    row.lowerBound = wilsonLower(row.agreed, decided);
    row.needed = neededFor(row.agreed, row.against, config.targetPrecision);
  }
  durations.sort((a, b) => a - b);
  return {
    range,
    target: config.targetPrecision,
    repos,
    reasons: [...reasons.values()].sort((a, b) => b.count - a.count).slice(0, 12),
    points,
    verifier: { runs, failures, medianMs: durations.length ? durations[Math.floor(durations.length / 2)]! : null },
    recent: recent.reverse().slice(0, 50),
  };
}
