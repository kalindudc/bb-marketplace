import { waiverLine, type WaypointWaiver } from "../../shared/closing";

export function WaiverRows({ items, final = false }: { items: readonly Pick<WaypointWaiver, "waypointId" | "title" | "state" | "reason">[]; final?: boolean }) {
  if (!items.length) return null;
  const commonReason = !final && items.every(w => w.reason === items[0]!.reason) ? items[0]!.reason : null;
  return <>
    {commonReason && <p className="m" data-content>Reason for closing early: {commonReason}</p>}
    <ul className="waiver-rows" aria-label={final ? "Waived waypoints" : "Waivers if you close early"}>
      {items.map(w => <li key={w.waypointId}>
        <b data-content>{w.title}</b>
        <span>{waiverLine(w)}{final && "; closed early at your request"}</span>
        {!commonReason && <span className="m" data-content>{w.reason}</span>}
      </li>)}
    </ul>
  </>;
}
