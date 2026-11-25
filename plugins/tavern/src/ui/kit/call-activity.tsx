import { useState } from "react";
import { experimental_useRpcMutation } from "@get-bb/plugin-sdk/app";
import { rpcContract, type BoardQuestDetail } from "../../shared/contract";
import { QueryState } from "./skeleton";
import { MODE_WORDS } from "./guard";

type Activity = NonNullable<NonNullable<BoardQuestDetail["scopes"]>[number]["callActivity"]>;
const words = {
  ordinary: "Observed", "inspection-unavailable": "Inspection unavailable", "act-allowed": "Act allowed",
  prevented: "Not dispatched", "detected-after-dispatch": "Detected after dispatch", "stop-failed": "Stop failed",
} as const;

export function CallActivity({ threadId, activity }: { threadId: string; activity?: Activity }) {
  const fetchPage = experimental_useRpcMutation({ contract: rpcContract, method: "scopeCallPage" });
  const [page, setPage] = useState<(Pick<Activity, "recent" | "next"> & { threadId: string }) | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (!activity?.count) return null;
  const older = page?.threadId === threadId ? page : null;
  const shown = older ?? activity;
  return <details>
    <summary>{activity.count} observed {activity.count === 1 ? "call" : "calls"}{activity.unavailable > 0 && ` · ${activity.unavailable} not inspected`}</summary>
    <p className="m">Observations do not say whether a call succeeded or what it changed.</p>
    <ol>{shown.recent.map(call => <li key={`${call.providerId}:${call.eventId}`}>
      <code>{call.tool}</code> · {words[call.outcome]} · {MODE_WORDS[call.mode]}
    </li>)}</ol>
    {older && <button type="button" className="btn sm" disabled={fetchPage.isPending} onClick={() => { setPage(null); setError(null); }}>Latest calls</button>}
    {shown.next !== null && <button type="button" className="btn sm" disabled={fetchPage.isPending} onClick={() => {
      setError(null);
      void fetchPage.mutate({ threadId, before: shown.next! }).then(result => setPage({ ...result, threadId }), setError);
    }}>Older calls</button>}
    <QueryState error={error} />
  </details>;
}
