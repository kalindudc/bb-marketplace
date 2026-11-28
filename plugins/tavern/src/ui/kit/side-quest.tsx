import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ReactNode } from "react";
import type { SideQuest } from "../../shared/contract";
import { OpensMark } from "./glyphs";
import { phaseWord } from "./phase";

export function SideQuestParentLink({ parent, crest }: { parent: { parentQuestId: string; parentTitle: string }; crest?: ReactNode }) {
  const navigate = useBbNavigate();
  return <button type="button" className="lnk-btn act side-quest-parent" onClick={() => navigate.toPluginPanel("tavern", { subPath: `quest/${parent.parentQuestId}` })}>
    {crest && <span aria-hidden="true">{crest}</span>}<span>Side quest of <b data-content>{parent.parentTitle}</b></span><OpensMark />
  </button>;
}

export function SideQuestLine({ side }: { side: SideQuest }) {
  const navigate = useBbNavigate();
  const quest = side.quest;
  const cleanup = side.state === "retiring" || !!side.error;
  const state = cleanup ? "Cleanup pending"
    : side.state === "retirement-requested" ? "Retirement requested"
    : quest ? quest.phase === "closing" ? "Waiting for conclusion" : phaseWord(quest.phase)
    : side.state === "cancelled" ? "Hire cancelled" : side.state === "stopped" ? "Stopped" : "Starting";
  return <div className="side-quest-line">
    {quest ? <button type="button" className="lnk-btn act" onClick={() => navigate.toPluginPanel("tavern", { subPath: `quest/${quest.id}` })}>
      <span>Side quest: <b data-content>{quest.title}</b></span><OpensMark />
    </button> : <span>Side quest: {side.leadName}</span>}
    <span className={cleanup ? "tv-st-warn" : "m"}>{state}{side.error && <> · <span data-content>{side.error}</span></>}</span>
  </div>;
}
