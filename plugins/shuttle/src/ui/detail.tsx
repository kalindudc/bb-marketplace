import { toast } from "sonner";
import { useState } from "react";
import { experimental_copyToClipboard, experimental_Icon as Icon, Markdown } from "@get-bb/plugin-sdk/app";
import type { EventView, LinkRole, PrView, ReviewRunView } from "../contract";
import type { WatchMode } from "../config";
import { BUTTON, BUTTON_PRIMARY, ErrorNote, FIELD, ICON_GHOST, Pill, SectionTitle, ServerBadge, Toggle } from "./common";
import { LINK_ROLES, ROLE_LABELS, WATCH_MODES, WATCH_MODE_LABELS } from "./constants";
import { isNotFound, messageOf, useShuttleMutation, useShuttleQuery } from "./data";
import { ago, plural, shortKey } from "./format";
import { ReasonPills, StatePill } from "./pills";
import { LabelsAndReviewers, ManageCard } from "./manage";
import { ReviewButton } from "./review-button";
import { isLive, isReviewable, type PrActions } from "./row";

const SECTION = "border-b border-border px-4 py-3";
const LONG_DESCRIPTION = 1500;

/** The PR's own description, rendered by bb's sanitizing Markdown renderer. */
function Description({ body }: { body: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const long = body !== null && body.length > LONG_DESCRIPTION;
  return (
    <div className={SECTION}>
      <SectionTitle icon="FileText">Description</SectionTitle>
      {body === null ? (
        <div className="text-sm text-muted-foreground">Loading the description…</div>
      ) : body.trim() === "" ? (
        <div className="text-sm text-muted-foreground">No description.</div>
      ) : (
        <>
          <div data-description className={`min-w-0 overflow-x-auto break-words text-sm ${long && !expanded ? "max-h-80 overflow-y-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]" : ""}`}>
            <Markdown content={body} />
          </div>
          {long && (
            <button type="button" className="mt-2 cursor-pointer text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show less" : "Show the whole description"}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function ReviewRun({ run, pr, actions }: { run: ReviewRunView | null; pr: PrView; actions: PrActions }) {
  if (run === null) {
    if (!isReviewable(pr)) return null;
    return (
      <div className={SECTION}>
        <SectionTitle icon="Bot">Review</SectionTitle>
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background p-3">
          <span className="flex-1 text-sm text-muted-foreground">No review yet. Review runs your default preset.</span>
          <button type="button" className={BUTTON} onClick={() => actions.customize(pr)}>Pick a preset…</button>
        </div>
      </div>
    );
  }
  const who = run.trigger === "auto" ? "Auto review" : "Review";
  const headline = run.state === "running" ? `${who} running` : run.state === "failed" ? `${who} failed` : `${who} finished`;
  return (
    <div className={SECTION}>
      <SectionTitle icon="Bot">Last review</SectionTitle>
      <div data-last-review={run.state} className={`rounded-lg border p-3 ${run.state === "failed" ? "border-destructive/40" : "border-ring/40 bg-ring/5"}`}>
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <Icon name="Bot" className="size-3.5" aria-hidden />
          <b>{headline}</b>
          <span className="text-xs text-muted-foreground">{ago(run.at)}</span>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {run.preset} in “{run.title}”{run.head ? <> on <span className="font-mono">{run.head.slice(0, 7)}</span></> : null}
          {run.head !== null && pr.head !== null && run.head !== pr.head && " · the PR has new commits since"}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className={run.state === "done" ? BUTTON_PRIMARY : BUTTON} onClick={() => actions.openThread(run.threadId)}>
            <Icon name="MessageSquare" className="size-3.5" aria-hidden />
            {run.state === "done" ? "Choose what to post" : "Open the review thread"}
          </button>
          {isReviewable(pr) && run.state !== "running" && (
            <button type="button" className={BUTTON} onClick={() => actions.customize(pr)}>{run.state === "failed" ? "Try again…" : "Review again…"}</button>
          )}
        </div>
      </div>
    </div>
  );
}

function EventLine({ event, onOpenThread }: { event: EventView; onOpenThread(threadId: string): void }) {
  return (
    <li className="relative pb-3 pl-4 before:absolute before:left-[-5px] before:top-1.5 before:size-2 before:rounded-full before:border before:border-muted-foreground before:bg-card">
      <div className="text-sm">{event.text}</div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{ago(event.at)}</span>
        {event.threadId !== null && (
          <button type="button" className="cursor-pointer underline-offset-2 hover:underline" onClick={() => onOpenThread(event.threadId!)}>Open thread</button>
        )}
      </div>
    </li>
  );
}

/** One PR. On a phone the page's top and bottom bars carry its actions, so `phone` leaves them out here. */
export function PrDetail({ prKey, actions, onClose, phone = false }: { prKey: string; actions: PrActions; onClose?: () => void; phone?: boolean }) {
  const detail = useShuttleQuery("detail", { key: prKey });
  const link = useShuttleMutation("link");
  const unlink = useShuttleMutation("unlink");
  const dismiss = useShuttleMutation("dismiss");
  const busy = link.isPending || unlink.isPending || dismiss.isPending;

  if (detail.data === undefined) {
    return (
      <aside aria-label="Pull request" className="p-4 text-sm text-muted-foreground">
        {detail.error === null ? "Loading…" : (
          <ErrorNote>{isNotFound(detail.error) ? `Shuttle does not know ${prKey}. Look it up in the header to fetch it.` : `Could not load ${prKey}: ${messageOf(detail.error)}`}</ErrorNote>
        )}
      </aside>
    );
  }
  const { pr, events, body } = detail.data;
  const copyKey = async () => {
    if (await experimental_copyToClipboard({ text: pr.key })) toast.success(`Copied ${pr.key}`);
    else toast.error("Could not copy the key");
  };

  return (
    <aside aria-label={`Pull request ${shortKey(pr)}`} data-detail={pr.key} className="min-w-0 bg-card">
      <div className={SECTION}>
        <div className="flex items-center gap-2">
          <ServerBadge name={pr.serverName} large />
          <span className="truncate font-mono text-xs">{shortKey(pr)}</span>
          <StatePill state={pr.state} />
          <span className="flex-1" />
          {!phone && (
            <button type="button" aria-label="Copy key" title={`Copy ${pr.key}`} className={ICON_GHOST} onClick={() => void copyKey()}>
              <Icon name="Copy" className="size-3.5" aria-hidden />
            </button>
          )}
          {onClose && (
            <button type="button" aria-label="Close details" className={ICON_GHOST} onClick={onClose}>
              <Icon name="X" className="size-4" aria-hidden />
            </button>
          )}
        </div>
        <h3 className="mb-1 mt-2 text-[15px] font-semibold leading-snug">{pr.title}</h3>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>{pr.mine ? "you" : pr.author}</span>
          {pr.headRef !== null && <span className="font-mono text-[11px]">· {pr.headRef}{pr.base !== null && ` → ${pr.base}`}</span>}
          {pr.files !== null && <span>· {plural(pr.files, "file")}</span>}
          {pr.additions !== null && <span className="text-success">+{pr.additions.toLocaleString()}</span>}
          {pr.deletions !== null && <span className="text-destructive">−{pr.deletions.toLocaleString()}</span>}
        </div>
        {pr.stale && <div className="mt-2 text-xs text-warning-text">{pr.serverName}'s last sync failed, so this may be out of date.</div>}
        {!phone && <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={BUTTON_PRIMARY} onClick={() => actions.open(pr)}>
            <Icon name="ExternalLink" className="size-3.5" aria-hidden />
            Open on {pr.serverName}
          </button>
          {isReviewable(pr) && <ReviewButton pr={pr} presets={actions.presets} onCustomize={actions.customize} />}
          <button type="button" className={BUTTON} onClick={() => actions.link(pr)}>
            <Icon name="Link" className="size-3.5" aria-hidden />
            Link a thread
          </button>
        </div>}
      </div>

      {pr.needs !== null && (
        <div className={SECTION}>
          <div data-needs className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
            <Icon name="BellDot" className="mt-0.5 size-4 shrink-0 text-warning-text" aria-hidden />
            <span className="flex-1"><b>Needs you:</b> {pr.needs}</span>
            <button type="button" className={BUTTON} disabled={busy} onClick={() => void dismiss.run({ key: pr.key })} title="Clear this until something new happens">Dismiss</button>
          </div>
        </div>
      )}

      {pr.actions.length > 0 ? <ManageCard pr={pr} phone={phone} /> : <LabelsAndReviewers pr={pr} />}

      <Description body={body} />

      {!pr.mine && (
        <div className={SECTION}>
          <SectionTitle icon="Info">Why it's here</SectionTitle>
          <div className="flex flex-wrap gap-1">
            {pr.reasons.length > 0 ? <ReasonPills pr={pr} /> : <span className="text-sm text-muted-foreground">Looked up by hand</span>}
            {pr.watch !== null && <Pill tone="ok" icon="Eye">You watch it</Pill>}
          </div>
        </div>
      )}

      <ReviewRun run={pr.lastReview} pr={pr} actions={actions} />

      {isLive(pr) && (
        <div className={SECTION}>
          <SectionTitle icon="Eye">Watch</SectionTitle>
          <div className="flex items-center gap-2.5 text-sm">
            <Toggle on={pr.watch !== null} label="Watch this PR" onChange={() => actions.toggleWatch(pr)} />
            <span className="flex-1 text-muted-foreground">
              {pr.watch !== null ? "New reviews, comments and CI failures go to its owner threads." : "Off. Turn it on to send new reviews to an owner thread."}
            </span>
          </div>
          {pr.watch !== null && (
            <label className="mt-2 flex items-center gap-2 text-sm">
              <span className="w-28 shrink-0 text-xs text-muted-foreground">When it arrives</span>
              <select aria-label="When a review arrives" className={`${FIELD} flex-1`} value={pr.watch} onChange={(event) => actions.setWatchMode(pr, event.target.value as WatchMode)}>
                {WATCH_MODES.map((mode) => <option key={mode} value={mode}>{WATCH_MODE_LABELS[mode]}</option>)}
              </select>
            </label>
          )}
          {pr.pendingItems > 0 && <div className="mt-2 text-xs text-muted-foreground">{plural(pr.pendingItems, "review item")} waiting to be sent.</div>}
        </div>
      )}

      <div className={SECTION}>
        <SectionTitle icon="MessageSquare">Threads</SectionTitle>
        {pr.links.length === 0 && <div className="text-sm text-muted-foreground">No thread yet.</div>}
        <ul className="flex flex-col gap-1">
          {pr.links.map((entry) => (
            <li key={entry.threadId} data-link={entry.threadId} className="flex items-center gap-2">
              <Icon name={entry.archived ? "Archive" : "MessageSquare"} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <button type="button" className="min-w-0 flex-1 cursor-pointer truncate text-left text-sm hover:underline" title={`Open “${entry.title}”`} onClick={() => actions.openThread(entry.threadId)}>
                {entry.title}
                {entry.archived && <span className="text-xs text-muted-foreground"> (archived)</span>}
              </button>
              <select aria-label={`Role of “${entry.title}”`} className="h-6 rounded-md border border-border bg-background px-1 text-xs" value={entry.role} disabled={busy}
                onChange={(event) => void link.run({ key: pr.key, threadId: entry.threadId, role: event.target.value as LinkRole })}>
                {LINK_ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role].short}</option>)}
              </select>
              <button type="button" aria-label={`Unlink “${entry.title}”`} title="Unlink" className={ICON_GHOST} disabled={busy} onClick={() => void unlink.run({ key: pr.key, threadId: entry.threadId })}>
                <Icon name="X" className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className={BUTTON} onClick={() => actions.link(pr, "existing")}>
            <Icon name="Link" className="size-3.5" aria-hidden />
            Link a thread
          </button>
          <button type="button" className={BUTTON} onClick={() => actions.link(pr, "new")}>
            <Icon name="Plus" className="size-3.5" aria-hidden />
            New thread
          </button>
        </div>
      </div>

      <div className="px-4 py-3">
        <SectionTitle icon="ListView">Activity</SectionTitle>
        {events.length === 0 ? (
          <div className="text-sm text-muted-foreground">Nothing yet.</div>
        ) : (
          <ul className="ml-1.5 border-l border-border">
            {events.map((event) => <EventLine key={event.id} event={event} onOpenThread={actions.openThread} />)}
          </ul>
        )}
      </div>
    </aside>
  );
}
