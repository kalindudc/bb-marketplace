import { experimental_useRpcMutation, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useState, useSyncExternalStore } from "react";
import type { SinceVisit as Visit } from "../../shared/attention";
import { rpcContract } from "../../shared/contract";
import { ExpandsMark, OpensMark, phaseWord, plural, TimeAgo } from "../kit";
import { summaryPath } from "../kit/summary-card";
import { Section } from "./common";
import { jumpTo } from "./rail";
import "./since-visit.css";

const narrowVisit = "(max-width: 560px)";
const narrowNow = () => typeof window.matchMedia === "function" && window.matchMedia(narrowVisit).matches;
function subscribeNarrow(notify: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(narrowVisit);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}

export function SinceVisit({ visit, foldOnNarrow = false }: { visit?: Visit; foldOnNarrow?: boolean }) {
  const narrow = useSyncExternalStore(subscribeNarrow, narrowNow, () => false);
  const navigate = useBbNavigate();
  const seen = experimental_useRpcMutation({ contract: rpcContract, method: "markVisitSeen" });
  const [error, setError] = useState<string | null>(null);
  if (!visit || !visit.quests.length && !visit.decided) return null;
  const summaryIds = visit.quests.flatMap(quest => quest.summaries.map(summary => summary.id));
  const changeIds = visit.quests.flatMap(quest => quest.change ? [quest.change.id] : []);
  const mark = async () => {
    setError(null);
    try { await seen.mutate({ summaryIds, changeIds }); }
    catch (problem) { setError(problem instanceof Error ? problem.message : String(problem)); }
  };
  const content = <Section title="Since your last visit" className="tv-card tv-since-visit" action={visit.quests.length > 0
    ? <button type="button" className="btn sm" title="Mark the summaries and quest changes shown here seen" disabled={seen.isPending} onClick={() => void mark()}>Mark all seen</button> : undefined}>
    {visit.quests.length > 0 && <ul className="tv-since-quests">{visit.quests.map(({ id, title, summaries, change }) => <li key={id} className="tv-since-row">
      <div className="tv-since-line"><h3 data-content>{title}</h3>{change?.phaseChange && <div className="m"><span>{phaseWord(change.phaseChange.from)} to {phaseWord(change.phaseChange.to)}</span><TimeAgo at={change.since} /></div>}
        <button type="button" className="lnk-btn act" aria-label={`Open: ${title}`} onClick={() => navigate.toPluginPanel("tavern", { subPath: `quest/${id}` })}>Open<OpensMark /></button>
      </div>
      {summaries.length > 0 && <div className="tv-since-summaries"><span className="m">{plural(summaries.length, "new answer")}</span>
        <ul>{summaries.map(summary => <li key={summary.id}><button type="button" className="lnk-btn act" onClick={() => navigate.toPluginPanel("tavern", { subPath: summaryPath(id, summary.id) })}><span data-content>{summary.title}</span><OpensMark /></button></li>)}</ul></div>}
    </li>)}</ul>}
    {(visit.summaries > summaryIds.length || visit.changedQuests > changeIds.length) && <p className="m">Showing the newest items. More appear as you mark these seen.</p>}
    {visit.decided > 0 && <button type="button" className="lnk-btn act" onClick={() => jumpTo("rm-decided")}>{plural(visit.decided, "call decided for you", "calls decided for you")}<OpensMark /></button>}
    {error && <p className="problem" role="alert">Could not mark this visit seen: {error}</p>}
  </Section>;
  if (!foldOnNarrow || !narrow) return content;
  const counts = [
    visit.summaries > 0 && plural(visit.summaries, "answer"),
    visit.changedQuests > 0 && plural(visit.changedQuests, "quest changed", "quests changed"),
  ].filter(Boolean).join(", ") || plural(visit.decided, "call decided for you", "calls decided for you");
  return <details className="tv-since-fold">
    <summary className="act"><ExpandsMark open={false} /><span>Since your last visit: {counts}</span></summary>
    {content}
  </details>;
}
