import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { PrDetails, PrView } from "../contract";
import { runNext, useActions } from "./actions";
import { Avatar } from "./avatar";
import { BoardChips, CHIP_ADD } from "./board-picker";
import { ChangesPane } from "./changes";
import { ChecksPane, checksSummary } from "./checks";
import { BUTTON_PRIMARY, ErrorNote, ICON_GHOST } from "./common";
import { Conversation, threadsOf } from "./conversation";
import { isNotFound, messageOf, useShuttleQuery } from "./data";
import { useEditPr } from "./edit";
import { ago, clock, plural, shortKey } from "./format";
import { HistoryPane } from "./history";
import { LabelChip, LabelChoices } from "./manage";
import { Description, Facts } from "./overview";
import { Picker } from "./picker";
import { isLive, STATE_LOOKS } from "./pills";
import { copy, PrMenu, TrackButton } from "./pr-menu";
import { usePrState, useSeenSince, type PrTab } from "./pr-state";
import { StatusCard } from "./status";
import { YourReviewCard } from "./your-review";

export { TrackButton } from "./pr-menu";

/** From this width a full-page PR puts its people and facts in a column beside the tabs. */
const WIDE_PX = 960;
const TOP_BAR_PX = 44;

function useWidth(node: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (node === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return width;
}

/** The header has scrolled up under the top bar, which then shows the title. */
function useScrolledPast(node: HTMLElement | null): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    if (node === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setPast(entry !== undefined && !entry.isIntersecting && entry.boundingClientRect.top < TOP_BAR_PX), { rootMargin: `-${TOP_BAR_PX}px 0px 0px 0px` });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return past;
}

function StateBadge({ state }: { state: PrView["state"] }) {
  const look = STATE_LOOKS[state];
  return (
    <span data-pr-state={state} className="mr-2 inline-flex h-6 items-center gap-1.5 rounded-full border border-border bg-background px-2 align-middle text-xs font-medium text-foreground">
      <Icon name={look.icon} className={`size-3.5 ${look.className}`} aria-hidden />{look.label}
    </span>
  );
}

function TopBar({ pr, stuck, onClose, onExpand, onCollapse }: { pr: PrView; stuck: boolean; onClose?: () => void; onExpand?: () => void; onCollapse?: () => void }) {
  const actions = useActions();
  return (
    <div data-topbar className={`sticky top-0 z-20 flex h-11 items-center gap-1 border-b bg-background pl-4 pr-2 ${stuck ? "border-border" : "border-transparent"}`}>
      <span className="shrink-0 text-xs text-muted-foreground">{pr.serverName}</span>
      <button type="button" title={`Copy ${pr.key}`} className="min-w-0 shrink cursor-copy truncate font-mono text-xs hover:underline" onClick={() => copy(pr.key, pr.key)}>{shortKey(pr)}</button>
      <span aria-hidden={!stuck} className={`ml-1.5 min-w-0 flex-1 truncate text-[13px] font-semibold transition-opacity ${stuck ? "opacity-100" : "opacity-0"}`}>{pr.title}</span>
      {!pr.mine && <TrackButton pr={pr} />}
      <button type="button" aria-label={`Open on ${pr.serverName}`} title={`Open on ${pr.serverName}`} className={ICON_GHOST} onClick={() => actions.open(pr)}>
        <Icon name="ExternalLink" className="size-4" aria-hidden />
      </button>
      {onExpand && (
        <button type="button" aria-label="Open as a full page" title="Open as a full page" className={ICON_GHOST} onClick={onExpand}>
          <Icon name="Maximize2" fallback="PanelRightOpen" className="size-4" aria-hidden />
        </button>
      )}
      {onCollapse && (
        <button type="button" aria-label="Show beside the list" title="Show beside the list" className={ICON_GHOST} onClick={onCollapse}>
          <Icon name="Minimize2" fallback="PanelRight" className="size-4" aria-hidden />
        </button>
      )}
      <PrMenu pr={pr} />
      {onClose && (
        <button type="button" aria-label="Close details" title="Close" className={ICON_GHOST} onClick={onClose}>
          <Icon name="X" className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}

function Branch({ name }: { name: string }) {
  return <code title={name} className="inline-block max-w-full truncate rounded-sm bg-surface-recessed px-1 align-middle font-mono text-xs leading-5 text-foreground">{name.replace(/-thr_\w+$/u, "…")}</code>;
}

/** Why someone else's PR is in your lists, in a few words. */
function reasonOf(pr: PrView): string | null {
  const has = (reason: string) => pr.reasons.some((item) => item.reason === reason);
  const when = pr.requestedAt === null ? "" : ` ${ago(pr.requestedAt)}`;
  if (has("requested")) return `${pr.author} asked you${when}`;
  if (has("team")) return `${pr.author} asked ${pr.teams.length === 0 ? "your team" : `@${pr.teams[0]}`}${when}`;
  if (has("mentioned")) return `${pr.author} mentioned you`;
  if (pr.tracked) return "You track it";
  return null;
}

function Header({ pr, details, wide }: { pr: PrView; details: PrDetails | null; wide: boolean }) {
  const actions = useActions();
  const edit = useEditPr(pr);
  const canLabel = pr.mine && isLive(pr) && pr.actions.includes("labels");
  const commits = details?.commits?.total ?? null;
  const merger = pr.state === "merged" ? details?.timeline?.find((event) => event.kind === "merged")?.actor ?? null : null;
  // Without the server's merge event nobody is named: the author often is not who merged.
  const anonymous = pr.state === "merged" && merger === null;
  const actor = merger ?? pr.author;
  const you = pr.mine && actor === pr.author;
  const verb = pr.state === "merged" ? "merged" : pr.state === "closed" ? "wanted to merge" : you ? "want to merge" : "wants to merge";
  const meta = [pr.createdAt === null ? null : `Opened ${ago(pr.createdAt)}`, pr.updatedAt === null ? null : `updated ${ago(pr.updatedAt)}`, pr.mine ? null : reasonOf(pr)].filter(Boolean).join(" · ");
  return (
    <header className={wide ? "px-6 pb-4 pt-2" : "px-4 pb-3.5 pt-1"}>
      <h2 className={`font-semibold leading-snug [text-wrap:pretty] ${wide ? "text-xl" : "text-[17px]"}`}>{pr.title}</h2>
      <div className="mt-2 text-[13px] leading-[26px] text-muted-foreground">
        <StateBadge state={pr.state} />
        {anonymous ? "Merged" : (
          <>
            <span className="mr-1 inline-block align-middle"><Avatar login={actor} size={18} bot={pr.bot && actor === pr.author} /></span>
            <b className="font-semibold text-foreground">{you ? "You" : actor}</b> {verb}
          </>
        )}{commits !== null && <> {plural(commits, "commit")}</>}
        {pr.base !== null && <> into <Branch name={pr.base} /></>}
        {pr.headRef !== null && <> from <Branch name={pr.headRef} /></>}
      </div>
      {meta !== "" && <div className="text-xs text-muted-foreground first-letter:uppercase">{meta}</div>}
      {pr.stale && (
        <div className="mt-1.5 text-xs text-warning-text">
          {pr.serverName}'s last sync could not read this PR, so this shows what Shuttle had {pr.staleSince === null ? "before" : `at ${clock(pr.staleSince)}`}.
        </div>
      )}
      <div data-chips className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {(pr.labels ?? []).map((label) => (
          <LabelChip key={label.name} label={label} onRemove={canLabel ? () => edit.apply({ kind: "labels", remove: [label.name] }) : undefined} />
        ))}
        {canLabel && (
          <Picker phone={actions.phone} title="Labels" triggerLabel="Edit labels" triggerClassName={CHIP_ADD} align="start"
            trigger={<><Icon name="Plus" className="size-3" aria-hidden />Label</>}>
            <LabelChoices pr={pr} edit={edit} />
          </Picker>
        )}
        <BoardChips pr={pr} phone={actions.phone} />
      </div>
    </header>
  );
}

interface TabEntry {
  id: PrTab;
  label: string;
  badge?: { text: string; tone: "neutral" | "bad" | "warn" | "info" };
}

/** bb's own count badge (bg-surface-recessed, text-2xs), tinted only when it asks for attention. */
const BADGE_TONES = {
  neutral: "bg-surface-recessed text-muted-foreground",
  bad: "bg-surface-destructive text-destructive-text",
  warn: "bg-warning/10 text-warning-text",
  info: "bg-surface-recessed text-foreground",
} as const;

const tabId = (base: string, tab: PrTab) => `${base}-tab-${tab}`;

/** The tabs, with the keyboard pattern of a tab list: one stop in the Tab order, the arrows, Home and End move between tabs. */
function TabBar({ tabs, current, sticky, inset, barRef, panelId, onTab }: { tabs: readonly TabEntry[]; current: PrTab; sticky: string; inset: boolean; barRef: RefObject<HTMLDivElement | null>; panelId: string; onTab(tab: PrTab): void }) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.findIndex((tab) => tab.id === current);
    const next = event.key === "ArrowRight" ? (at + 1) % tabs.length : event.key === "ArrowLeft" ? (at - 1 + tabs.length) % tabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
    if (next < 0 || at < 0) return;
    event.preventDefault();
    onTab(tabs[next]!.id);
    barRef.current?.querySelector<HTMLElement>(`[data-tab="${tabs[next]!.id}"]`)?.focus();
  };
  return (
    <div ref={barRef} role="tablist" aria-label="Pull request sections" onKeyDown={onKeyDown} className={`sticky ${sticky} z-10 mt-4 flex gap-0.5 overflow-x-auto border-b border-border bg-background [scrollbar-width:none] ${inset ? "px-2.5" : ""}`}>
      {tabs.map((tab) => (
        <button key={tab.id} id={tabId(panelId, tab.id)} type="button" role="tab" aria-selected={tab.id === current} aria-controls={panelId} tabIndex={tab.id === current ? 0 : -1} data-tab={tab.id} onClick={() => onTab(tab.id)}
          className={`-mb-px inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border-b-2 px-2 py-2.5 text-[13px] ${tab.id === current ? "border-foreground font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
          {tab.label}
          {tab.badge && <span className={`rounded-full px-1.5 text-2xs font-normal leading-4 tabular-nums ${BADGE_TONES[tab.badge.tone]}`}>{tab.badge.text}</span>}
        </button>
      ))}
    </div>
  );
}

/** One PR, the same everywhere: who and what, where it stands, then its parts in tabs. On a phone the page's bars carry its main actions. */
export function PrDetail({ prKey, onClose, onExpand, onCollapse, phone = false, page = false }: {
  prKey: string;
  onClose?: () => void;
  /** Beside a list: open the PR as a full page. */
  onExpand?: () => void;
  /** On a full page: put the PR back beside its list. */
  onCollapse?: () => void;
  phone?: boolean;
  /** A full page, which puts people and facts in a column of their own once it is wide enough. */
  page?: boolean;
}) {
  const actions = useActions();
  const detail = useShuttleQuery("detail", { key: prKey });
  const conversation = useShuttleQuery("conversation", { key: prKey });
  const panelId = useId();
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [header, setHeader] = useState<HTMLElement | null>(null);
  const tabBar = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const width = useWidth(page ? root : null);
  const stuck = useScrolledPast(phone ? null : header);
  const since = useSeenSince(prKey);
  const decided = useRef<string | null>(null);
  const loaded = detail.data?.pr.key === prKey;
  const unseen = detail.data?.pr.unseen === true;
  const { markSeen } = actions.writes;
  // Decided by the first load of each PR opened: one that changes while it stays open is not marked seen, so it shows as new next time.
  useEffect(() => {
    if (!loaded || decided.current === prKey) return;
    decided.current = prKey;
    if (unseen) void markSeen([prKey]);
  }, [loaded, unseen, prKey, markSeen]);
  const [storedTab, setTab] = usePrState(prKey, "tab", "overview");
  const { intent } = actions;

  useEffect(() => {
    if (intent === null || intent.key !== prKey) return;
    // The composer and the draft live in their tabs; opening the tab lets them take the intent.
    if (intent.kind === "compose") setTab("conversation");
    if (intent.kind === "draft") setTab("review");
  }, [intent, prKey, setTab]);

  if (detail.data === undefined) {
    return (
      <aside aria-label="Pull request" className="p-4 text-sm text-muted-foreground">
        {detail.error === null ? "Loading…" : (
          <ErrorNote>{isNotFound(detail.error) ? `Shuttle does not know ${prKey}. Look it up in the header to fetch it.` : `Could not load ${prKey}: ${messageOf(detail.error)}`}</ErrorNote>
        )}
      </aside>
    );
  }

  const { pr, body, draft, events } = detail.data;
  const items = conversation.data?.items;
  const details = conversation.data?.details ?? null;
  const conversationError = conversation.data?.error ?? (conversation.error === null ? null : messageOf(conversation.error));
  const lookedUp = pr.next.kind === "looked_up" && !pr.tracked;
  const reviewTab = !pr.mine && isLive(pr);
  const tab: PrTab = storedTab === "review" && !reviewTab ? "overview" : storedTab;
  const wide = page && width >= WIDE_PX;

  const checks = checksSummary(pr, items, details);
  const openThreads = threadsOf((items ?? []).filter((item) => item.kind === "thread")).filter((group) => !group.resolved).length;
  const spoken = (items ?? []).filter((item) => item.kind !== "check").length;
  const tabs: TabEntry[] = [{ id: "overview", label: "Overview" }];
  if (reviewTab) tabs.push({ id: "review", label: "Your review", ...(draft !== null ? { badge: { text: String(draft.findings.length), tone: "info" as const } } : {}) });
  tabs.push({ id: "conversation", label: "Conversation", ...(openThreads > 0 ? { badge: { text: `${openThreads} open`, tone: "warn" as const } } : items !== undefined && spoken > 0 ? { badge: { text: String(spoken), tone: "neutral" as const } } : {}) });
  const checkBadge = checks.counts === null ? (checks.state === "failed" ? { text: "failing", tone: "bad" as const } : null) : checks.counts.failed > 0 ? { text: `${checks.counts.failed} failing`, tone: "bad" as const } : checks.counts.running > 0 ? { text: `${checks.counts.running} running`, tone: "warn" as const } : checks.counts.total > 0 ? { text: String(checks.counts.total), tone: "neutral" as const } : null;
  tabs.push({ id: "checks", label: "Checks", ...(checkBadge !== null ? { badge: checkBadge } : {}) });
  const files = details?.files?.total ?? pr.files;
  tabs.push({ id: "changes", label: "Changes", ...(files !== null ? { badge: { text: files.toLocaleString(), tone: "neutral" as const } } : {}) });
  tabs.push({ id: "history", label: "History" });

  const open = (next: PrTab) => {
    setTab(next);
    // Scrolled into a tab, the next one starts at its top rather than wherever this one was.
    const bar = tabBar.current?.getBoundingClientRect();
    const start = pane.current?.getBoundingClientRect();
    if (bar !== undefined && start !== undefined && start.top < bar.bottom - 1) pane.current?.scrollIntoView?.({ block: "start" });
  };

  let content: ReactNode;
  switch (tab) {
    case "overview": content = <><Description prKey={pr.key} body={body} />{!wide && <Facts pr={pr} details={details} />}</>; break;
    case "review": content = <YourReviewCard pr={pr} draft={draft} />; break;
    case "conversation": content = <Conversation pr={pr} items={items} error={conversationError} phone={phone} since={since} />; break;
    case "checks": content = <ChecksPane pr={pr} items={items} details={details} />; break;
    case "changes": content = <ChangesPane pr={pr} items={items} details={details} />; break;
    case "history": content = <HistoryPane pr={pr} items={items} details={details} events={events} />; break;
  }

  return (
    <article ref={setRoot} aria-label={`Pull request ${shortKey(pr)}`} data-detail={pr.key} data-layout={wide ? "columns" : "single"} className="min-w-0 bg-background pb-10">
      {!phone && <TopBar pr={pr} stuck={stuck} onClose={onClose} onExpand={onExpand} onCollapse={onCollapse} />}
      <div className={page ? "mx-auto w-full max-w-[1320px]" : ""}>
        <div ref={setHeader}><Header pr={pr} details={details} wide={wide} /></div>
        {lookedUp && (
          <div data-looked-up className={`${wide ? "mx-6" : "mx-4"} mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground`}>
            <Icon name="Search" className="size-3.5" aria-hidden />
            <span className="flex-1">Looked up. It is not in any of your lists.</span>
            <button type="button" className={BUTTON_PRIMARY} onClick={() => runNext(actions, pr, "track")}>
              <Icon name="Pin" className="size-3.5" aria-hidden />Track it
            </button>
          </div>
        )}
        <div className={wide ? "grid grid-cols-[minmax(0,1fr)_320px] items-start gap-7 px-6" : ""}>
          <div className="min-w-0">
            <div className={wide ? "" : "px-4"}><StatusCard pr={pr} items={items} details={details} draft={draft} onTab={open} /></div>
            <TabBar tabs={tabs} current={tab} sticky={phone ? "top-0" : "top-11"} inset={!wide} barRef={tabBar} panelId={panelId} onTab={open} />
            <div ref={pane} id={panelId} role="tabpanel" aria-labelledby={tabId(panelId, tab)} className={`scroll-mt-24 pt-4 ${wide ? "" : "px-4"}`}>{content}</div>
          </div>
          {wide && (
            <aside aria-label="About this PR" className="sticky top-14 max-h-[calc(100vh-4.5rem)] overflow-y-auto pb-6 pt-1 [scrollbar-width:none]">
              <Facts pr={pr} details={details} compact />
            </aside>
          )}
        </div>
      </div>
    </article>
  );
}
