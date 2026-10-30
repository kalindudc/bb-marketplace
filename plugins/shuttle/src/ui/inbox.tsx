import { experimental_Icon as Icon, useSettings } from "@get-bb/plugin-sdk/app";
import type { PrView } from "../contract";
import { NextButtons, useActions } from "./actions";
import { EventIcon } from "./activity";
import { BUTTON, BUTTON_GHOST, CARD_GRID, ErrorNote, onCardClick, PAGE, PageHeading, SELECTED_CARD, STRIP, TONE_EDGE, TONE_TEXT } from "./common";
import { NEXT_ICONS } from "./constants";
import { messageOf, useShuttleQuery } from "./data";
import { age, plural, shortKey, tinyKey } from "./format";
import { useFolding } from "./prefs";
import type { Route } from "./route";
import { StalePill } from "./pills";
import { GroupHeader, type RowLayout } from "./row";

/** One decision: why it is here, its buttons in the server's words, when it leaves, and Snooze. */
function InboxCard({ pr, layout }: { pr: PrView; layout: RowLayout }) {
  const actions = useActions();
  const next = pr.next;
  const selected = layout.selected === pr.key;
  return (
    <article data-card={pr.key} aria-label={pr.title} aria-current={selected ? "true" : undefined} onClick={onCardClick(() => layout.onSelect(pr.key))}
      className={`flex cursor-pointer flex-col rounded-lg border border-l-[3px] border-border px-3.5 py-2.5 transition-colors ${TONE_EDGE[next.tone]} ${selected ? SELECTED_CARD : "bg-card hover:bg-state-hover"}`}>
      <div className="flex items-start gap-2">
        <div className={`flex min-w-0 flex-1 items-center gap-1.5 pt-1 text-[10.5px] font-bold uppercase tracking-wider ${TONE_TEXT[next.tone]}`}>
          <Icon name={NEXT_ICONS[next.kind]} fallback="Circle" className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">{pr.mine ? "Your PR" : "Review"} · {next.label}</span>
        </div>
        <button type="button" className={`${BUTTON_GHOST} -mr-1.5 -mt-0.5`} title="Hide it until tomorrow 9:00, or sooner if something new happens" onClick={() => void actions.writes.setSnooze(pr, "tomorrow")}>
          <Icon name="Clock" className="size-3.5" aria-hidden />Snooze
        </button>
      </div>
      <button type="button" className="mb-px mt-0.5 block cursor-pointer text-left text-sm font-semibold hover:underline hover:underline-offset-2" onClick={() => layout.onSelect(pr.key)}>{pr.title}</button>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] text-muted-foreground">
        <span><span className="font-mono" title={shortKey(pr)}>{tinyKey(pr)}</span> · {pr.serverName}{!pr.mine && ` · ${pr.author}`}</span>
        <StalePill pr={pr} />
      </div>
      <div className="mb-2 mt-1 text-[13px]">{next.why}</div>
      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        <NextButtons pr={pr} />
      </div>
      {next.clears !== null && (
        <div className="mt-2 flex items-start gap-1 text-[11px] text-muted-foreground">
          <Icon name="Info" className="mt-px size-3 shrink-0" aria-hidden />{next.clears}
        </div>
      )}
    </article>
  );
}

const HANDLED = "Handled for you";

/** Decisions waiting on you, each with why it is here and when it leaves; then what automation did. */
export function InboxView({ layout, onGo }: { layout: RowLayout; onGo(route: Route): void }) {
  const inbox = useShuttleQuery("inbox", {});
  const days = useSettings().values?.inboxRequestDays;
  const data = inbox.data;
  const cards = data?.prs.filter((pr) => pr.next.inbox) ?? [];
  const agents = data?.agents;
  const idle = agents === undefined ? 0 : agents.withAgent - agents.working - agents.waiting;
  const folding = useFolding("inbox");
  const handledFolded = folding.folded(HANDLED);
  return (
    <div className={PAGE}>
      <PageHeading title="Inbox" description="Decisions waiting on you. Every card says why it is here and when it leaves." />
      {inbox.error !== null && <ErrorNote>Could not load the Inbox: {messageOf(inbox.error)}</ErrorNote>}
      {data === undefined && inbox.error === null && <div className="py-6 text-sm text-muted-foreground">Loading…</div>}
      {agents !== undefined && agents.open > 0 && (
        <div data-agents className={STRIP}>
          <Icon name="Bot" className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            <b>Agents are on {agents.withAgent} of your {plural(agents.open, "open PR")}:</b> {agents.working} fixing, {agents.waiting} waiting on you, {idle} idle.
          </span>
          {agents.none > 0 && <button type="button" className="cursor-pointer text-primary hover:underline" onClick={() => onGo({ view: "mine", key: null })}>{agents.none} {agents.none === 1 ? "has" : "have"} none</button>}
        </div>
      )}
      <div className={`${CARD_GRID} my-2.5`}>
      {data !== undefined && cards.length === 0 && (
        <article data-all-clear className={`rounded-lg border border-l-[3px] border-border bg-card px-3.5 py-2.5 ${TONE_EDGE.ok}`}>
          <div className={`flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wider ${TONE_TEXT.ok}`}><Icon name="Check" className="size-3.5" aria-hidden />All clear</div>
          <div className="mt-1 text-[13px]">Nothing waits on you. Agents keep working on your PRs, and new requests land here.</div>
        </article>
      )}
      {cards.map((pr) => <InboxCard key={pr.key} pr={pr} layout={layout} />)}
      {data !== undefined && data.olderRequests > 0 && (
        <article data-older onClick={onCardClick(() => onGo({ view: "reviews", source: "asked", key: null }))}
          className={`flex cursor-pointer flex-col rounded-lg border border-l-[3px] border-border bg-card px-3.5 py-2.5 transition-colors hover:bg-state-hover ${TONE_EDGE.neutral}`}>
          <div className={`flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wider ${TONE_TEXT.neutral}`}><Icon name="Clock" className="size-3.5" aria-hidden />Reviews · Older requests</div>
          <div className="mb-2 mt-1 text-[13px]">
            {plural(data.olderRequests, "request")} by name {data.olderRequests === 1 ? "has" : "have"} waited more than {plural(typeof days === "number" ? days : 3, "day")}. They stay in Reviews, not here, so the Inbox stays short.
          </div>
          <div className="mt-auto"><button type="button" className={BUTTON} onClick={() => onGo({ view: "reviews", source: "asked", key: null })}>Triage them in Reviews</button></div>
        </article>
      )}
      </div>
      {data !== undefined && (
        <section aria-label={HANDLED} data-folded={handledFolded ? "" : undefined}>
          <GroupHeader title={HANDLED} count="last 24 hours" description="What automation did, so you don't have to check" layout={layout} folded={handledFolded} onFold={() => folding.toggle(HANDLED)} />
          {!handledFolded && <ul className="overflow-hidden rounded-lg border border-border bg-card px-3 py-1">
            {data.handled.length === 0 && <li className="py-2 text-[13px] text-muted-foreground">Nothing in the last 24 hours.</li>}
            {data.handled.map((event) => (
              <li key={event.id} data-event={event.kind} onClick={event.key === null ? undefined : onCardClick(() => layout.onSelect(event.key!))}
                className={`-mx-3 flex items-start gap-2.5 border-t border-border px-3 py-2 text-[13px] first:border-t-0 ${event.key === null ? "" : "cursor-pointer hover:bg-state-hover"}`}>
                <EventIcon kind={event.kind} />
                <span className="min-w-0 flex-1">
                  {event.text}
                  {event.key !== null && <> <button type="button" className="cursor-pointer text-muted-foreground hover:text-foreground hover:underline" onClick={() => layout.onSelect(event.key!)}>Show</button></>}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{age(event.at)}</span>
              </li>
            ))}
          </ul>}
        </section>
      )}
    </div>
  );
}
