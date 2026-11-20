import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useRef } from "react";
import type { BoardQuestDetail, Room } from "../../shared/contract";
import { settled, verifiedWaypoint } from "../../shared/waypoint";
import { useMoment } from "../kit/moment";
import { verifiedOf, verifiedWords, FigureRow, OpensMark, Prose, QuestMap, questNames, readable, Vocabulary, glowVars, plural, taleFigures } from "../kit";
import { Ago, PageButton, Section, StateMark, ThreadButton, Time, type Registry } from "./common";
import { PageGlyph } from "./glyphs";
import { leftNothing, reportBlocks } from "./model";
import { TaleResults } from "../kit/tale-results";
import { TaleAction, TaleDelivery } from "../kit/tale-delivery";
import { CreditCard, LeftRow, LootRow } from "./finished";
import { WaiverRows } from "../kit/waiver-rows";

/** The Keeper's "left" note and the skipped waypoints, quietly; "Nothing left for you." when there is neither. */
function LeftForYou({ detail, registry }: { detail: BoardQuestDetail; registry: Registry }) {
  const tale = detail.tale;
  if (!tale) return null;
  const names = questNames(detail.quest, registry, detail.reports);
  const skipped = tale.skipped.map((s) => ({ ...s, title: detail.quest.waypoints.find((w) => w.id === s.waypointId)?.title ?? "a waypoint" }));
  const said = !leftNothing(tale.left);
  return <aside className={`tv-leftfor nested ${said || skipped.length ? "" : "none"}`} aria-label="Left for you">
    <PageGlyph name="diamond" size={14} />
    <div className="tv-leftfor-b">
      <b>Left for you</b>
      {said ? <p data-content><Prose text={readable(tale.left!, names)} /></p> : !skipped.length && <p>Nothing left for you.</p>}
      {skipped.length > 0 && <ul>{skipped.map((s) => <li key={s.waypointId}><span className="tv-wpid" title={s.title}>{s.waypointId}</span> skipped: <b>{s.title}</b> · <span data-content>{readable(s.reason, names)}</span></li>)}</ul>}
    </div>
  </aside>;
}

/** The party's credits. The tale being told deals them in once per device for this quest; a key or click inside finishes it. */
function TaleCredits({ detail, registry }: { detail: BoardQuestDetail; registry: Registry }) {
  const quest = detail.quest;
  const ref = useRef<HTMLOListElement>(null);
  const moment = useMoment(ref, { surface: "page", kind: "tale told", rememberKey: `moment:tale:${quest.id}`, active: true, className: "mo-tale", ms: 900 });
  return <div className="tv-credits-w"><ol ref={ref} {...moment} className={`tv-credits n-${Math.min(quest.members.length, 5) === 5 ? "many" : quest.members.length}`}>{quest.members.map((member, i) => <CreditCard key={member.threadId} member={member} index={i} detail={detail} registry={registry} />)}</ol></div>;
}

export function TalePage({ detail, registry, room }: { detail: BoardQuestDetail; registry: Registry; room?: Room }) {
  const keeperArchived = !!room?.keepers.find((k) => k.member.threadId === detail.quest.keeperThreadId)?.archived;
  const navigate = useBbNavigate();
  const quest = detail.quest;
  if (quest.phase === "stopped") return <div className="tv-tale-wait"><h1 className="sr">The tale (credits): {quest.title}</h1><StateMark tone="wait">Stopped</StateMark><p>This quest was stopped, so it has no tale. The quest record has what was done and left.</p><PageButton path={`quest/${quest.id}`}>The quest record</PageButton></div>;
  if (quest.phase !== "done") return <div className="tv-tale-wait"><h1 className="sr">The tale (credits): {quest.title}</h1><StateMark tone="wait">Not returned yet</StateMark><p>This quest has not returned. No completed tale or loot is claimed.</p><PageButton path={`quest/${quest.id}`}>Open the live quest</PageButton></div>;
  const waivers = detail.tale?.waivers ?? quest.waivers ?? [];
  const closedEarly = detail.tale?.closure === "closed-early" || quest.outcome === "closed-early";
  const verified = quest.waypoints.filter(verifiedWaypoint);
  const done = quest.waypoints.filter(w => w.state === "done" || w.state === "accepted");
  const left = quest.waypoints.filter(w => !settled(w) || w.state === "skipped");
  const names = questNames(quest, registry, detail.reports);
  const skippedWhy = (id: string) => { const s = detail.tale?.skipped.find((x) => x.waypointId === id); return s ? readable(s.reason, names) : undefined; };
  return <div className="tv-tale-page">
    <h1 className="sr">The tale (credits): {quest.title}</h1>
    <div className="tv-sline"><StateMark tone="done"><b>Returned</b></StateMark>{quest.endedAt !== null && <div className="tv-facts"><span><b><Time at={quest.endedAt} /></b> · <Ago at={quest.endedAt} /></span></div>}<span className="tv-sp" /><button type="button" className="lnk-btn act tv-tale-full" onClick={() => navigate.toPluginPanel("tavern", { subPath: `quest/${quest.id}` })} title="The quest's complete record: history, decisions, asks, the plan and reports"><span>The full quest</span><OpensMark /></button></div>
    <section className="tv-tale tv-card lit" aria-labelledby="tv-tale-h" style={glowVars(`tale:${quest.id}`)}>
      <header className="tv-tale-head">
        <div className="lbl">The tale is told <span className="anc">credits</span></div>
        <h2 id="tv-tale-h" className="tv-tale-title clamp" title={quest.title} data-content>{quest.title}</h2>
      </header>
      {detail.tale && (detail.tale.delivery || detail.tale.results) ? <section className="tv-tale-delivery" aria-label="What the Keeper brought back">
        <h3>What the Keeper brought back</h3>
        <TaleResults results={detail.tale.results} />
        {!detail.tale.delivery && <div className="tv-tale-lead">{reportBlocks(readable(detail.tale.outcome, names)).map((block, i) => block.kind === "list"
          ? <ol key={i}>{block.items.map((item, j) => <li key={j}><Prose text={item} /></li>)}</ol>
          : block.kind === "code" ? <pre key={i}><code>{block.text}</code></pre> : <p key={i}><Prose text={block.text} /></p>)}</div>}
        {detail.tale.delivery && <TaleDelivery tale={detail.tale} questId={quest.id} threadId={quest.keeperThreadId} keeperName={room?.keepers.find(keeper => keeper.member.threadId === quest.keeperThreadId)?.member.displayName ?? "the Keeper"} />}
        {detail.tale.delivery?.truncated && <ThreadButton id={quest.keeperThreadId} label="The rest is in the Keeper's thread ›" />}
      </section> : detail.tale ? <div className="tv-tale-lead" data-content>{reportBlocks(readable(detail.tale.outcome, names)).map((block, i) => block.kind === "list"
        ? <ol key={i}>{block.items.map((item, j) => <li key={j}><Prose text={item} /></li>)}</ol>
        : block.kind === "code" ? <pre key={i}><code>{block.text}</code></pre> : <p key={i}><Prose text={block.text} /></p>)}</div> : <p className="tv-tale-lead none">The Keeper wrote no tale for this quest. The members' reports are below.</p>}
      {detail.tale?.next !== undefined && <section className="tv-tale-next" aria-label="What to do now">
        <h3>What to do now</h3>
        {detail.tale.next.length ? <ol>{detail.tale.next.map((action, i) => <li key={i}><TaleAction text={action} threadId={quest.keeperThreadId} tale={detail.tale!} /></li>)}</ol> : <p>Nothing for you to do</p>}
      </section>}
      {detail.tale?.delivery && <details className="tv-tale-record"><summary>The Keeper's record</summary><p><Prose text={readable(detail.tale.outcome, names)} /></p></details>}
      <FigureRow figures={taleFigures(detail)} />
      <div className="tv-tale-path"><QuestMap quest={quest} mode="tale" stretch memberCredits={detail.memberCredits} /></div>
      <LeftForYou detail={detail} registry={registry} />
      <div className="tv-credits-h"><h3><Vocabulary word="party" /></h3><span className="tv-count">{plural(quest.members.length, "member")}</span></div>
      <TaleCredits detail={detail} registry={registry} />
    </section>
    <div className="tv-tgrid">
      {closedEarly && <Section title="Closed early at your request" count={`${waivers.length} not verified`} level={3} className="tv-card tv-tsec">{!waivers.length && detail.tale?.closeReason && <p data-content>{detail.tale.closeReason}</p>}<WaiverRows items={waivers} final /></Section>}
      {done.length > 0 && <Section title="Done without a Warden check" count={plural(done.length, "waypoint")} level={3} className="tv-card tv-tsec"><ul className="tv-dw">{done.map(w => <LeftRow key={w.id} waypoint={w} />)}</ul></Section>}
      <Section title="Loot (verified results)" count={verifiedOf(quest) ? verifiedWords(verifiedOf(quest)!, "") : "no quest map"} level={3} className="tv-card tv-tsec">{verified.length ? <ul className="tv-dw tv-loot">{verified.map((w) => <LootRow key={w.id} waypoint={w} detail={detail} registry={registry} />)}</ul> : <p className="tv-empty" data-empty>No verified loot.</p>}</Section>
      <Section title="Left on the board" count={`${plural(left.length, "waypoint")}`} level={3} className="tv-card tv-tsec">{left.length ? <ul className="tv-dw">{left.map((w) => <LeftRow key={w.id} waypoint={w} skipped={skippedWhy(w.id)} />)}</ul> : <p className="tv-empty" data-empty>No unverified waypoints remain.</p>}</Section>
      <Section title="Done when" level={3} className="tv-card tv-tsec"><p data-content>{quest.plan?.doneWhen ?? "No done-when recorded."}</p><div className="tv-first-links tv-tsec-foot"><ThreadButton id={quest.keeperThreadId} label="Open the Keeper's thread" quiet={keeperArchived} /></div></Section>
    </div>
  </div>;
}
