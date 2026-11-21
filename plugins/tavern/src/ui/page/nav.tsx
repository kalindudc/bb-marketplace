import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { BoardQuestSummary, Room } from "../../shared/contract";
import { ExpandsMark, OpensMark } from "../kit";
import { finishedQuests } from "./archive";
import { Ago, CrestOf, PhaseMark, characterName, type Registry } from "./common";
import { PageGlyph } from "./glyphs";
import { activeQuests, endedCounts, phaseWord, type PageRoute } from "./model";
import { usePanelState } from "./panel-state";

const RETURNED_CAP = 5;

/** The sidebar's quests: every active quest, then the returned and stopped ones in a fold that starts closed. Archived quests stay out. */
export function QuestNav({ room, registry, route }: { room: Room; registry: Registry | undefined; route: PageRoute }) {
  const navigate = useBbNavigate();
  const active = activeQuests(room);
  const done = finishedQuests(room);
  const currentId = "id" in route ? route.id : null;
  const [kept, setOpen] = usePanelState<boolean | null>("nav.returned", null, (v) => typeof v === "boolean");
  const open = kept ?? done.some((q) => q.id === currentId);
  const asksFor = (id: string) => room.asks.filter((a) => a.state === "open" && a.boardQuestId === id).length;
  const keeperOf = (id: string) => room.keepers.find((k) => k.member.threadId === id)?.member;
  const grouped = room.keepers.length > 1;
  const go = (subPath: string) => navigate.toPluginPanel("tavern", { subPath });

  const activeRow = (q: BoardQuestSummary, crest: boolean) => {
    const keeper = keeperOf(q.keeperThreadId);
    const n = asksFor(q.id);
    return <button type="button" key={q.id} className={`tv-squest act ${crest ? "" : "in"}`} aria-current={currentId === q.id ? "page" : undefined} onClick={() => go(`quest/${q.id}`)} title={q.title}
      aria-label={`${q.title} · ${phaseWord(q.phase)}${n ? ` · ${n} need${n === 1 ? "s" : ""} you` : ""}`}>
      {crest && keeper && registry ? <CrestOf member={keeper} registry={registry} size={18} /> : <span />}
      <span className="tv-squest-t">{q.short || q.title}</span>
      <PhaseMark phase={q.phase} />
      {n > 0 && <span className="tv-snav-c y tv-squest-n"><PageGlyph name="you" size={10} /><span>{n}</span></span>}
      <Ago at={q.updatedAt} />
    </button>;
  };

  return <>
    <div className="tv-shead tv-shead-q"><span>Quests on the board</span><span className="tv-snav-c">{active.length} active</span></div>
    {grouped
      ? room.keepers.map((k) => {
        const mine = active.filter((q) => q.keeperThreadId === k.member.threadId);
        if (!mine.length) return null;
        const name = registry ? characterName(registry, k.member) : "Keeper";
        return <div key={k.member.threadId} className="tv-sgroup">
          <button type="button" className="tv-skeeper act" onClick={() => navigate.toThread(k.member.threadId)} title={`Open ${name}'s thread`} aria-label={`${name}, Keeper: open thread`}>
            {registry ? <CrestOf member={k.member} registry={registry} size={14} /> : <span />}<span>{name}</span><OpensMark />
          </button>
          {mine.map((q) => activeRow(q, false))}
        </div>;
      })
      : active.map((q) => activeRow(q, true))}
    {!active.length && <p className="tv-empty tv-snone" data-empty>{room.keepers.some(k => k.boardQuests.length > 0) ? "No active quests right now" : "No quests yet"}</p>}
    {done.length > 0 && <>
      <button type="button" className="tv-sfold act" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={`${endedCounts(done).heading}: ${endedCounts(done).words}`} title={endedCounts(done).words}>
        <ExpandsMark open={open} /><span>{endedCounts(done).heading}</span><span className="tv-snav-c">{done.length}</span>
      </button>
      {open && <>
        {done.slice(0, RETURNED_CAP).map((q) => {
          const keeper = keeperOf(q.keeperThreadId);
          const returned = q.phase === "done";
          return <button type="button" key={q.id} className="tv-squest act tv-sdone" aria-current={currentId === q.id ? "page" : undefined} onClick={() => go(returned ? `tale/${q.id}` : `quest/${q.id}`)} title={q.title}
            aria-label={`${q.title} · ${returned ? "returned" : "stopped"} · open ${returned ? "the tale" : "the quest page"}`}>
            {keeper && registry ? <CrestOf member={keeper} registry={registry} size={18} /> : <span />}
            <span className="tv-squest-t">{q.short || q.title}</span>
            <span className="tv-sdone-s"><PageGlyph name={returned ? "done" : "rejected"} size={11} /><span>{returned ? "returned" : "stopped"}</span></span>
            <Ago at={q.endedAt ?? q.updatedAt} />
          </button>;
        })}
        {done.length > RETURNED_CAP && <button type="button" className="tv-slink act" onClick={() => go("returned")}><span>Show all {done.length}</span><OpensMark /></button>}
      </>}
    </>}
  </>;
}

/** The phone's page picker lists the same quests: every active one, then the latest returned. */
const mobileDone = (room: Room) => finishedQuests(room).slice(0, RETURNED_CAP);
export const mobileQuestPaths = (room: Room) => [...activeQuests(room).map((q) => `quest/${q.id}`), ...mobileDone(room).map((q) => `${q.phase === "done" ? "tale" : "quest"}/${q.id}`)];
export function MobileQuestOptions({ room }: { room: Room }) {
  const active = activeQuests(room), done = mobileDone(room);
  const asksFor = (id: string) => room.asks.filter((a) => a.state === "open" && a.boardQuestId === id).length;
  return <>
    {active.length > 0 && <optgroup label="Quests on the board">{active.map((q) => { const n = asksFor(q.id); return <option key={q.id} value={`quest/${q.id}`} title={q.title}>{q.short || q.title} · {phaseWord(q.phase)}{n ? ` · ${n} need${n === 1 ? "s" : ""} you` : ""}</option>; })}</optgroup>}
    {done.length > 0 && <optgroup label={`${endedCounts(done).heading} (${endedCounts(done).words})`}>{done.map((q) => <option key={q.id} value={`${q.phase === "done" ? "tale" : "quest"}/${q.id}`} title={q.title}>{q.short || q.title} · {q.phase === "done" ? "returned" : "stopped"}</option>)}</optgroup>}
  </>;
}
