import { experimental_useRpcMutation, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { rpcContract, type BoardQuestSummary } from "../../shared/contract";
import type { Ask, CheckerHandoffHold } from "../../shared/schema";
import { Clamp, Glyph, StateMark, activeHold, localTime, releaseWords, useNow } from "../kit";

/**
 * The checker-handoff hold: the Keeper won't hire or re-task a Warden on this quest until the user releases it. A calm, still row
 * with one control; the server's answer is the state, and its receipt stays after the row's hold reads released. A hold released
 * before this visit draws nothing here; the history says when and how.
 */
export function CheckerHold({ quest, asks, queue = false }: { quest: Pick<BoardQuestSummary, "id" | "short" | "title" | "phase" | "checkerHandoffHold">; asks: readonly Ask[]; queue?: boolean }) {
  const navigate = useBbNavigate();
  const release = experimental_useRpcMutation({ contract: rpcContract, method: "releaseCheckerHandoff" });
  const now = useNow();
  const [released, setReleased] = useState<CheckerHandoffHold | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const hold = activeHold(quest);
  // The receipt is for this hold only: a newer hold (a new id) that arrives while the page is open draws in its place.
  if (released?.release && (!hold || hold.id === released.id)) {
    const r = released.release;
    return <div className="tv-grp" data-checker-hold data-released>
      <p className="tv-hold-done" role="status"><Glyph name="gate" size={13} />Checker handoff released at {localTime(r.at, now)}, {releaseWords(r)}. The Keeper can hand the work to a Warden now.</p>
    </div>;
  }
  if (!hold) return null;
  const linked = asks.some((a) => a.state === "open" && a.releaseHoldId === hold.id);
  const press = async () => {
    setProblem(null);
    try { setReleased((await release.mutate({ boardQuestId: quest.id, holdId: hold.id, via: "page" })).checkerHandoffHold); }
    catch (e) { setProblem(e instanceof Error ? e.message : String(e)); }
  };
  return <div className="tv-grp" data-checker-hold>
    {!queue && <div className="tv-grp-h"><StateMark tone="you">Held for you</StateMark><span className="num m">1</span></div>}
    <div className="tv-hold">
      <Glyph name="gate" size={14} className="tv-hold-g" />
      <div className="tv-hold-t">
        {/* In the needs-you queue the quest is named once, as a quiet link; on its own page it needs no name. */}
        {queue ? <span><b className="tv-hold-h">Checker handoff on hold</b> · <button type="button" className="tv-ilink tv-hold-quest" onClick={() => navigate.toPluginPanel("tavern", { subPath: `quest/${quest.id}` })} title={`Open the quest page: ${quest.title}`}>{quest.short}</button></span>
          : <b className="tv-hold-h">Checker handoff on hold</b>}
        <p>No Warden is hired or re-tasked on this quest until you release it.</p>
        <p className="tv-hold-why" data-content>{hold.reason}</p>
        <p className="tv-hold-src">Held at {localTime(hold.createdAt, now)}, from your message: <Clamp text={`“${hold.sourceText}”`} className="tv-hold-q" /></p>
        {linked && <p className="m small">The Keeper also asked you about it, below.</p>}
        {problem && <p className="tv-problem" role="alert">Couldn’t release it: {problem}</p>}
      </div>
      <button type="button" className="btn sm tv-hold-release" disabled={release.isPending} onClick={() => void press()} title="Lets the Keeper hand the work to a Warden for checking">Release checker handoff</button>
    </div>
  </div>;
}
