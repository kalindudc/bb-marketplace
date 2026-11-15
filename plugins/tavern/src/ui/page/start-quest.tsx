import { experimental_useRpcQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { rpcContract, type Room } from "../../shared/contract";
import { ExpandsMark, OverflowMenu, armNewQuest, type MenuItem } from "../kit";
import { CrestOf, StateMark, characterName, type Registry } from "./common";
import { PageGlyph } from "./glyphs";
import { isFinished, keeperStatus } from "./model";
import { jumpTo, jumpWhenShown } from "./rail";

export const START_CAP = 8;

export type StartRow = { threadId: string; name: string; second: string | null; quest: string; status: ReturnType<typeof keeperStatus>; member: Room["keepers"][number]["member"] };

/** The Keepers a new quest can go to: not archived, most recently active first, at most eight. A repeated name carries its thread title. */
export function startRows(room: Room, registry: Registry): { rows: StartRow[]; more: number } {
  const active = room.keepers.filter((k) => !k.archived).sort((a, b) => (b.member.lastActiveAt ?? 0) - (a.member.lastActiveAt ?? 0));
  const names = active.map((k) => characterName(registry, k.member));
  const repeated = new Set(names.filter((n, i) => names.indexOf(n) !== i));
  const rows = active.slice(0, START_CAP).map((k, i) => {
    const quests = k.boardQuests.filter((q) => !isFinished(q.phase)).sort((a, b) => b.updatedAt - a.updatedAt);
    const quest = quests.length ? `${quests[0]!.short || quests[0]!.title}${quests.length > 1 ? ` +${quests.length - 1}` : ""}` : "no quest";
    const second = repeated.has(names[i]!) ? k.threadTitle?.trim() || (k.threadCreatedAt != null ? `thread from ${new Date(k.threadCreatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : null) : null;
    return { threadId: k.member.threadId, name: names[i]!, second, quest, status: keeperStatus(k), member: k.member };
  });
  return { rows, more: Math.max(0, active.length - START_CAP) };
}

/** The header's "Start a quest ▾": a Keeper's thread, armed so the next message can start a board quest, or a new Keeper. */
export function StartQuest({ registry, startKeeper, onRoom = false }: { registry: Registry | undefined; startKeeper: () => void; onRoom?: boolean }) {
  const navigate = useBbNavigate();
  const room = experimental_useRpcQuery({ contract: rpcContract, method: "room", input: {} });
  const { rows, more } = room.data && registry ? startRows(room.data, registry) : { rows: [], more: 0 };
  const inner = <><PageGlyph name="hire" /><span className="tv-head-w">Start a quest</span></>;
  if (!room.error && (!room.data || !registry)) return <button type="button" className="btn" disabled aria-busy="true" title="Start a quest: reading your Keepers…">{inner}<ExpandsMark open={false} /></button>;
  if (!rows.length) return <button type="button" className="btn" onClick={startKeeper} title="Start a quest: opens bb's composer for a new Keeper (lead)" aria-label="Start a quest: new Keeper">{inner}</button>;
  const items: MenuItem[] = [
    ...rows.map((row) => ({
      id: row.threadId,
      label: `${row.name}${row.second ? ` (${row.second})` : ""}: ${row.quest}, ${row.status.word}`,
      title: `Opens ${row.name}'s thread, ready to start a quest`,
      content: <span className="tv-sq">
        <CrestOf member={row.member} registry={registry!} size={18} />
        <b className="tv-sq-n">{row.name}</b>
        {row.second && <span className="tv-sq-2" title={row.second}>{row.second}</span>}
        <span className="tv-sq-q" title={row.quest}>{row.quest}</span>
        <StateMark tone={row.status.tone}>{row.status.word}</StateMark>
      </span>,
      run: () => { armNewQuest(row.threadId); navigate.toThread(row.threadId); },
    })),
    { id: "all", label: more ? `All Keepers, ${more} more` : "All Keepers", title: "The common room, with every Keeper", content: <span className="tv-sq tv-sq-link"><span className="tv-sq-n">{more ? `All Keepers · ${more} more` : "All Keepers"}</span><PageGlyph name="right" size={11} /></span>, run: () => {
      // On the common room, re-opening it changes nothing on screen: jump to the board instead. Elsewhere, open it and land there.
      if (onRoom && document.getElementById("rm-board-h")) { jumpTo("rm-board-h"); return; }
      jumpWhenShown("rm-board-h");
      navigate.toPluginPanel("tavern", { subPath: "room" });
    } },
    { id: "new", divider: true, label: "New Keeper…", title: "Opens bb's composer for a new Keeper (lead)", content: <span className="tv-sq tv-sq-link"><PageGlyph name="hire" size={14} /><span className="tv-sq-n">New Keeper…</span></span>, run: startKeeper },
  ];
  return <OverflowMenu label="Start a quest" items={items} align="end" className="tv-sq-menu" triggerClassName="btn" trigger={<>{inner}<ExpandsMark open={false} /></>} />;
}
