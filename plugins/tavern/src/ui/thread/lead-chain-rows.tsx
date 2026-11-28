import type { BoardQuestSummary } from "../../shared/contract";
import { Glyph, plural } from "../kit";
import { SideQuestLine, SideQuestParentLink } from "../kit/side-quest";

const authorityNames: Record<string, string> = {
  "cluster-write": "Cluster writes", production: "Production changes", merge: "Merges",
  credential: "Credentials", "sends-as-you": "Sending as you", destructive: "Deleting outside quest work or changing your tools",
};

export function LeadChainRows({ chain, map, showParent = true }: { chain: BoardQuestSummary["leadChain"]; map?: BoardQuestSummary["waypoints"]; showParent?: boolean }) {
  if (!chain) return null;
  const { seat, children } = chain;
  const mapped = new Set(map?.flatMap(w => w.sideQuest ? [w.sideQuest.linkId] : []));
  const current = children.filter(side => side.current && !mapped.has(side.linkId));
  const history = children.filter(side => !side.current);
  if (!seat && !current.length && !history.length) return null;
  const acts = (lane: "user" | "keeper") => seat?.authority.filter(row => row.lane === lane)
    .map(row => authorityNames[row.kind] ?? row.kind.replaceAll("-", " ")).join(", ") || "Nothing waiting";
  const rows = (sides: typeof children) => <ul className="lg-rows">{sides.map(side => <li key={side.linkId}>
    <SideQuestLine side={side} /><p className="lg-chain-detail">{side.waypointTitle}</p>
  </li>)}</ul>;
  return <section className="lg-chain" aria-label="Side quests">
    {seat && <>
      {showParent && <SideQuestParentLink parent={seat} />}
      <dl className="sendbox">
        <dt>Approved limits</dt><dd>{plural(seat.limits.members, "member")}, {plural(seat.limits.rangers, "Ranger")}</dd>
        <dt>Side Keeper decides</dt><dd>{acts("keeper")}</dd>
        <dt>Hiring Keeper decides</dt><dd>{seat.parentDecisions.join(", ") || "Nothing waiting"}</dd>
        <dt>You decide</dt><dd>{acts("user")}</dd>
      </dl>
    </>}
    {current.length > 0 && rows(current)}
    {history.length > 0 && <details className="lg-fold"><summary><Glyph name="chevron" size={12} /><span>Side quest history · {history.length}</span></summary>{rows(history)}</details>}
  </section>;
}
