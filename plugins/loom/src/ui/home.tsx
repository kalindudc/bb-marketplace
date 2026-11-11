// Loom's Home: four numbers for the day, the Needs you queue across projects, what happened since you looked, and one row
// per project with its ticket bar. Below 56rem the columns stack, the projects before Since you looked.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { HomeFeed, HomeFeedRow, HomeProject, HomeView, PlanningSession } from "../contract";
import { HOME_FEED_LIMIT, HOME_FEED_MAX, type FeedKind } from "../feed-kinds";
import { clockTime, formatDuration, plural } from "../format";
import { Spark } from "./charts";
import { ActionButton, BUTTON, BUTTON_PRIMARY, FIELD, useLoom, useLoomWrite, useAction } from "./common";
import { useControl } from "./controls";
import { DraftHold } from "./draft-hold";
import { focusNote } from "./dispatch";
import { Guide } from "./guide";
import { KBD } from "./kit";
import { MergeConfirm } from "./merge-confirm";
import { ageText, floodText, IN_PLACE, needRoute, QUEUE_ICON, QUEUE_SHOWN, QUEUE_WORD, useQueue, type QueueItem } from "./needs";
import { PHONE_TEXT, useNarrowPage } from "./narrow";
import { AsksCard } from "./planner-page";
import { stateWord } from "./project-line";
import { threadsOfCounts, TicketBar, ticketsLabel } from "./ticket-bar";
import { projectViews } from "./views";
import { useWaiting } from "./questions";
import { AnswerDockProvider, Docked } from "./answer-dock";

const CARD = "loom-card loom-selvedge min-w-0 rounded-md pl-1.5";
const H2 = "text-sm font-semibold";
const COUNT = "loom-num inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center px-1 text-[11px] font-bold leading-none";
const ATT_COUNT = `${COUNT} bg-[var(--attention)] text-[var(--attention-foreground)]`;
const PLAIN_COUNT = `${COUNT} border border-[var(--loom-line)] text-[var(--loom-muted)]`;
const ROW_BUTTON = "min-w-0 cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @max-xl/loom:min-h-11 max-[576px]:min-h-11 pointer-coarse:min-h-11";
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
/** At 56rem and over, Needs you and Since you looked sit side by side above the projects. */
const TWO_COLUMNS = 896;

export type Row = { kind: "project"; project: HomeProject; needs: QueueItem[] } | { kind: "planning"; session: PlanningSession };

/** Most urgent first; a row sorts by its most urgent need. */
const RANK: Record<QueueItem["kind"], number> = { blocked: 0, failed: 1, paused: 1, question: 2, ask: 2, approve: 2, pending: 2, merge: 2, draft: 2, wrongBase: 2, rollout: 3, land: 3 };
const CALM = 9;
const rankOf = (row: Row) => (row.kind === "planning" ? RANK.question : row.needs.reduce((best, need) => Math.min(best, RANK[need.kind]), CALM));

/** Rows that need you first, by their most urgent need, then the rest in the server's order; finished projects that need nothing apart. */
export function homeRows(projects: readonly HomeProject[], items: readonly QueueItem[], sessions: readonly PlanningSession[]): { active: Row[]; finished: HomeProject[] } {
  const active: Row[] = [];
  const finished: HomeProject[] = [];
  for (const project of projects) {
    const needs = items.filter((need) => need.slug === project.slug);
    if (needs.length === 0 && (project.state === "done" || project.state === "archived")) finished.push(project);
    else active.push({ kind: "project", project, needs });
  }
  for (const session of sessions) active.push({ kind: "planning", session });
  return { active: active.sort((x, y) => rankOf(x) - rankOf(y)), finished };
}

const matches = (texts: readonly string[], needle: string) => needle === "" || texts.some((text) => text.toLowerCase().includes(needle));

/** The width of the element given to the returned ref, from a ResizeObserver; 0 where none runs (jsdom). */
function useWidth(): [number, (element: HTMLElement | null) => void] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (element === null || typeof ResizeObserver === "undefined") return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [width, setElement];
}

// ---- the four numbers

function Stat({ id, big, label, extra, attention = false }: { id: string; big: ReactNode; label: string; extra: ReactNode; attention?: boolean }) {
  return (
    <div data-home-number={id} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 border-[var(--loom-line)] px-3.5 py-3 [&:nth-child(n+2)]:border-l @max-3xl/loom:[&:nth-child(3)]:border-l-0 @max-3xl/loom:[&:nth-child(n+3)]:border-t @max-md/loom:grid-cols-1 @max-md/loom:items-start @max-md/loom:gap-y-1.5 @max-md/loom:px-3">
      <span className="grid justify-items-start">
        <span data-number className="loom-num text-[34px] leading-none font-bold tracking-tight @max-xl/loom:text-[30px]">{big}</span>
        {attention && <span aria-hidden className="mt-1 h-[3px] w-full rounded-full bg-[var(--attention)]" />}
      </span>
      <span className="grid min-w-0 gap-0.5">
        <span className="text-xs font-semibold">{label}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-[var(--loom-muted)]">{extra}</span>
      </span>
    </div>
  );
}

type Totals = HomeView["totals"];

/** Never an unknown shown as zero, as Insights reads it: "—" before any thread started, "not recorded" when none reported. */
const tokensBig = (totals: Totals) => (totals.tokenThreads === 0 ? "—" : totals.tokensUnreported >= totals.tokenThreads ? "not recorded" : compact.format(totals.tokens));

function TokensNote({ totals }: { totals: Totals }) {
  const some = totals.tokenThreads > 0 && totals.tokensUnreported < totals.tokenThreads;
  return (
    <span data-cost-unrecorded>
      {some && totals.perDoneTicket !== null && `≈ ${compact.format(Math.round(totals.perDoneTicket))} per done ticket · `}
      {some && totals.tokensUnreported > 0 && <span data-tokens-unreported className="text-[var(--loom-warn)]">{`${totals.tokensUnreported} of ${plural(totals.tokenThreads, "thread")} unreported · `}</span>}
      cost not recorded yet
    </span>
  );
}

function Numbers({ home, queue }: { home: HomeView; queue: readonly QueueItem[] }) {
  const { totals } = home;
  const known = queue.flatMap((item) => (item.startedAt === null ? [] : [item.startedAt]));
  const oldest = known.length === 0 ? null : Math.min(...known);
  const before = totals.doneByDay.slice(0, 7).reduce((sum, day) => sum + day, 0);
  return (
    <section aria-label="Today" className={CARD}>
      <div className="grid grid-cols-4 @max-3xl/loom:grid-cols-2">
        <Stat id="needs" big={queue.length} label="need you" attention={queue.length > 0} extra={queue.length === 0 ? "nothing waits" : oldest === null ? "age unknown" : `oldest ${formatDuration(home.now - oldest)}`} />
        <Stat
          id="running"
          big={totals.running}
          label="running"
          extra={
            <>
              <span title={`${plural(totals.workers, "worker")} and ${plural(totals.reviewers, "reviewer")} alive; one waiting in review or on its pull request holds no slot`}>{`${totals.busy} of ${totals.slots} slots busy`}</span>
              {totals.paused > 0 && <span>{`· ${totals.paused} paused`}</span>}
            </>
          }
        />
        <Stat
          id="done"
          big={totals.doneLast7}
          label="done this week"
          extra={
            <>
              <Spark values={totals.doneByDay} label="Tickets done per day across projects, last 14 days" />
              <span>{`${before} the week before`}</span>
            </>
          }
        />
        <Stat id="tokens" big={tokensBig(totals)} label="tokens" extra={<TokensNote totals={totals} />} />
      </div>
    </section>
  );
}

// ---- Needs you

/** What the row names first: the ticket, the version, or the project. */
function itemLabel(item: QueueItem): string {
  if (item.key !== null) return item.key;
  if ((item.kind === "approve" || item.kind === "pending") && item.version !== null) return `${item.projectKey} v${item.version}`;
  if (item.kind === "ask") return `${item.projectKey} ask`;
  return item.projectKey;
}

const prOf = (url: string | null) => (url === null ? null : /\/(\d+)\/?$/u.exec(url)?.[1] ?? null);

/** The row's short facts after its state word. */
function itemFacts(item: QueueItem): string[] {
  switch (item.kind) {
    case "blocked": {
      const unblocks = item.unblocks;
      if (unblocks === null || unblocks.all === 0) return [];
      return [`unblocks ${unblocks.direct.length}`, ...(unblocks.all > unblocks.direct.length ? [`${unblocks.all} in all`] : [])];
    }
    case "failed":
      return item.keys.length > 1 ? [plural(item.keys.length, "ticket"), item.text] : [item.text];
    case "ask":
      return item.sources.length > 1 ? [item.sources[0]!, `with ${item.sources[1]!.replace(/ waits for approval$/u, "")}'s approval`] : [item.sources[0]!];
    case "merge":
      return [prOf(item.prUrl) === null ? "" : `#${prOf(item.prUrl)}`, item.sha === null ? "" : item.sha.slice(0, 7)].filter((fact) => fact !== "");
    case "draft":
      return prOf(item.prUrl) === null ? [] : [`#${prOf(item.prUrl)}`];
    default:
      return [item.text];
  }
}

function itemTitle(item: QueueItem, projects: ReadonlyMap<string, HomeProject>): string {
  if (item.title !== null) return item.title;
  return item.slug === null ? item.project : (projects.get(item.slug)?.name ?? item.project);
}

/** The in-place answer for an item that does not need its own page. */
function Reader({ item, go, onDone, docked = false }: { item: QueueItem; go(subPath: string): void; onDone?(): void; docked?: boolean }) {
  const open = (subPath: string, view?: Parameters<typeof projectViews.put>[1]) => {
    if (view !== undefined && item.slug !== null) projectViews.put(item.slug, view);
    go(subPath);
  };
  const facts = (
    <p className="text-xs text-[var(--loom-muted)] [overflow-wrap:anywhere]">
      {item.meanwhile !== null && <>{item.meanwhile} </>}
      {item.clears}
      <span className="block">From: {item.sources.join(" · ")}</span>
    </p>
  );
  let body: ReactNode = null;
  if (item.kind === "paused" && item.slug !== null) body = <PausedReader item={item} slug={item.slug} open={open} onDone={onDone} />;
  else if (item.kind === "ask" && item.slug !== null) body = <AskReader item={item} slug={item.slug} go={go} />;
  else if (item.kind === "merge" && item.key !== null && item.prUrl !== null && item.sha !== null)
    body = (
      <>
        <MergeConfirm ticketKey={item.key} confirm={{ prUrl: item.prUrl, sha: item.sha, ready: true, waiting: null, confirmed: false, requested: item.startedAt === null ? null : { at: item.startedAt, note: item.text } }} />
        <Opens>
          <button type="button" className={BUTTON} onClick={() => open(`${item.slug}/${item.key}`)}>
            Open {item.key}
          </button>
        </Opens>
      </>
    );
  else if (item.kind === "draft" && item.key !== null)
    body = (
      <>
        <DraftHold ticketKey={item.key} prUrl={item.prUrl} draft="held" requested={item.startedAt === null ? null : { at: item.startedAt, note: item.text }} />
        <Opens>
          <button type="button" className={BUTTON} onClick={() => open(`${item.slug}/${item.key}`)}>
            Open {item.key}
          </button>
        </Opens>
      </>
    );
  else if ((item.kind === "wrongBase" || item.kind === "rollout") && item.slug !== null) body = <AckReader item={item} slug={item.slug} open={open} />;
  return (
    // The tint is laid on Loom's card, not on the open row's selected tint: two tints under muted text measured 4.01:1 in gruvbox dark.
    <div data-need-reader={item.id} className={docked ? "grid gap-2" : "grid gap-2 border-t border-[var(--loom-line)] [background:linear-gradient(var(--loom-att-tint),var(--loom-att-tint))_var(--loom-card)] px-3 py-2.5"}>
      {body}
      {item.kind !== "ask" && facts}
    </div>
  );
}

/** A reader's buttons; in the phone reader they dock at the bottom with the answer. */
const Opens = ({ children }: { children: ReactNode }) => (
  <Docked>
    <div data-reader-opens className="flex flex-wrap items-center gap-2">
      {children}
    </div>
  </Docked>
);

function PausedReader({ item, slug, open, onDone }: { item: QueueItem; slug: string; open(subPath: string, view?: "work" | "spec"): void; onDone?(): void }) {
  const { busy, run } = useControl(slug);
  return (
    <>
      <p className="text-sm [overflow-wrap:anywhere]">{item.text}</p>
      <Opens>
        <ActionButton primary label={`Resume ${item.projectKey}`} icon={<Icon name="Play" aria-hidden className="size-3.5" />} disabled={busy} onClick={() => void run("resume").then(() => onDone?.())} />
        {/* A new version lifts a budget or a deadline; any other pause is read on the project's own page. */}
        {item.budget ? (
          <button type="button" className={BUTTON} onClick={() => open(slug, "spec")}>
            Change the budget in Spec
          </button>
        ) : (
          <button type="button" className={BUTTON} onClick={() => open(slug, "work")}>
            Open {item.projectKey}
          </button>
        )}
      </Opens>
    </>
  );
}

function AckReader({ item, slug, open }: { item: QueueItem; slug: string; open(subPath: string, view?: "ship"): void }) {
  const ackBadge = useLoomWrite("ackBadge");
  const { busy, act } = useAction();
  const tab = item.kind === "wrongBase" ? "merge" : "rollout";
  return (
    <>
      <ul className="grid gap-0.5 text-sm">
        {item.text.split(" · ").map((line, index) => (
          <li key={index} className="flex gap-1.5 [overflow-wrap:anywhere]">
            <Icon name={item.kind === "rollout" ? "AlertTriangle" : "GitBranch"} aria-hidden className="mt-0.5 size-3.5 shrink-0 text-[var(--loom-warn)]" />
            {line}
          </li>
        ))}
      </ul>
      <Opens>
        <button type="button" className={BUTTON} onClick={() => open(slug, "ship")}>
          Open Ship
        </button>
        <ActionButton label="Acknowledge" title="Hides it until something new comes up; it does not resolve it" disabled={busy} onClick={() => void act(() => ackBadge({ slug, tab, items: [...item.ackItems], confirm: true }), "Hidden until something new comes up")} />
      </Opens>
    </>
  );
}

/** The planner's ask, as Planner draws it: each step with its own action, Mark done and Set aside. */
function AskReader({ item, slug, go }: { item: QueueItem; slug: string; go(subPath: string): void }) {
  const project = useLoom("project", { slug });
  const threadId = project.data?.overview.plannerThreadId ?? "";
  const planner = useLoom("plannerView", { threadId }, { enabled: threadId !== "" });
  const dismissAsk = useLoomWrite("dismissAsk");
  const askStepDone = useLoomWrite("askStepDone");
  const { busy, act } = useAction();
  const { busy: controlling, run } = useControl(slug);
  const view = project.data;
  const ask = planner.data?.ask ?? null;
  if (view === undefined || planner.data === undefined) {
    const error = project.error ?? planner.error;
    return error === null ? <p role="status" className="text-xs text-[var(--loom-muted)]">Loading the ask…</p> : <p role="alert" className="text-xs text-[var(--loom-bad)]">Could not load the ask: {error}</p>;
  }
  if (ask === null || !ask.open || ask.id !== item.ask) return <p className="text-xs text-[var(--loom-muted)]">The planner's ask has changed. Open Planner for its newest one.</p>;
  return (
    <AsksCard
      ask={ask}
      project={view}
      versions={planner.data?.versions ?? []}
      busy={busy || controlling}
      onControl={(action, version) => void run(action, version)}
      onSpec={() => {
        projectViews.put(slug, "spec");
        go(slug);
      }}
      onTicket={(key) => go(`${slug}/${key}`)}
      onDismiss={() => void act(() => dismissAsk({ slug, ask: ask.id, confirm: true }), "Set aside until the planner asks again")}
      onStepDone={(index) => void act(() => askStepDone({ slug, ask: ask.id, step: index, confirm: true }), `Step ${index + 1} marked done`)}
    />
  );
}

function QueueRow({ item, now, projects, open, onToggle, go, phone }: { item: QueueItem; now: number; projects: ReadonlyMap<string, HomeProject>; open: boolean; onToggle(): void; go(subPath: string): void; phone: boolean }) {
  const navigate = useBbNavigate();
  const inPlace = IN_PLACE.includes(item.kind);
  const facts = itemFacts(item);
  const label = itemLabel(item);
  const title = itemTitle(item, projects);
  const activate = () => {
    if (inPlace) return onToggle();
    if (item.kind === "blocked" && item.key !== null) focusNote.set(item.key);
    const route = needRoute(item);
    if (route === null) navigate.toThread(item.threadId!);
    else go(route);
  };
  const tone = item.kind === "rollout" ? "text-[var(--loom-warn)]" : item.kind === "land" ? "text-[var(--loom-ok)]" : "text-[var(--attention)]";
  return (
    <li data-need={item.kind} data-need-id={item.id} className={open ? "bg-[var(--loom-sel)]" : ""}>
      <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-2 px-3 py-1.5 hover:bg-state-hover">
        <Icon name={QUEUE_ICON[item.kind]} aria-hidden className={`size-4 justify-self-center ${tone}`} />
        <button type="button" data-queue-open aria-expanded={inPlace ? open : undefined} aria-haspopup={inPlace && phone ? "dialog" : undefined} onClick={activate} className={`${ROW_BUTTON} grid gap-px rounded-sm py-0.5`}>
          <span className="flex min-w-0 items-baseline gap-2">
            <b className="shrink-0 font-semibold">{label}</b>
            <span data-content title={title} className="min-w-0 truncate">{title}</span>
          </span>
          <span title={[QUEUE_WORD[item.kind], ...facts].join(" · ")} className="min-w-0 truncate text-xs text-[var(--loom-muted)] @max-xl/loom:line-clamp-2 @max-xl/loom:whitespace-normal">
            <b className="font-semibold text-foreground">{QUEUE_WORD[item.kind]}</b>
            {facts.length > 0 && ` · ${facts.join(" · ")}`}
          </span>
        </button>
        <span data-need-age className={`loom-num text-right text-xs whitespace-nowrap ${item.startedAt === null ? "text-[var(--loom-muted)]" : ""}`}>{ageText(item.startedAt, now)}</span>
      </div>
      {open && !phone && <Reader item={item} go={go} onDone={onToggle} />}
    </li>
  );
}

/** j and k (and the arrows) move between the queue's rows; Enter opens one, as a button does. */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const down = event.key === "j" || event.key === "ArrowDown";
  const up = event.key === "k" || event.key === "ArrowUp";
  if (!down && !up) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-queue-open]")];
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (at === -1) return;
  event.preventDefault();
  buttons[Math.max(0, Math.min(buttons.length - 1, at + (down ? 1 : -1)))]?.focus();
}

export function Queue({ items, now, projects, go }: { items: readonly QueueItem[]; now: number; projects: ReadonlyMap<string, HomeProject>; go(subPath: string): void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const probe = useRef<HTMLElement>(null);
  const phone = useNarrowPage(probe);
  const shown = all ? items : items.slice(0, QUEUE_SHOWN);
  const flood = floodText(items, now);
  const reading = phone ? (items.find((item) => item.id === open) ?? null) : null;
  return (
    <section ref={probe} aria-label="Needs you" data-needs-queue className={CARD} data-att={items.length > 0 ? "true" : undefined}>
      <header className="flex flex-wrap items-center gap-2 px-3 pt-2.5 pb-1.5">
        <h2 className={H2}>Needs you</h2>
        <span className={items.length > 0 ? ATT_COUNT : PLAIN_COUNT}>{items.length}</span>
        {flood !== null && (
          <span role="status" className="text-xs font-semibold text-[var(--loom-warn)]">
            {flood}
          </span>
        )}
        <span className="flex-1" />
        <span className="flex items-center gap-1 text-[11px] text-[var(--loom-muted)] @max-xl/loom:hidden" aria-hidden>
          <kbd className={KBD}>j</kbd>
          <kbd className={KBD}>k</kbd>
          <kbd className={KBD}>Enter</kbd>
        </span>
      </header>
      {items.length === 0 ? (
        <p className="flex items-center gap-2 px-3 pb-3 text-sm text-[var(--loom-muted)]">
          <Icon name="CircleCheck" aria-hidden className="size-4 text-[var(--loom-ok)]" />
          Nothing needs you
        </p>
      ) : (
        <ul aria-label="Needs you, oldest first" onKeyDown={moveFocus} className="pb-1.5">
          {shown.map((item) => (
            <QueueRow key={item.id} item={item} now={now} projects={projects} open={open === item.id} phone={phone} onToggle={() => setOpen(open === item.id ? null : item.id)} go={go} />
          ))}
        </ul>
      )}
      {items.length > QUEUE_SHOWN && (
        <button type="button" aria-expanded={all} onClick={() => setAll(!all)} className={`${ROW_BUTTON} mx-3 mb-2 min-h-6 text-xs underline underline-offset-2 @max-xl/loom:min-w-11 pointer-coarse:min-w-11`}>
          {all ? "Fewer" : `${items.length - QUEUE_SHOWN} more`}
        </button>
      )}
      {reading !== null && (
        <PhoneReader
          item={reading}
          title={`${itemLabel(reading)} · ${QUEUE_WORD[reading.kind]}`}
          go={go}
          onClose={() => {
            setOpen(null);
            // Back lands on the row it opened from, where the queue was.
            requestAnimationFrame(() => [...(probe.current?.querySelectorAll<HTMLElement>("[data-need-id]") ?? [])].find((row) => row.dataset.needId === reading.id)?.querySelector<HTMLElement>("[data-queue-open]")?.focus({ preventScroll: true }));
          }}
        />
      )}
    </section>
  );
}

/** On a phone, an item answered in place opens full screen, its answer docked at the bottom; Back closes it where the queue was. */
function PhoneReader({ item, title, go, onClose }: { item: QueueItem; title: string; go(subPath: string): void; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [dock, setDock] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const node = dialog.current;
    if (node === null) return;
    if (typeof node.showModal === "function" && !node.open) node.showModal();
    return () => {
      if (node.open) node.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={title}
      onClose={onClose}
      // Escape is Back here: bb's own Escape on a phone would close the whole Loom page.
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      data-phone-reader className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none bg-background p-0 text-foreground backdrop:bg-black/35">
      <div data-loom-root className="flex h-full flex-col">
        <header className="flex min-h-12 items-center gap-2 border-b border-[var(--loom-line)] px-2">
          <button type="button" onClick={onClose} className={`${ROW_BUTTON} inline-flex min-w-11 items-center justify-center gap-1 rounded-md px-2 text-sm`}>
            <Icon name="ChevronLeft" aria-hidden className="size-4" />
            Back
          </button>
          <h2 className="min-w-0 truncate text-sm font-semibold">{title}</h2>
        </header>
        <AnswerDockProvider value={dock}>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {/* An ask's card lists its steps itself; its title is those steps again. */}
            {item.kind !== "ask" && <p className="mb-2 text-sm [overflow-wrap:anywhere]">{item.title ?? item.project}</p>}
            <Reader item={item} go={go} onDone={onClose} docked />
          </div>
        </AnswerDockProvider>
        {/* The answer region: what answers the item, armed state included, in thumb reach. */}
        <footer ref={setDock} aria-label="Answer" data-answer-dock className="grid shrink-0 gap-2 border-t border-[var(--loom-line)] bg-background px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] empty:hidden" />
      </div>
    </dialog>
  );
}

// ---- Since you looked

const LOOKED_KEY = "loom.home.lookedAt";
const DAY = 86_400_000;

function lookedAt(): number | null {
  try {
    const value = Number(localStorage.getItem(LOOKED_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function markLooked(at: number): void {
  try {
    localStorage.setItem(LOOKED_KEY, String(at));
  } catch {}
}

const KIND_SHOWN: Record<FeedKind, { icon: string; word: string; tone: string }> = {
  shipped: { icon: "GitMerge", word: "Shipped", tone: "text-[var(--loom-ok)]" },
  sentBack: { icon: "ArrowTurnBackward", word: "Sent back", tone: "text-[var(--loom-bad)]" },
  blocked: { icon: "AlertCircle", word: "Blocked", tone: "text-[var(--attention)]" },
  asks: { icon: "MessageQuestion", word: "Asks", tone: "text-[var(--attention)]" },
  phase: { icon: "CircleCheck", word: "Phase closed", tone: "" },
  you: { icon: "UserRound", word: "You", tone: "" },
};
const KIND_ORDER: readonly FeedKind[] = ["shipped", "sentBack", "blocked", "asks", "phase", "you"];
const SINCE_SHOWN = 6;

/** "14:05" today, "Tue 14:05" this week, "Nov 3" before. */
function whenText(at: number, now: number): string {
  const date = new Date(at);
  if (new Date(now).toDateString() === date.toDateString()) return clockTime(at);
  if (now - at < 6 * DAY) return `${date.toLocaleDateString([], { weekday: "short" })} ${clockTime(at)}`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Since you looked: the time is read once per visit, and the visit counts as looked when you leave Home. */
export function useLookedAt(now: number): { since: number; first: boolean } {
  const [since] = useState(() => {
    const stored = lookedAt();
    return { since: stored ?? now - DAY, first: stored === null };
  });
  useEffect(() => {
    const leave = () => markLooked(Date.now());
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, []);
  return since;
}

export function Since({ now, go }: { now: number; go(subPath: string): void }) {
  const { since, first } = useLookedAt(now);
  const [kind, setKind] = useState<FeedKind | null>(null);
  const [more, setMore] = useState(false);
  const [limit, setLimit] = useState(HOME_FEED_LIMIT);
  // The server filters by kind and sends the newest `limit` of them, so a count always has its events behind it.
  const feed = useLoom("homeFeed", { since, kind, limit }, { keep: true });
  const data: HomeFeed | undefined = feed.data;
  const total = data === undefined ? 0 : KIND_ORDER.reduce((sum, each) => sum + data.counts[each], 0);
  const rows = (data?.rows ?? []).filter((row) => kind === null || row.kind === kind);
  const shown = more ? rows : rows.slice(0, SINCE_SHOWN);
  const older = data === undefined ? 0 : data.matched - rows.length;
  const pick = (next: FeedKind | null) => {
    setKind(next);
    setLimit(HOME_FEED_LIMIT);
  };
  const open = (row: HomeFeedRow) => go(row.ticketKey === null ? row.slug : `${row.slug}/${row.ticketKey}`);
  return (
    <section aria-label="Since you looked" data-since className={CARD}>
      <header className="flex flex-wrap items-center gap-2 px-3 pt-2.5 pb-1.5">
        <h2 className={H2}>{first ? "Last 24 hours" : `Since ${whenText(since, now)}`}</h2>
        <span className={PLAIN_COUNT}>{total}</span>
        <span className="flex-1" />
        <span className="inline-flex items-center gap-1 text-[11px] text-[var(--loom-muted)]">
          <Icon name="Eye" aria-hidden className="size-3.5" />
          seen when you leave
        </span>
      </header>
      {data === undefined ? (
        feed.error === null ? (
          <p role="status" className="px-3 pb-3 text-xs text-[var(--loom-muted)]">Loading what happened…</p>
        ) : (
          <p role="alert" className="px-3 pb-3 text-xs text-[var(--loom-bad)]">Could not load what happened: {feed.error}</p>
        )
      ) : (
        <>
          {total === 0 ? (
            // A project read only in part may hold older events of these kinds, so "nothing new" would not be true there.
            <p className="px-3 pb-3 text-sm text-[var(--loom-muted)]">{data.partial.length === 0 ? `Nothing new${first ? " in the last day" : " since then"}.` : "None in the events Loom read."}</p>
          ) : (
            <>
              <div role="group" aria-label="Event kinds" className="flex flex-wrap gap-1.5 px-3 pb-2">
                {KIND_ORDER.filter((each) => data.counts[each] > 0).map((each) => (
                  <button
                    key={each}
                    type="button"
                    aria-pressed={kind === each}
                    aria-label={`${KIND_SHOWN[each].word}, ${data.counts[each]}`}
                    title={KIND_SHOWN[each].word}
                    onClick={() => pick(kind === each ? null : each)}
                    className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @max-xl/loom:h-11 @max-xl/loom:min-w-11 pointer-coarse:h-11 pointer-coarse:min-w-11 @max-xl/loom:justify-center ${kind === each ? "bg-[var(--loom-sel)] shadow-[var(--loom-lum-sel)]" : "bg-surface-recessed hover:bg-state-hover"}`}
                  >
                    <Icon name={KIND_SHOWN[each].icon} aria-hidden className={`size-3.5 ${KIND_SHOWN[each].tone}`} />
                    <span className="loom-num font-semibold">{data.counts[each]}</span>
                  </button>
                ))}
              </div>
              <ul aria-label={kind === null ? "Events, newest first" : `${KIND_SHOWN[kind].word} events, newest first`} className="pb-1.5">
                {shown.map((row) => (
                  <li key={row.id}>
                    <button type="button" onClick={() => open(row)} className={`${ROW_BUTTON} grid w-full grid-cols-[1rem_3.75rem_minmax(0,1fr)] items-start gap-2 px-3 py-1 text-xs hover:bg-state-hover`}>
                      <Icon name={KIND_SHOWN[row.kind].icon} aria-hidden className={`mt-px size-3.5 ${KIND_SHOWN[row.kind].tone}`} />
                      <span className="loom-num text-[var(--loom-muted)]">{whenText(row.at, now)}</span>
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        <b className="font-semibold">{row.ticketKey ?? row.projectKey}</b> {row.text}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center gap-x-3 px-3 pb-2 empty:hidden">
                {rows.length > SINCE_SHOWN && (
                  <button type="button" aria-expanded={more} onClick={() => setMore(!more)} className={`${ROW_BUTTON} min-h-6 text-xs underline underline-offset-2 @max-xl/loom:min-w-11 pointer-coarse:min-w-11`}>
                    {more ? "Fewer" : `${rows.length - SINCE_SHOWN} earlier`}
                  </button>
                )}
                {more && older > 0 && limit < HOME_FEED_MAX && (
                  <button type="button" data-feed-more onClick={() => setLimit(Math.min(HOME_FEED_MAX, limit + HOME_FEED_LIMIT))} className={`${ROW_BUTTON} min-h-6 text-xs underline underline-offset-2 @max-xl/loom:min-w-11 pointer-coarse:min-w-11`}>
                    {`Load ${Math.min(older, HOME_FEED_LIMIT)} more · ${older} not shown yet`}
                  </button>
                )}
                {more && older > 0 && limit >= HOME_FEED_MAX && <span className="text-xs text-[var(--loom-muted)]">{`${older} older ones are on each project's History`}</span>}
              </div>
            </>
          )}
          {data.partial.length > 0 && (
            <ul data-feed-partial aria-label="Not counted" className="grid gap-1 border-t border-[var(--loom-line)] px-3 py-2 text-xs text-[var(--loom-warn)]">
              {data.partial.map((each) => (
                <li key={each.slug} className="flex flex-wrap items-center gap-x-2">
                  <span>{`${each.projectKey}: counted from ${whenText(each.from, now)}; earlier events are not in these counts.`}</span>
                  <button
                    type="button"
                    onClick={() => {
                      projectViews.put(each.slug, "history");
                      go(each.slug);
                    }}
                    className={`${ROW_BUTTON} min-h-6 text-xs text-foreground underline underline-offset-2 @max-xl/loom:min-w-11 pointer-coarse:min-w-11`}
                  >
                    {`Open ${each.projectKey}'s History`}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

// ---- Projects

function projectFacts(project: HomeProject): string[] {
  const open = project.progress.total - project.progress.done;
  const facts = project.phase === null ? (project.progress.total === 0 ? [project.state === "draft" ? "no tickets yet" : "no tickets"] : [`${open} open`]) : [`phase ${project.phase.index + 1} of ${project.phase.count}`, `${project.phase.done}/${project.phase.total}`];
  if (project.failed > 0) facts.push(`${project.failed} failed`);
  return facts;
}

const PILL = "inline-flex h-5 shrink-0 items-center gap-1.5 justify-self-start rounded-full border border-[var(--loom-line)] px-2 text-[11px] font-semibold whitespace-nowrap";

function StatePill({ project }: { project: HomeProject }) {
  const word = stateWord(project);
  const dot = project.state === "running" ? "bg-primary" : project.state === "paused" ? "bg-[var(--loom-warn)]" : project.state === "done" ? "bg-[var(--loom-ok)]" : "bg-[var(--loom-muted)]";
  return (
    <span data-state-badge={project.state} title={project.reason ?? undefined} className={PILL}>
      <span aria-hidden className={`size-1.5 rounded-full ${dot}`} />
      {word}
    </span>
  );
}

// The list is the grid and each row its subgrid, so the columns line up across rows: the name takes the free width
// first, the bar and the facts give way, and a state pill keeps its words.
const PROJECT_COLUMNS = "grid grid-cols-[minmax(0,1fr)_minmax(4.5rem,7rem)_auto_minmax(0,7.5rem)_1.5rem_auto] gap-x-3 @max-4xl/loom:grid-cols-[minmax(0,1fr)_minmax(4rem,7rem)_auto_1.5rem_auto] @max-xl/loom:grid-cols-[minmax(0,1fr)_auto_1.5rem]";
const PROJECT_GRID = "col-span-full grid grid-cols-subgrid items-center";

function ProjectRow({ project, needs, now, go }: { project: HomeProject; needs: readonly QueueItem[]; now: number; go(subPath: string): void }) {
  const threads = threadsOfCounts(project.ticketCounts);
  const done = threads.filter((thread) => thread === "done").length;
  const label = `${project.key} ${project.name}`;
  return (
    <li data-project-row={project.slug} data-attention={needs.length > 0 ? "true" : undefined} className={`${PROJECT_GRID} px-3 py-1.5 hover:bg-state-hover @max-xl/loom:gap-y-1`}>
      <button type="button" data-project-name onClick={() => go(project.slug)} className={`${ROW_BUTTON} flex items-baseline gap-2 rounded-sm py-0.5`}>
        <b className="shrink-0 font-bold">{project.key}</b>
        <span data-content title={project.name} className="min-w-0 truncate">{project.name}</span>
      </button>
      <span className="flex min-w-0 items-center gap-2 @max-xl/loom:col-span-3 @max-xl/loom:row-start-2">
        <TicketBar threads={threads} height={8} label={`${label}: ${ticketsLabel(threads)}`} className="flex-1" />
        <span className="loom-num shrink-0 text-xs font-semibold">
          {done}/{threads.length}
        </span>
      </span>
      <StatePill project={project} />
      <span data-project-facts title={projectFacts(project).join(" · ")} className="min-w-0 truncate text-xs text-[var(--loom-muted)] @max-4xl/loom:hidden">{projectFacts(project).join(" · ")}</span>
      <span className="justify-self-end">{needs.length > 0 && <span className={ATT_COUNT} aria-label={`${plural(needs.length, "thing")} need${needs.length === 1 ? "s" : ""} you`}>{needs.length}</span>}</span>
      <span className="loom-num text-right text-xs whitespace-nowrap text-[var(--loom-muted)] @max-xl/loom:hidden">{project.lastEventAt === null ? "" : formatDuration(Math.max(0, now - project.lastEventAt))}</span>
    </li>
  );
}

/** A conversation whose planner has not proposed yet, as a project row. */
function PlanningRow({ session, now, go }: { session: PlanningSession; now: number; go(subPath: string): void }) {
  const asking = useWaiting(session.threadId);
  return (
    <li data-planning-row={session.threadId} data-attention={asking ? "true" : undefined} className={`${PROJECT_GRID} px-3 py-1.5 hover:bg-state-hover`}>
      <button type="button" onClick={() => go(`_plan/${session.threadId}`)} className={`${ROW_BUTTON} flex items-center gap-2 rounded-sm py-0.5`}>
        <Icon name="MessageSquare" aria-hidden className="size-3.5 shrink-0 text-[var(--loom-muted)]" />
        <span data-content title={session.title} className="min-w-0 truncate">{session.title}</span>
      </button>
      <span className="text-xs text-[var(--loom-muted)] @max-xl/loom:hidden">no spec yet</span>
      <span data-state-badge="planning" className={PILL}>
        <span aria-hidden className="size-1.5 rounded-full bg-[var(--attention)]" />
        Planning
      </span>
      <span className="min-w-0 truncate text-xs text-[var(--loom-muted)] @max-4xl/loom:hidden">planner is asking questions</span>
      <span className="justify-self-end">{asking && <span className={ATT_COUNT} aria-label="The planner asks you a question">1</span>}</span>
      <span className="loom-num text-right text-xs whitespace-nowrap text-[var(--loom-muted)] @max-xl/loom:hidden">{formatDuration(Math.max(0, now - session.startedAt))}</span>
    </li>
  );
}

const SHOW_FINISHED_KEY = "loom.home.showFinished";

// Storage can be unavailable: then the group starts folded and is not remembered.
function savedShowFinished(): boolean {
  try {
    return localStorage.getItem(SHOW_FINISHED_KEY) === "true";
  } catch {
    return false;
  }
}

function saveShowFinished(show: boolean): void {
  try {
    localStorage.setItem(SHOW_FINISHED_KEY, String(show));
  } catch {}
}

function Projects({ home, queue, sessions, go }: { home: HomeView; queue: readonly QueueItem[]; sessions: readonly PlanningSession[]; go(subPath: string): void }) {
  const [showFinished, setShowFinished] = useState(savedShowFinished);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const rows = homeRows(home.projects, queue, sessions);
  const active = rows.active.filter((row) => matches(row.kind === "planning" ? [row.session.title] : [row.project.name, row.project.key, row.project.slug], needle));
  const finished = rows.finished.filter((project) => matches([project.name, project.key, project.slug], needle));
  // Searching, or with nothing active, the finished projects are what there is to see.
  const forced = needle !== "" || rows.active.length === 0;
  const finishedOpen = forced || showFinished;
  const empty = active.length === 0 ? (needle !== "" && finished.length === 0 ? `No project matches "${query.trim()}".` : needle === "" ? "Every project is done or archived." : null) : null;
  const toggle = () => {
    setShowFinished(!showFinished);
    saveShowFinished(!showFinished);
  };
  return (
    <section aria-label="Projects" data-projects className={CARD}>
      <header className="flex flex-wrap items-center gap-2 px-3 pt-2.5 pb-1.5">
        <h2 className={H2}>Projects</h2>
        <span className={PLAIN_COUNT}>{rows.active.length + rows.finished.length}</span>
        <span className="flex-1" />
        <input type="search" aria-label="Search projects" placeholder="Search projects" value={query} onChange={(event) => setQuery(event.target.value)} className={`${FIELD} ${PHONE_TEXT} h-7 w-48 py-0 text-xs @max-xl/loom:h-11 pointer-coarse:h-11 @max-xl/loom:w-full`} />
      </header>
      <ul aria-label="Projects" className={`${PROJECT_COLUMNS} pb-1`}>
        {empty !== null && (
          <li data-projects-empty className="col-span-full px-3 py-2 text-xs text-[var(--loom-muted)]">
            {empty}
          </li>
        )}
        {active.map((row) => (row.kind === "planning" ? <PlanningRow key={row.session.threadId} session={row.session} now={home.now} go={go} /> : <ProjectRow key={row.project.slug} project={row.project} needs={row.needs} now={home.now} go={go} />))}
      </ul>
      {finished.length > 0 && (
        <div data-finished className="border-t border-[var(--loom-line)] pb-1">
          {forced ? (
            <p className="px-3 py-2 text-xs font-semibold text-[var(--loom-muted)]">Finished · {finished.length}</p>
          ) : (
            <button type="button" aria-expanded={finishedOpen} onClick={toggle} className={`${ROW_BUTTON} flex w-full items-center gap-1.5 px-3 py-2 text-xs font-semibold text-[var(--loom-muted)] hover:bg-state-hover hover:text-foreground`}>
              <Icon name={finishedOpen ? "ChevronDown" : "ChevronRight"} aria-hidden className="size-3.5" />
              Finished · {finished.length}
            </button>
          )}
          {finishedOpen && (
            <ul aria-label="Finished projects" className={PROJECT_COLUMNS}>
              {finished.map((project) => (
                <ProjectRow key={project.slug} project={project} needs={[]} now={home.now} go={go} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

// ---- the page

/** The Loom page's start: the guide while there is nothing yet, else the numbers, the queue, what happened and the projects. */
export function Home({ go }: { go(subPath: string): void }) {
  const home = useLoom("home", null);
  const planning = useLoom("planning", null);
  const queue = useQueue(home.data);
  const [width, measure] = useWidth();
  const ref = useCallback((node: HTMLElement | null) => measure(node), [measure]);
  const error = home.error ?? planning.error;
  if (home.data === undefined || planning.data === undefined || queue === undefined) {
    return error === null ? <p role="status" className="p-4 text-sm text-[var(--loom-muted)]">Loading projects…</p> : <p role="alert" className="p-4 text-sm text-[var(--loom-bad)]">Could not load the projects: {error}</p>;
  }
  // A conversation whose thread proposed already shows as its draft project.
  const sessions = planning.data.filter((session) => session.slug === null);
  if (home.data.projects.length === 0 && sessions.length === 0) return <Guide onStart={() => go("_new")} />;
  const projects = new Map(home.data.projects.map((project) => [project.slug, project]));
  const wide = width >= TWO_COLUMNS;
  const needs = <Queue items={queue} now={home.data.now} projects={projects} go={go} />;
  const since = <Since now={home.data.now} go={go} />;
  const list = <Projects home={home.data} queue={queue} sessions={sessions} go={go} />;
  return (
    <div ref={ref} data-home className="grid gap-3 p-3 @max-xl/loom:gap-2.5 @max-xl/loom:p-2">
      {/* Under 56rem Loom's sidebar is gone, so Home has Insights and the guide; under 36rem bb's title bar drops New project too. */}
      <nav aria-label="Home" className="flex flex-wrap items-center justify-end gap-2 @4xl/loom:hidden">
        <button type="button" className={`${BUTTON} @max-xl/loom:h-11 pointer-coarse:h-11`} onClick={() => go("_guide")}>
          How Loom works
        </button>
        <button type="button" className={`${BUTTON} @max-xl/loom:h-11 pointer-coarse:h-11`} onClick={() => go("_insights")}>
          <Icon name="ChartColumn" aria-hidden className="size-3.5" />
          Insights
        </button>
        <span className="hidden @max-xl/loom:contents">
          <button type="button" className={`${BUTTON_PRIMARY} @max-xl/loom:h-11 pointer-coarse:h-11`} onClick={() => go("_new")}>
            <Icon name="Plus" aria-hidden className="size-3.5" />
            New project
          </button>
        </span>
      </nav>
      <Numbers home={home.data} queue={queue} />
      {wide ? (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] items-start gap-3">
            {needs}
            {since}
          </div>
          {list}
        </>
      ) : (
        <>
          {needs}
          {list}
          {since}
        </>
      )}
    </div>
  );
}
