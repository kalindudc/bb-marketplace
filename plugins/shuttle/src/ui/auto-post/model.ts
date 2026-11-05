// What the Auto post page shows of a replay: a draft's holds on one tab, its group, the name of each hold, and the rows of
// settings that hold drafts with what each would let through. Pure, so the page recomputes it on every change.
import type { ConcernKind } from "../../config";
import type { ReplayDraft } from "../../contract";
import { holdKey, type FindingHold, type Hold, type Replayed, type ReplaySettings } from "../../replay";

export type Tab = "comment" | "approve";
export type Group = "post" | "settings" | "other";

export const KIND_NAME: Record<ConcernKind, string> = {
  other: "Other concerns", unverified: "Couldn't verify", process: "CI or merge state", design: "Design point", description: "Description mismatch", scope: "Out-of-scope changes",
};
export const KIND_TIP: Partial<Record<ConcernKind, string>> = { other: "Concerns of kind other, and every concern from reviews written before concerns had kinds." };

type FixedKind = Exclude<Hold["k"], "concern" | "kept" | "size" | "severity-above">;
const FIXED_NAME: Record<FixedKind, string> = {
  "no-size": "Size unknown", "checks-none": "No checks reported", "checks-running": "Checks still running", findings: "No finding passes", "findings-fixed": "No finding can pass",
  "route-approve": "Suggested approving", "route-changes": "Asked for changes", "route-comment": "Suggested commenting", bot: "Bot author",
  "no-risk": "No risk rating", "high-risk": "High risk", "not-low-risk": "Not low risk", "checks-failed": "Checks failed", "review-changes": "Changes requested",
  timing: "PR moved during check", "no-findings": "No findings",
};
const FIXED_TIP: Partial<Record<Hold["k"], string>> = {
  "route-approve": "An approve draft's comments only post with its approval.",
  "route-comment": "Shuttle only approves from drafts that suggested approving.",
  "checks-none": "The checks rule asks for passing checks; this PR reported none.",
  "checks-running": "The checks rule asks for passing checks; this PR's were still running.",
  findings: "Some finding would pass with other verifier floors or a lower minimum severity: tune them in Findings and the verifier.",
  "findings-fixed": "Every finding fails on something no setting here changes: a nit, missing critic votes or quotes, not on a line, or not scored yet.",
  kept: "Something the check found that no setting here changes.",
};

export const FINDING_HOLD_NAME: Record<Exclude<FindingHold["k"], "other">, string> = {
  nit: "Nit", severity: "Below lowest severity", "no-line": "Not on a line", unjudged: "Not scored yet", "v-holds": "Not sure it's right", "v-worth": "Not worth posting",
};
export const findingHoldName = (hold: FindingHold) => (hold.k === "other" ? hold.text : FINDING_HOLD_NAME[hold.k]);

export const YOU_TEXT: Record<ReplayDraft["you"], string> = {
  approved: "approved", commented: "commented", changes: "requested changes", discarded: "discarded", replaced: "replaced", pending: "not yet",
  mistake: "marked Shuttle's approval a mistake", shuttle: "Shuttle commented", posted: "posted",
};
export const VERDICT_TEXT: Record<ReplayDraft["verdict"], string> = { approve: "Approve", comment: "Comment", changes: "Changes" };
export const VERDICT_TIP: Record<ReplayDraft["verdict"], string> = {
  approve: "The review suggested approving", comment: "The review suggested commenting", changes: "The review asked for changes",
};

/** A draft's holds on a tab. Shuttle only approves from approve drafts, so on Approvals a comment draft is also held by its verdict. */
export function holdsOf(row: Replayed, tab: Tab): Hold[] {
  if (tab === "comment") return row.comment;
  return row.draft.verdict === "comment" ? [...row.approval, { k: "route-comment" }] : row.approval;
}

export const passes = (row: Replayed, tab: Tab) => (tab === "comment" ? row.posts : row.acts);

const SETTING_KINDS: ReadonlySet<Hold["k"]> = new Set(["concern", "size", "checks-none", "checks-running", "severity-above", "findings"]);
/** A hold one of the page's settings decides. */
export const isSetting = (hold: Hold) => SETTING_KINDS.has(hold.k);

/** The setting row a hold belongs to: both checks holds answer to the checks rule. */
export const settingOf = (hold: Hold) => (hold.k === "checks-none" || hold.k === "checks-running" ? "checks" : holdKey(hold));

export function groupOf(row: Replayed, tab: Tab): Group {
  if (passes(row, tab)) return "post";
  return holdsOf(row, tab).every(isSetting) ? "settings" : "other";
}

/** The hold a row leads with: one no setting changes when there is one, since it decides the row's group; else the first. */
export const mainHold = (holds: readonly Hold[]): Hold | null => holds.find((hold) => !isSetting(hold)) ?? holds[0] ?? null;

export function holdName(hold: Hold, s: ReplaySettings, tab: Tab): string {
  switch (hold.k) {
    case "concern": return KIND_NAME[hold.kind];
    case "kept": return hold.text;
    case "size": return `Over ${(tab === "comment" ? s.maxLines : s.apprMaxLines).toLocaleString()} lines`;
    case "severity-above": return `Finding above ${s.apprSeverity}`;
    default: return FIXED_NAME[hold.k];
  }
}

export const holdTip = (hold: Hold): string | undefined => (hold.k === "concern" ? KIND_TIP[hold.kind] : FIXED_TIP[hold.k]);

/** Drafts held by each setting row, and drafts it alone holds: what would go through if only it changed. */
export function settingCounts(rows: readonly Replayed[], tab: Tab) {
  const held = new Map<string, number>();
  const only = new Map<string, number>();
  for (const row of rows) {
    const holds = holdsOf(row, tab);
    for (const key of new Set(holds.map(settingOf))) held.set(key, (held.get(key) ?? 0) + 1);
    if (holds.length === 1) only.set(settingOf(holds[0]!), (only.get(settingOf(holds[0]!)) ?? 0) + 1);
  }
  return { held, only };
}

/** Each concern kind in the drafts with how many carry it, most common first: the switches to show. */
export function kindsPresent(drafts: readonly ReplayDraft[]): Array<{ kind: ConcernKind; drafts: number }> {
  const counts = new Map<ConcernKind, number>();
  for (const draft of drafts) for (const kind of new Set(draft.concerns)) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts].map(([kind, n]) => ({ kind, drafts: n })).sort((a, b) => b.drafts - a.drafts);
}

/** Holds no setting changes, with how many drafts each holds, most common first; `kept` holds are counted by their text. */
export function fixedCounts(rows: readonly Replayed[], tab: Tab): Array<{ hold: Hold; drafts: number }> {
  const seen = new Map<string, { hold: Hold; drafts: number }>();
  for (const row of rows) {
    for (const hold of holdsOf(row, tab)) {
      if (isSetting(hold)) continue;
      const key = holdKey(hold);
      const entry = seen.get(key) ?? { hold, drafts: 0 };
      entry.drafts += 1;
      seen.set(key, entry);
    }
  }
  return [...seen.values()].sort((a, b) => b.drafts - a.drafts);
}

/** Why each held finding failed first, most common first: the chips under the scatter. */
export function findingReasons(rows: readonly Replayed[]): Array<{ name: string; findings: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) for (const finding of row.findings) {
    if (finding.pass || finding.why.length === 0) continue;
    const name = findingHoldName(finding.why[0]!);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, n]) => ({ name, findings: n })).sort((a, b) => b.findings - a.findings);
}
