import { useId } from "react";
import type { WardenQuality } from "../../shared/insights";
import { plural } from "../kit";

const readTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

export function WardenQualitySection({ data, settings = false }: { data: WardenQuality; settings?: boolean }) {
  const id = useId();
  const to = new Date(data.to);
  const Heading = settings ? "h4" : "h2";
  return <section className={settings ? "tv-warden-quality" : "tv-card tv-isec tv-warden-quality"} aria-labelledby={id}>
    <header className="tv-isec-h"><Heading id={id}>Warden quality</Heading></header>
    <p className="tv-isec-cap">{settings && "Last 30 days. "}Read on <time dateTime={to.toISOString()}>{readTime.format(to)}</time>.</p>
    <p className="tv-isec-cap">Only verifications moved back to to-do count. New briefs are excluded. A reopen does not mean the check was wrong.</p>
    {data.rows.length ? <ul className="tv-warden-models">
      {data.rows.map(row => <li key={JSON.stringify([row.classId, row.providerId, row.model])}>
        <strong>{row.classId === "warden" && !settings && "Warden: "}{row.model ?? "Model not recorded"}{row.providerId && ` (${row.providerId})`}</strong>
        <span>{row.reopened} of {plural(row.verified, "verification")} reopened{row.verified >= 5 && ` (${Math.round(100 * row.reopened / row.verified)}%)`}</span>
        <span>{plural(row.rejected, "recorded rejection")}</span>
        {row.verified < 5 && <span className="tv-isec-cap">Too few to judge.</span>}
      </li>)}
    </ul> : <p className="tv-empty" data-empty>No recorded Warden verdicts in this range.</p>}
    {!settings && <p className="tv-isec-cap">{plural(data.rejectedWaypointsWaived, "rejected waypoint")} you waived when closing early.</p>}
  </section>;
}
