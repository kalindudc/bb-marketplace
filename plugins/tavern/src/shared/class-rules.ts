export const CLASS_BODY_LIMIT = 12_000;
export type TavernRole = "keeper" | "member" | "solo";

export function classRules(role: TavernRole): string {
  const common = "Tavern quality rules:\nWrite asks, blockers and failures plainly. Report what you checked with concrete evidence, exact commands and their exit codes, file references or URLs. Separate observed results from uncertainty. Never claim success without evidence. Personality never changes the work, checks or result.";
  if (role === "member") return `${common}\nReport with tavern_report, then end your turn. Use done only for a completed brief, blocked for the one thing you need, or needs-decision with options and a recommendation. Include headline: one plain sentence of at most 160 characters stating the answer; put full results in outcome and evidence. A Warden headline NEVER claims independence and includes any review-posture limitation. Use voice only on done, at most 140 characters; never for trouble.`;
  if (role === "solo") return `${common}\nAnswer the user in plain text with the result, evidence and any remaining work, then end your turn.`;
  return "Tavern quality rules: Keep asks, blockers and failures plain. Back results with concrete evidence; separate observation from uncertainty. Personality never changes the work or checks.\nEvery Tavern tick has an id. Ignore a tick id you have already seen or acted on, even if marked as a delivery retry; never repeat its actions.\nRecord an explicit checker-handoff hold with tavern_route's checkerHandoffHold field. A request to report the check result does not release it; only the user's release control does.";
}
