import { experimental_usePluginId, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ReactNode } from "react";
import { attentionView } from "../../shared/attention";
import type { Room } from "../../shared/contract";
import { memberPlace } from "../../shared/member-place";
import type { Member } from "../../shared/schema";
import { PartyStrip } from "../engine/strip";
import { useCharacterQuiet } from "../engine/character-quiet";
import type { Mood } from "../engine/art";
import { Hearth, OpensMark, hearthWords, keeperStatus, memberIdentity, onTheRoad, useNow } from "../kit";
import { ReturnButton, usePendingStops } from "./away";
import { characterName, ClosedWords, plural, type Registry } from "./common";
import { PageGlyph } from "./glyphs";
import { settingsHref } from "./insights";
import { activeQuests, returnedQuests, roomAway } from "./model";
import { jumpTo } from "./rail";
import { ATMOSPHERE_ANCHOR } from "./settings";
import { AlertAction } from "../kit/alert-action";

function Waited({ at }: { at: number }) {
  const now = useNow();
  const m = Math.max(0, Math.floor((now - at) / 60000));
  const h = Math.floor(m / 60);
  return <b className="num">{m < 60 ? `${m}m` : h < 24 ? `${h}h${m % 60 ? ` ${m % 60}m` : ""}` : `${Math.floor(h / 24)}d${h % 24 ? ` ${h % 24}h` : ""}`}</b>;
}

function Jump({ to, children, title }: { to: string; children: ReactNode; title: string }) {
  return <button type="button" className="act rm-jump" onClick={() => jumpTo(to)} title={title}>{children}</button>;
}

function HearthFire({ room, onRoad }: { room: Room; onRoad: number }) {
  const now = useNow();
  const pluginId = experimental_usePluginId();
  const returned = returnedQuests(room).find(quest => !quest.archivedAt)?.id;
  return <div className="tv-hearth-fire" data-slot="hearth"><Hearth surface="page" size={28}
    words={hearthWords(room.keepers.map(keeperStatus), { away: roomAway(room), now, onRoad, showRoad: false })}
    flareKey={returned} replay={room.hearthFlicker !== false} ambientMotion={room.ambientMotion} clearView repeatSeconds={room.repeatSeconds}
    settingsHref={`${settingsHref(pluginId)}#${ATMOSPHERE_ANCHOR}`} /></div>;
}

export function HearthBand({ room, registry }: { room: Room; registry?: Registry }) {
  const navigate = useBbNavigate();
  const pending = usePendingStops(room);
  const quiet = useCharacterQuiet(room.characterQuietUntil);
  const away = roomAway(room);
  const attention = attentionView(room.attention);
  const needs = attention.needYou;
  const decided = attention.decided ?? attention.new;
  const onRoad = onTheRoad(room);
  const live = room.keepers.filter(keeper => !keeper.archived && keeper.quietSince == null);
  const party = [...new Map(live.flatMap(keeper => [...keeper.boardQuests.filter(quest => !quest.archivedAt).flatMap(quest => quest.members), ...keeper.errands]).map(member => [member.threadId, member])).values()];
  const rest = party.filter(member => memberPlace(member) === "rest");
  const road = party.filter(member => memberPlace(member) === "road");
  const members = new Set(attention.items.filter(item => item.kind === "ask" || item.kind === "hold" || item.kind === "hand-back" || item.kind === "rule").map(item => item.keeperThreadId));
  const waits = (keeper: Room["keepers"][number]) => Boolean(keeper.attention?.needYou || members.has(keeper.member.threadId) || keeper.boardQuests.some(quest => quest.move.who === "you"));
  const keepers = live.map(keeper => ({ member: keeper.member, mood: waits(keeper) ? "waiting" as const : keeper.status === "busy" ? "working" as const : "idle" as const }));
  const scenes: { member: Member; mood: Mood; road?: boolean }[] = [...keepers.slice(0, 2), ...road.slice(0, 2).map(member => ({ member, mood: "working" as const, road: true })), ...rest.slice(0, 1).map(member => ({ member, mood: "resting" as const }))];
  const quests = activeQuests(room);
  const failed = quests.flatMap(quest => quest.members).filter(member => member.state === "failed").length;
  const stale = quests.flatMap(quest => quest.members).filter(member => member.strikes > 0).length;
  const errands = room.keepers.flatMap(keeper => keeper.errands).length;
  const solos = room.solos.length;
  const lists = [errands && plural(errands, "errand"), solos && plural(solos, "solo")].filter(Boolean).join(" · ");
  const review = <span>Review <b>{room.review.waiting} of {room.review.budget}</b></span>;
  const summary = keepers.map(({ member, mood }) => `${registry ? characterName(registry, member) : "A Keeper"} is ${mood === "waiting" ? "waiting" : mood === "working" ? "working" : "idle"} at the table`).join("; ") || "No Keeper at the table";
  return <div className="rm-sline" role="group" aria-label="Status" data-sec="status">
    <div className="tv-hearth-band">
      <div className="tv-hearth-need">
        {needs > 0 ? <button type="button" className="tv-hero act" aria-label={`${needs} need you`} onClick={() => jumpTo("tv-needs-you")} title="Scroll to what needs you"><b className="num">{needs}</b><span>need you</span></button> : <div className="tv-hero"><b className="num">0</b><span>need you</span></div>}
        {needs > 0 && attention.oldest != null && <span className="rm-oldest" title={new Date(attention.oldest).toLocaleString()}>oldest <Waited at={attention.oldest} /></span>}
      </div>
      <div className="tv-hearth-scene" data-page-scene>
        <p className="sr tv-hearth-summary">{summary}; {plural(onRoad, "member")} on the road; {plural(rest.length, "member")} {rest.length === 1 ? "rests" : "rest"} by the hearth.</p>
        <HearthFire room={room} onRoad={onRoad} />
        {registry && scenes.map(({ member, mood, road }) => {
          const who = memberIdentity(registry, member);
          if (!who || who.character.plain) return null;
          return <PartyStrip key={member.threadId} character={who.character} classId={who.cls.id} classLabel={who.cls.label}
            surface="page" keeper={member.role === "keeper"} mood={mood} held={mood === "waiting"} mode={room.ambientMotion} quiet={quiet}
            pageScene={{ threadId: member.threadId, road }} onActorClick={() => navigate.toThread(member.threadId)} />;
        })}
      </div>
      <div className="tv-facts">
        <Jump to="rm-board-h" title="Scroll to the quest board"><span><b>{onRoad}</b> on the road</span></Jump>
        <span><b>{rest.length}</b> resting</span>
        <span><b>{stale}</b> quiet</span>
        {room.review.waiting > 0 && <Jump to="rm-review" title="Scroll to the review queue">{review}</Jump>}
        {failed > 0 && <span data-stuck className="tv-bad"><b>{failed}</b> failed <AlertAction action={{ kind: "run", label: "Review failed members", run: () => jumpTo("rm-board-h") }} /></span>}
      </div>
    </div>
    <div className="tv-hearth-links rm-sl2">
      {away?.closed && <button type="button" className="act rm-jump rm-closed" onClick={() => navigate.toPluginPanel("tavern", { subPath: "closing" })} title="Closing time (away): open the page"><PageGlyph name="lantern" /><span><ClosedWords away={away} /></span><OpensMark /></button>}
      {registry && <ReturnButton room={room} registry={registry} className="rm-return" />}
      {pending > 0 && <Jump to="tv-away-notes" title="Scroll to the stops that haven't confirmed"><PageGlyph name="stale" /><span>{plural(pending, "stop")} not confirmed</span></Jump>}
      {decided > 0 && !room.sinceVisit?.decided && <Jump to="room-decided" title="Scroll to Decided for you"><span><b>{decided}</b> decided<span className="rm-long"> for you</span></span></Jump>}
      {lists && <button type="button" className="act rm-jump" onClick={() => jumpTo("rm-lists")} title={`Scroll to ${lists}`} aria-label={`${plural(errands + solos, "thread")}: ${lists}`}><span><span className="rm-lists-long">{lists}</span><span className="rm-lists-short">{plural(errands + solos, "thread")}</span></span></button>}
      {room.recent.length > 0 && <Jump to="rm-events" title="Scroll to What happened"><span>What happened</span></Jump>}
    </div>
  </div>;
}
