export const CLASS_BODY_LIMIT = 12_000;
export type TavernRole = "keeper" | "member" | "solo";

/** The standing commit standard for every class whose work touches files, not just Smiths. */
export const COMMIT_STANDARD = "Commit before you end a turn: when your work changes files, keep it on a branch and commit it before your turn ends, one or many appropriate commits, each saying what changed. An uncommitted turn-end is a defect.";
export function classRules(role: TavernRole): string {
  const common = "Tavern quality rules:\nWrite asks, blockers and failures plainly. Report what you checked with concrete evidence, exact commands and their exit codes, file references or URLs. Separate observed results from uncertainty. Never claim success without evidence. Use plain language throughout.";
  if (role === "member") return `${common}\nReport with tavern_report, then end your turn. Use done only for a completed brief, blocked for the one thing you need, or needs-decision with options and a recommendation. Include headline: one short sentence stating the answer; put full results in outcome and evidence. A Warden headline NEVER claims independence and includes any review-posture limitation.\n${COMMIT_STANDARD}`;
  if (role === "solo") return `${common}\nAnswer the user in plain text with the result, evidence and any remaining work, then end your turn.\n${COMMIT_STANDARD}`;
  return "Tavern quality rules: Write plainly. Back results with concrete evidence; separate observation from uncertainty.\nEvery Tavern tick has an id. Ignore a tick id you have already seen or acted on, even if marked as a delivery retry; never repeat its actions.\nRecord an explicit checker-handoff hold with tavern_route's checkerHandoffHold field. A request to report the check result does not release it; only the user's release control does.";
}
