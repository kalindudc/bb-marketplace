import { experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { useMemo, useState } from "react";
import { rpcContract, type Room } from "../../shared/contract";
import type { AwayDigest } from "../../shared/away-rpc";
import type { AwayWindow } from "../../shared/away";
import { OpensMark, SkLines, Vocabulary, plural, glowVars } from "../kit";
import { CLOSING_TAB, useOpenPanelTab } from "./panels";
import { AwayStopChoices, windowStopWords } from "./away-preferences";
import { useTavernSettings } from "./settings";
import { AwayForm, AwayNotes, REOPEN_LINE, ReturnButton, idFree, roomNames, useAwayControl, useReturn } from "./away";
import { AwayTime, ClosedWords, Empty, PageButton, PhaseMark, StateMark, characterName, type Registry } from "./common";
import { PageGlyph } from "./glyphs";
import { eventContext, eventLines, questsIn, roomAway, visibleMembers, workingQuests } from "./model";
import { EventList } from "./room";
import { FoldLoad, PageLoad } from "./skeletons";

export function ClosingTimeSheet({ room, registry }: { room: Room; registry: Registry }) {
  const openTab = useOpenPanelTab();
  const [inline, setInline] = useState(false);
  const live = workingQuests(room);
  const open = () => { if (!openTab(CLOSING_TAB)) setInline(true); };
  const control = useAwayControl(room);
  const settings = useTavernSettings();
  const isClosed = !!roomAway(room)?.closed;
  const ret = useReturn(room, registry);
  return <div className="tv-closing">
    <header className="tv-sheet-head tv-card lit" style={glowVars("closing")}>
      <PageGlyph name="lantern" size={40} />
      <div className="tv-sh-t"><h1><Vocabulary word="closing" /></h1><p className="tv-cc-r">Choose what keeps going and what waits for your return.</p><div className="tv-facts">{isClosed && <StateMark tone="wait"><b><ClosedWords away={roomAway(room)} /></b></StateMark>}<span><b className="num">{live.length}</b> live {live.length === 1 ? "quest" : "quests"} would keep going</span></div></div>
      <button type="button" className="btn pri" onClick={open} aria-expanded={inline || undefined} title="Opens the sheet in the side panel, beside this page"><PageGlyph name="lantern" /><span>{isClosed ? "Open the Closing time sheet" : "Close the tavern…"}</span><OpensMark /></button>
    </header>
    {(isClosed || ret.receipt || ret.problem) && <div className="tv-awaybar"><ReturnButton room={room} registry={registry} action={ret} />{isClosed && <span className="m small">{REOPEN_LINE}</span>}</div>}
    <AwayNotes room={room} registry={registry} control={control.data} />
    {inline && <section className="tv-card tv-inlineform" aria-label="Closing-time sheet"><AwayForm room={room} registry={registry} /><button type="button" className="btn sm" onClick={() => setInline(false)}><span>Hide the sheet</span></button></section>}
    <div className="tv-tgrid">
      <section className="tv-card tv-tsec" aria-labelledby="tv-cl-q"><header className="tv-colh"><h3 id="tv-cl-q">What keeps going</h3><span className="tv-count">{plural(live.length, "quest")}</span></header>{live.length ? <ul className="tv-dw">{live.map((q) => <li key={q.id}><PhaseMark phase={q.phase} /><span><b>{q.short}</b><span className="m"> · choose what happens in the sheet</span></span></li>)}</ul> : <p className="tv-empty" data-empty>No live quests. The tavern is quiet.</p>}</section>
      <section className="tv-card tv-tsec" aria-label="Closing time guard settings">
        {isClosed && control.data?.window && <p>{windowStopWords(control.data.window)}</p>}
        <p className="m small">Changes here set your default for future windows. The sheet lets you choose for one window.</p>
        {settings.data ? <AwayStopChoices label={isClosed ? "Never while closed next time" : undefined} items={settings.data.effective.away.neverWhileClosed}
          disabled={settings.pending} onChange={items => void settings.save({ away: { neverWhileClosed: items } })} /> : <PageLoad error={settings.error} retry={settings.refetch} skeleton={<SkLines n={4} />} label="the Closing time settings" />}
        {(settings.note || settings.problems[0]) && <p className="tv-problem" role="alert">{settings.note ?? settings.problems[0]?.message}</p>}
      </section>
      <section className="tv-card tv-tsec" aria-labelledby="tv-cl-after"><header className="tv-colh"><h3 id="tv-cl-after">When you are back</h3></header><p>A digest of what moved, grouped by quest, with every ask that waited.</p><div className="tv-first-links" style={{ justifyContent: "flex-start", marginTop: 10 }}><PageButton path="digest" className="ghost sm">While closed <span className="anc">digest</span></PageButton></div></section>
    </div>
  </div>;
}

const causeWords = (w: AwayWindow, name: (id: string) => string) => {
  const c = w.returnCause;
  if (!c) return null;
  if (c.kind === "explicit-return") return "you returned";
  if (c.kind === "user-message") return `your message to ${name(c.threadId)}`;
  return `your answer in ${name(c.threadId)}’s thread`;
};

/** While closed: the window, what waits on you, quests that returned while you were away with their cleanup, other activity, then the events. */
export function ClosedDigest({ room, registry }: { room: Room; registry: Registry }) {
  const windowId = roomAway(room)?.windowId ?? null;
  const digest = experimental_useRpcQuery({ contract: rpcContract, method: "awayDigest", input: {}, enabled: !!windowId });
  if (!windowId) return <div className="tv-digest"><div className="tv-sline"><h1 className="tv-hero"><span>While closed <span className="anc">digest</span></span></h1></div><Empty>The tavern hasn’t closed yet. After you close it and come back, this page lists what happened while you were away.</Empty><div className="tv-first-links" style={{ justifyContent: "flex-start" }}><PageButton path="closing" className="ghost sm"><Vocabulary word="closing" /></PageButton></div></div>;
  if (!digest.data) return <div className="tv-digest"><PageLoad error={digest.error} retry={digest.refetch} skeleton={<div className="tv-digest-grid"><section className="tv-card tv-tsec"><SkLines n={4} /></section><section className="tv-card tv-tsec"><SkLines n={4} /></section></div>} label="the digest" /></div>;
  return <DigestBody digest={digest.data} room={room} registry={registry} />;
}

function DigestBody({ digest, room, registry }: { digest: AwayDigest; room: Room; registry: Registry }) {
  const names = roomNames(room, registry);
  const member = (id: string) => { const m = visibleMembers(room).find((x) => x.threadId === id); return m ? characterName(registry, m) : "A member"; };
  const ctx = useMemo(() => eventContext(room, registry), [room, registry]);
  const w = digest.window;
  const returned = digest.quests.filter((q) => q.returnedWhileAway);
  const others = digest.quests.filter((q) => !q.returnedWhileAway && q.events + q.reports + q.decisions + q.asks > 0);
  const cause = w ? causeWords(w, member) : null;
  return <div className="tv-digest">
    <div className="tv-sline"><h1 className="tv-hero"><b className="num">{digest.totalEvents}</b><span>{digest.totalEvents === 1 ? "event" : "events"} · while the tavern was closed <span className="anc">digest</span></span></h1>
      {w && <div className="tv-facts"><span>closed <b><AwayTime at={w.closedAt} /></b></span><span>back at <b><AwayTime at={w.until} /></b></span>{w.returnedAt !== null ? <><span>returned <b><AwayTime at={w.returnedAt} /></b></span>{cause && <span>{cause}</span>}</> : <StateMark tone="wait"><b>{roomAway(room)?.closed ? <ClosedWords away={roomAway(room)} /> : "Closed"}</b></StateMark>}</div>}
    </div>
    {w?.note && <p className="tv-dg-note">Your note: <span data-content>“{w.note}”</span></p>}
    <div className="tv-digest-grid">
      <section className="tv-card tv-tsec" aria-labelledby="tv-dg-asks" data-sec="asks"><header className="tv-colh"><h2 id="tv-dg-asks">Waiting on you</h2><span className="tv-count">{plural(digest.totalAsks, "ask")}</span></header>
        <AskRows asks={digest.asks} room={room} names={names} />
        <MoreAsks cursor={digest.nextAskCursor} shown={digest.asks.length} total={digest.totalAsks} room={room} names={names} />
      </section>
      {returned.length > 0 && <section className="tv-card tv-tsec" aria-labelledby="tv-dg-ret" data-sec="returned"><header className="tv-colh"><h2 id="tv-dg-ret">Returned while you were away</h2><span className="tv-count">{plural(returned.length, "quest")}</span></header>
        <ul className="tv-dg-rows">{returned.map((q) => <li key={q.questId} className="tv-dg-ret" data-returned={q.questId}>
          <div className="tv-dg-rh"><b title={q.title} data-content>{q.short || q.title}</b>{!q.missing && <span className="tv-dg-acts"><PageButton path={`tale/${q.questId}`} className="ghost sm">The tale</PageButton><PageButton path={`quest/${q.questId}`} className="ghost sm">The full quest</PageButton></span>}</div>
          {(q.deferredCleanup ?? []).length > 0 && <ul className="tv-dg-clean" aria-label="Cleanup waiting">{q.deferredCleanup!.map((c) => <li key={c.threadId} data-cleanup={c.pending ? (c.error ? "waits-problem" : "waits") : c.error ? "failed" : "done"}>
            <PageGlyph name={c.error ? "stale" : c.pending ? "wait" : "done"} size={12} />
            <span><b>{member(c.threadId)}</b>’s thread: {c.pending ? "archive waits" : c.error ? "archive failed" : "archived"}{c.error ? <>: <span data-content>{idFree(c.error, names)}</span></> : ""}</span>
          </li>)}</ul>}
        </li>)}</ul>
      </section>}
      {others.length > 0 && <section className="tv-card tv-tsec" aria-labelledby="tv-dg-other" data-sec="other"><header className="tv-colh"><h2 id="tv-dg-other">Other quests with activity</h2><span className="tv-count">{plural(others.length, "quest")}</span></header>
        <ul className="tv-dg-rows">{others.map((q) => <li key={q.questId} className="tv-dg-rh"><b title={q.title} data-content>{q.short || q.title}</b><span className="m">{[q.events && plural(q.events, "event"), q.reports && plural(q.reports, "report"), q.decisions && plural(q.decisions, "decision"), q.asks && plural(q.asks, "ask")].filter(Boolean).join(" · ")}</span><span className="tv-dg-acts">{q.missing ? <span className="m">no longer on the board</span> : <PageButton path={`quest/${q.questId}`} className="ghost sm">The quest</PageButton>}</span></li>)}</ul>
      </section>}
      <section className="tv-card tv-tsec" aria-labelledby="tv-dg-ev" data-sec="events"><header className="tv-colh"><h2 id="tv-dg-ev">What happened</h2><span className="tv-count">{plural(digest.totalEvents, "event")}</span></header>
        {digest.events.length ? <EventList lines={eventLines(digest.events, ctx)} registry={registry} /> : <p className="tv-empty" data-empty>Nothing was recorded while you were away.</p>}
        <MoreEvents cursor={digest.nextCursor} shown={digest.events.length} total={digest.totalEvents} room={room} registry={registry} />
      </section>
    </div>
  </div>;
}

type DigestAsk = AwayDigest["asks"][number];
function AskRows({ asks, room, names }: { asks: DigestAsk[]; room: Room; names: ReturnType<typeof roomNames> }) {
  if (!asks.length) return <p className="tv-empty" data-empty>No asks waited for you.</p>;
  const closed = !!roomAway(room)?.closed;
  const sorted = [...asks].sort((a, b) => Number(b.waitingAtEnd) - Number(a.waitingAtEnd) || a.ask.createdAt - b.ask.createdAt);
  const short = (id: string | null) => (id ? questsIn(room).find((q) => q.id === id)?.short ?? null : null);
  return <ul className="tv-dg-rows">{sorted.map(({ ask, waitingAtEnd }) => <li key={ask.id} className="tv-dg-ask" data-waiting={waitingAtEnd || undefined}>
    <span className="tv-dg-q" data-content>{idFree(ask.question, names)}</span>
    <span className="m">{[short(ask.boardQuestId), waitingAtEnd ? (closed ? "waiting now" : "was waiting when you returned") : ask.state === "open" ? "open" : ask.state].filter(Boolean).join(" · ")}</span>
    {ask.boardQuestId && <span className="tv-dg-acts"><PageButton path={`quest/${ask.boardQuestId}`} className="ghost sm">The quest</PageButton></span>}
  </li>)}</ul>;
}
/** The rest of a paged list: "Show N more" while the server has a next page, else a plain "M of N shown" when it holds more than it sent. */
function Rest({ shown, total, noun, onMore }: { shown: number; total: number; noun: [string, string]; onMore?: () => void }) {
  const left = total - shown;
  if (left <= 0) return null;
  if (onMore) return <button type="button" className="tv-fold act" onClick={onMore} data-rest><span>Show {left} more {left === 1 ? noun[0] : noun[1]}</span></button>;
  return <p className="m small" data-rest>{shown} of {total} shown</p>;
}
function MoreAsks({ cursor, shown, total, room, names }: { cursor: string | null; shown: number; total: number; room: Room; names: ReturnType<typeof roomNames> }) {
  const [open, setOpen] = useState(false);
  const page = experimental_useRpcQuery({ contract: rpcContract, method: "awayDigest", input: { askCursor: cursor }, enabled: open && !!cursor });
  if (!open || !cursor) return <Rest shown={shown} total={total} noun={["ask", "asks"]} onMore={cursor ? () => setOpen(true) : undefined} />;
  if (!page.data) return <FoldLoad error={page.error} retry={page.refetch} label="more asks" />;
  return <><AskRows asks={page.data.asks} room={room} names={names} /><MoreAsks cursor={page.data.nextAskCursor} shown={shown + page.data.asks.length} total={total} room={room} names={names} /></>;
}
function MoreEvents({ cursor, shown, total, room, registry }: { cursor: number | null; shown: number; total: number; room: Room; registry: Registry }) {
  const [open, setOpen] = useState(false);
  const page = experimental_useRpcQuery({ contract: rpcContract, method: "awayDigest", input: { cursor: cursor ?? 0 }, enabled: open && cursor !== null });
  const ctx = useMemo(() => eventContext(room, registry), [room, registry]);
  if (!open || cursor === null) return <Rest shown={shown} total={total} noun={["event", "events"]} onMore={cursor !== null ? () => setOpen(true) : undefined} />;
  if (!page.data) return <FoldLoad error={page.error} retry={page.refetch} label="more events" />;
  return <>{page.data.events.length > 0 && <EventList lines={eventLines(page.data.events, ctx)} registry={registry} />}<MoreEvents cursor={page.data.nextCursor} shown={shown + page.data.events.length} total={total} room={room} registry={registry} /></>;
}
