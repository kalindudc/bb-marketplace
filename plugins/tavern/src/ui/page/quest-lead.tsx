import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect, useMemo, useState } from "react";
import type { BoardQuestDetail } from "../../shared/contract";
import type { Report } from "../../shared/schema";
import { Clamp, FigureRow, OpensMark, memberReportNames, questNames, readable, taleFigures } from "../kit";
import type { Registry } from "./common";
import { stoppedStory, taleHeadline } from "./model";

function useNarrow(query: string) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return narrow;
}


export function QuestLead({ detail, registry }: { detail: BoardQuestDetail; registry: Registry }) {
  const navigate = useBbNavigate();
  const quest = detail.quest;
  const returned = quest.phase === "done";
  const names = useMemo(() => questNames(quest, registry, detail.reports), [quest, registry, detail.reports]);
  const story = stoppedStory(detail, { name: id => names.threadNames?.get(id) ?? null, headline: (report: Report) => {
    const member = quest.members.find(m => m.threadId === report.memberThreadId);
    return taleHeadline(report, member ? memberReportNames(detail, member, registry) : names);
  } });
  const phone = useNarrow("(max-width: 560px)");
  return <section className="tv-card tv-rec-story" aria-labelledby="tv-rec-story-h">
    <header className="tv-colh"><h2 id="tv-rec-story-h">What happened</h2></header>
    {returned ? detail.tale
      ? <div className="tv-rec-prose"><Clamp text={readable(detail.tale.outcome, names)} lines={3} className="tv-outcome" /><button type="button" className="lnk-btn act tv-rec-tale" onClick={() => navigate.toPluginPanel("tavern", { subPath: `tale/${quest.id}` })}><span>The tale</span><OpensMark /></button></div>
      : <p className="tv-rec-prose m">The Keeper wrote no tale for this quest.</p>
      : <ul className="tv-rec-lines">{story.map((line, i) => <li key={i} data-content>{line}</li>)}</ul>}
    <FigureRow figures={taleFigures(detail)} compact={phone} />
  </section>;
}
