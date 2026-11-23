import { Markdown, experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { useId, useState } from "react";
import { rpcContract } from "../contract";

/** The composer's summary of one compaction, clamped until the person asks for all of it. */
export function PressSummary({ threadId, compactionId, label }: { threadId: string; compactionId: string; label: string }) {
  const { data, error, refetch } = experimental_useRpcQuery({ contract: rpcContract, method: "summary", input: { threadId, compactionId } });
  const [all, setAll] = useState(false);
  const id = useId();
  if (error && data === undefined) {
    return <p className="pp-summary-note" role="alert">Could not load the summary. <button type="button" className="pp-link" onClick={() => void refetch()}>Retry</button></p>;
  }
  if (data === undefined) return <p className="pp-summary-note" role="status">Loading summary…</p>;
  if (data.markdown === null) return <p className="pp-summary-note">No summary was kept for this compaction.</p>;
  return <>
    <div id={id} className={`pp-summary${all ? "" : " is-clamped"}`} data-content tabIndex={0} role="region" aria-label={label}>
      <Markdown content={data.markdown} />
    </div>
    <div className="pp-summary-tools">
      <button type="button" className="pp-quiet" aria-controls={id} aria-expanded={all} onClick={() => setAll(!all)}>{all ? "Show less" : "Show all"}</button>
    </div>
  </>;
}
