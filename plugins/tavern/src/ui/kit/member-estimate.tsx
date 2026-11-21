import type { Report } from "../../shared/schema";

export function MemberEstimate({ confidence }: { confidence: Report["confidence"] }) {
  if (!confidence) return null;
  return <span className="member-estimate" role="group" aria-label="Member’s own estimate">
    <b>Member’s own estimate</b><span>matches intent {confidence.intent}% · safe to ship {confidence.safe}%</span>
  </span>;
}
