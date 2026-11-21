import type { BoardQuestSummary } from "../../shared/contract";
import { OpensMark, phaseWord, plural } from "../kit";

const authorityNames: Record<string, string> = {
  "cluster-write": "Cluster writes", production: "Production changes", merge: "Merges",
  credential: "Credentials", "sends-as-you": "Sending as you", destructive: "Deleting outside quest work or changing your tools",
};
const stateWords = { reserved: "Lead reserved", linked: "Lead linked", "retirement-requested": "Retirement requested",
  retiring: "Lead cleanup pending", retired: "Lead retired", cancelled: "Hire cancelled", stopped: "Lead stopped" };

export function LeadChainRows({ chain, onOpenQuest }: { chain: BoardQuestSummary["leadChain"]; onOpenQuest: (id: string) => void }) {
  if (!chain || !chain.seat && !chain.children.length && !chain.asks.length) return null;
  const { seat, children, asks } = chain;
  const acts = (lane: "user" | "keeper") => seat?.authority.filter(row => row.lane === lane)
    .map(row => authorityNames[row.kind] ?? row.kind.replaceAll("-", " ")).join(", ") || "Nothing waiting";
  return <section className="lg-chain" aria-label="Keeper chain">
    {seat && <>
      <button className="lg-row act" type="button" onClick={() => onOpenQuest(seat.parentQuestId)}><span>Parent quest: <b>{seat.parentTitle}</b></span><OpensMark /></button>
      <dl className="sendbox">
        <dt>Approved limits</dt><dd>{plural(seat.limits.members, "member")}, {plural(seat.limits.rangers, "Ranger")}, {plural(seat.limits.depth, "layer")}</dd>
        <dt>Lead decides</dt><dd>{acts("keeper")}</dd>
        <dt>Hiring Keeper decides</dt><dd>{seat.parentDecisions.join(", ") || "Nothing waiting"}</dd>
        <dt>You decide</dt><dd>{acts("user")}</dd>
      </dl>
    </>}
    {children.length > 0 && <ul className="lg-rows" aria-label="Linked child quests">{children.map(child => <li key={child.linkId}>
      {child.quest ? <button className="lg-row act" type="button" onClick={() => onOpenQuest(child.quest!.id)}>
        <span><b>{child.quest.title}</b><br />{child.leadName}, {child.quest.phase === "closing" ? "Waiting for conclusion" : phaseWord(child.quest.phase)}, {plural(child.quest.party, "party seat")}</span><span><OpensMark /></span>
      </button> : <div className="lg-row">{child.leadName}: waiting for a quest</div>}
      <p className="lg-chain-detail">{child.waypointTitle}{child.checkState ? ` · ${child.checkState.replaceAll("-", " ")}` : ""} · {stateWords[child.state]}</p>
      {child.error && <p className="lg-chain-detail">{child.error}</p>}
    </li>)}</ul>}
    {asks.length > 0 && <ul className="lg-rows" aria-label="Read-only child asks">{asks.map(ask => <li key={ask.id}>
      <div className="lg-row"><span>{ask.title} <span className="m">(read-only)</span></span></div>
    </li>)}</ul>}
  </section>;
}
