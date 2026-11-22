import { useState } from "react";
import { experimental_useRpcMutation, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Attention } from "../../shared/attention";
import { rpcContract } from "../../shared/contract";
import { OpensMark, QueryState } from "../kit";
import { summaryPath } from "../kit/summary-card";

export function NewSummaries({ attention }: { attention: Attention }) {
  const navigate = useBbNavigate();
  const markSummary = experimental_useRpcMutation({ contract: rpcContract, method: "markSummariesSeen" });
  const [error, setError] = useState<unknown>(null);
  const summaries = attention.items.filter(item => item.kind === "summary" && item.questId).reverse();
  const total = attention.summaries ?? summaries.length;
  return <>
    {summaries.length > 0 && <ul className="lg-rows lg-summary-rows" aria-label="New summaries">{summaries.map(({ id, questId, title }) => <li key={id}>
      <span data-content>{title}</span>
      <button type="button" className="lnk-btn act" onClick={() => navigate.toPluginPanel("tavern", { subPath: summaryPath(questId!, id) })}>Open<OpensMark /></button>
      <button type="button" className="btn sm" aria-label={`OK: ${title}`} disabled={markSummary.isPending} onClick={() => void markSummary.mutate({ boardQuestId: questId!, ids: [id] }).catch(setError)}>OK</button>
    </li>)}</ul>}
    {total > summaries.length && <p className="m small">Showing the newest {summaries.length} of {total} summaries.</p>}
    <QueryState error={error} />
  </>;
}
