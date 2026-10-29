import type { ReactNode } from "react";
import { experimental_Icon as Icon, Markdown } from "@get-bb/plugin-sdk/app";
import type { ConversationItem, PrView } from "../contract";
import { AgentCard } from "./agent";
import { BoardMemberships } from "./boards";
import { NextButtons, runNext, useActions } from "./actions";
import { BUTTON, BUTTON_PRIMARY, ErrorNote, ICON_GHOST, Pill, SectionTitle, TONE_PANEL, TONE_TEXT, type Tone } from "./common";
import { NEXT_ICONS } from "./constants";
import { ChecksSection, Conversation } from "./conversation";
import { isNotFound, messageOf, useShuttleMutation, useShuttleQuery } from "./data";
import { age, checkName, clock, plural, shortKey, sizeOf } from "./format";
import { LabelsAndReviewers, ManageCard } from "./manage";
import { StatePill } from "./pills";
import { YourReviewCard } from "./your-review";
import { usePrState } from "./pr-state";

const LONG_DESCRIPTION = 1500;

/** The PR's own description, rendered by bb's sanitizing Markdown renderer; a long one is cut until asked. */
function Description({ prKey, body }: { prKey: string; body: string | null }) {
  const [expanded, setExpanded] = usePrState(prKey, "description", false);
  const long = body !== null && body.length > LONG_DESCRIPTION;
  return (
    <section aria-label="Description" className="mx-4 mt-4">
      <SectionTitle icon="FileText">Description</SectionTitle>
      {body === null ? (
        <div className="text-sm text-muted-foreground">Loading the description…</div>
      ) : body.trim() === "" ? (
        <div className="text-sm text-muted-foreground">No description.</div>
      ) : (
        <div className="rounded-lg border border-border bg-card px-3 py-2.5">
          <div data-description className={`min-w-0 overflow-x-auto break-words text-sm ${long && !expanded ? "max-h-80 overflow-y-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]" : ""}`}>
            <Markdown content={body} />
          </div>
          {long && (
            <button type="button" className="mt-2 cursor-pointer text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show less" : "Show the whole description"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

interface CellValue {
  tone: Tone;
  icon?: string;
  value: string;
  sub: string;
}

function Cell({ label, cell }: { label: string; cell: CellValue }) {
  const color = cell.tone === "neutral" ? "text-foreground" : TONE_TEXT[cell.tone as keyof typeof TONE_TEXT];
  return (
    <div data-cell={label} className="min-w-0 border-r border-border px-2.5 py-1.5 last:border-r-0">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`flex items-center gap-1 truncate text-[12.5px] font-semibold ${color}`}>
        {cell.icon && <Icon name={cell.icon} fallback="Circle" className="size-3 shrink-0" aria-hidden />}
        <span className="truncate">{cell.value}</span>
      </div>
      <div className="truncate text-[11px] text-muted-foreground" title={cell.sub}>{cell.sub}</div>
    </div>
  );
}

function checksCell(pr: PrView, items: readonly ConversationItem[] | undefined, short: boolean): CellValue {
  const counts = pr.checkCounts;
  const total = counts === null ? "" : plural(counts.total, "check");
  if (pr.checks === "passed") return { tone: "ok", icon: "Check", value: "All pass", sub: total || "all green" };
  if (pr.checks === "failed") {
    const names = (items ?? []).filter((item) => item.kind === "check").map((item) => checkName(item.body));
    const failed = counts === null ? "Failing" : short ? "Failing" : `${counts.failed} failing`;
    return { tone: "bad", icon: "X", value: failed, sub: !short && names.length > 0 ? names.join(", ") : counts === null ? "" : `${counts.failed} of ${counts.total}` };
  }
  if (pr.checks === "pending") return { tone: "warn", icon: "Clock", value: counts === null || short ? "Running" : `${counts.passed} of ${counts.total}`, sub: counts === null ? "running" : short ? `${counts.passed} of ${counts.total}` : "running" };
  return { tone: "neutral", value: "None", sub: "no checks" };
}

/** Where the PR stands, in three cells: checks, reviews and agent on yours; size, checks and your review on others'. */
function Strip({ pr, items }: { pr: PrView; items: readonly ConversationItem[] | undefined }) {
  let cells: [string, CellValue][];
  if (pr.mine) {
    const reviewers = pr.reviewers ?? [];
    const by = (state: string) => reviewers.filter((reviewer) => reviewer.state === state).map((reviewer) => reviewer.login);
    const asked = by("requested").length;
    const review: CellValue = pr.review === "changes" ? { tone: "bad", icon: "X", value: "Changes", sub: by("changes").length > 0 ? `by ${by("changes").join(", ")}` : "requested" }
      : pr.review === "approved" ? { tone: "ok", icon: "Check", value: "Approved", sub: by("approved").length > 0 ? `by ${by("approved").join(", ")}` : "" }
      : pr.state === "draft" ? { tone: "neutral", icon: "GitPullRequestDraft", value: "Draft", sub: "not requested" }
      : { tone: "warn", icon: "Clock", value: "None yet", sub: [`${asked} asked`, pr.createdAt === null ? null : age(pr.createdAt)].filter(Boolean).join(" · ") };
    const agent = pr.agent;
    const agentCell: CellValue = agent === null || agent.mode === "off" ? { tone: "neutral", icon: "Bot", value: "No agent", sub: "feedback waits for you" }
      : { tone: agent.status === "waiting" ? "warn" : "info", icon: "Bot", value: agent.mode === "fix" ? "Fixes" : "Told only", sub: agent.status === "waiting" ? "waiting on you" : agent.status === "working" ? "working now" : "idle" };
    cells = [["Checks", checksCell(pr, items, false)], ["Reviews", review], ["Agent", agentCell]];
  } else {
    const size = sizeOf(pr);
    const sizeCell: CellValue = { tone: "neutral", value: [size, pr.files === null ? null : plural(pr.files, "file")].filter(Boolean).join(" · ") || "Unknown", sub: pr.additions === null || pr.deletions === null ? "" : `+${pr.additions} −${pr.deletions}` };
    const run = pr.lastReview;
    const mine = pr.myReview;
    const yours: CellValue = pr.draft !== null ? { tone: "info", icon: "Check", value: "Draft ready", sub: "not posted" }
      : run?.state === "running" ? { tone: "info", icon: "Bot", value: "AI running", sub: age(run.at) }
      : mine !== null ? (pr.next.kind === "rereview" ? { tone: "warn", icon: "RotateCcw", value: "Updated", sub: "since your review" }
        : { tone: mine.verdict === "approve" ? "ok" : "neutral", icon: "Check", value: mine.verdict === "approve" ? "Approved" : "Reviewed", sub: mine.at === null ? "" : age(mine.at) })
      : { tone: "neutral", icon: "UserRound", value: "Not started", sub: pr.requestedAt === null ? "not asked" : `asked ${age(pr.requestedAt)} ago` };
    cells = [["Size", sizeCell], ["Checks", checksCell(pr, items, true)], ["Your review", yours]];
  }
  return (
    <div data-strip className="mx-4 grid grid-cols-3 overflow-hidden rounded-lg border border-border bg-card">
      {cells.map(([label, cell]) => <Cell key={label} label={label} cell={cell} />)}
    </div>
  );
}

/** What happens next with your PR, in the same words as its Inbox card. */
function Banner({ pr }: { pr: PrView }) {
  const next = pr.next;
  if ((next.kind === "merged" || next.kind === "closed") && next.primary === null) return null;
  const buttons = next.primary !== null || next.more.length > 0;
  return (
    <div data-banner={next.kind} className={`mx-4 mt-3 rounded-lg border px-3 py-2.5 ${TONE_PANEL[next.tone]}`}>
      <div className={`flex items-center gap-1.5 text-sm font-bold ${TONE_TEXT[next.tone]}`}>
        <Icon name={NEXT_ICONS[next.kind]} fallback="Circle" className="size-3.5" aria-hidden />{next.label}
      </div>
      <div className="mb-2 mt-0.5 text-[13px]">{next.why}</div>
      {buttons && <div className="flex flex-wrap items-center gap-1.5"><NextButtons pr={pr} /></div>}
    </div>
  );
}

function Details({ pr }: { pr: PrView }) {
  const { phone } = useActions();
  const [open, setOpen] = usePrState(pr.key, "details", false);
  return (
    <section aria-label="Details" className="mx-4 mt-4">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full cursor-pointer items-center gap-1.5 text-left">
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3 text-muted-foreground" aria-hidden />
        <span className="flex-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Details</span>
        <span className="text-[11px] text-muted-foreground">{pr.mine ? "reviewers, labels, draft and close" : "reviewers and labels"}</span>
      </button>
      {open && (
        <div className="mt-1">
          {pr.mine && pr.actions.length > 0 ? <ManageCard pr={pr} phone={phone} /> : <LabelsAndReviewers pr={pr} />}
        </div>
      )}
    </section>
  );
}

function Threads({ pr }: { pr: PrView }) {
  const actions = useActions();
  const unlink = useShuttleMutation("unlink");
  const roleOf = (threadId: string, role: string): { label: string; tone: Tone } =>
    pr.agent?.threadId === threadId ? { label: "Agent", tone: "info" } : role === "review" ? { label: "Review", tone: "neutral" } : { label: "Reference", tone: "neutral" };
  return (
    <section aria-label="Threads" className="mx-4 mt-4">
      <SectionTitle icon="MessageSquare">Threads</SectionTitle>
      {pr.links.length === 0 && <div className="text-sm text-muted-foreground">No thread.</div>}
      <ul className="flex flex-col gap-0.5">
        {pr.links.map((entry) => {
          const role = roleOf(entry.threadId, entry.role);
          return (
            <li key={entry.threadId} data-link={entry.threadId} className="flex items-center gap-2 py-0.5">
              <Icon name={entry.archived ? "Archive" : "MessageSquare"} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <button type="button" className="min-w-0 flex-1 cursor-pointer truncate text-left text-[13px] hover:underline" title={`Open “${entry.title}”`} onClick={() => actions.openThread(entry.threadId)}>
                {entry.title}
                {entry.archived && <span className="text-xs text-muted-foreground"> (archived)</span>}
              </button>
              <Pill tone={role.tone}>{role.label}</Pill>
              <button type="button" aria-label={`Unlink “${entry.title}”`} title="Unlink" className={ICON_GHOST} disabled={unlink.isPending}
                onClick={() => void unlink.run({ key: pr.key, threadId: entry.threadId })}>
                <Icon name="X" className="size-3.5" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" className={`${BUTTON} mt-1.5`} onClick={() => actions.link(pr)}>
        <Icon name="Link" className="size-3.5" aria-hidden />Link a thread
      </button>
    </section>
  );
}

export function TrackButton({ pr, iconOnly = false }: { pr: PrView; iconOnly?: boolean }) {
  const { writes } = useActions();
  const label = pr.tracked ? "Tracked" : "Track";
  return (
    <button type="button" aria-pressed={pr.tracked} aria-label={label} title="Keep it in Reviews › Tracked; changes show in your Inbox"
      className={iconOnly ? `${ICON_GHOST} size-9 ${pr.tracked ? "text-primary" : ""}` : pr.tracked ? `${BUTTON} border-primary/50 text-primary` : `${BUTTON} border-transparent bg-transparent`}
      onClick={() => void writes.setTracked(pr, !pr.tracked)}>
      <Icon name="Pin" className="size-3.5" aria-hidden />
      {!iconOnly && label}
    </button>
  );
}

function Header({ pr, phone, onClose }: { pr: PrView; phone: boolean; onClose?: () => void }) {
  const actions = useActions();
  const ref = pr.headRef?.replace(/-thr_\w+$/u, "…") ?? null;
  const meta: ReactNode[] = [<span key="who">{pr.mine ? "You" : pr.author}</span>];
  if (ref !== null) meta.push(<span key="ref" className="font-mono text-[11px]">{ref}{pr.base !== null && ` → ${pr.base}`}</span>);
  if (pr.additions !== null && pr.deletions !== null) meta.push(<span key="size"><span className="text-success">+{pr.additions.toLocaleString()}</span> <span className="text-destructive">−{pr.deletions.toLocaleString()}</span></span>);
  if (pr.files !== null) meta.push(<span key="files">{plural(pr.files, "file")}</span>);
  return (
    <div className="px-4 pb-2.5 pt-3">
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-xs text-muted-foreground">{pr.serverName}</span>
        <span className="min-w-0 truncate font-mono text-xs">{shortKey(pr)}</span>
        <StatePill state={pr.state} />
        <span className="flex-1" />
        {!phone && !pr.mine && <TrackButton pr={pr} />}
        {!phone && (
          <button type="button" aria-label={`Open on ${pr.serverName}`} title={`Open on ${pr.serverName}`} className={ICON_GHOST} onClick={() => actions.open(pr)}>
            <Icon name="ExternalLink" className="size-4" aria-hidden />
          </button>
        )}
        {onClose && (
          <button type="button" aria-label="Close details" title="Close" className={ICON_GHOST} onClick={onClose}>
            <Icon name="X" className="size-4" aria-hidden />
          </button>
        )}
      </div>
      <h3 className="mb-0.5 mt-1.5 text-[15px] font-semibold leading-snug">{pr.title}</h3>
      <div className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
        {meta.flatMap((part, index) => (index === 0 ? [part] : [<span key={`dot${index}`} aria-hidden>·</span>, part]))}
      </div>
      {pr.stale && (
        <div className="mt-1.5 text-xs text-warning-text">
          {pr.serverName}'s last sync could not read this PR, so this shows what Shuttle had {pr.staleSince === null ? "before" : `at ${clock(pr.staleSince)}`}.
        </div>
      )}
    </div>
  );
}

/** One PR, the same everywhere. On a phone the page's top and bottom bars carry its main actions. */
export function PrDetail({ prKey, onClose, phone = false }: { prKey: string; onClose?: () => void; phone?: boolean }) {
  const actions = useActions();
  const detail = useShuttleQuery("detail", { key: prKey });
  const conversation = useShuttleQuery("conversation", { key: prKey });

  if (detail.data === undefined) {
    return (
      <aside aria-label="Pull request" className="p-4 text-sm text-muted-foreground">
        {detail.error === null ? "Loading…" : (
          <ErrorNote>{isNotFound(detail.error) ? `Shuttle does not know ${prKey}. Look it up in the header to fetch it.` : `Could not load ${prKey}: ${messageOf(detail.error)}`}</ErrorNote>
        )}
      </aside>
    );
  }
  const { pr, body, draft } = detail.data;
  const items = conversation.data?.items;
  const conversationError = conversation.data?.error ?? (conversation.error === null ? null : messageOf(conversation.error));
  const lookedUp = pr.next.kind === "looked_up" && !pr.tracked;

  return (
    <aside aria-label={`Pull request ${shortKey(pr)}`} data-detail={pr.key} className="min-w-0 bg-background pb-8">
      <Header pr={pr} phone={phone} onClose={onClose} />
      {lookedUp && (
        <div data-looked-up className="mx-4 mb-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          <Icon name="Search" className="size-3.5" aria-hidden />
          <span className="flex-1">Looked up. It is not in any of your lists.</span>
          <button type="button" className={BUTTON_PRIMARY} onClick={() => runNext(actions, pr, "track")}>
            <Icon name="Pin" className="size-3.5" aria-hidden />Track it
          </button>
        </div>
      )}
      <BoardMemberships pr={pr} />
      <Strip pr={pr} items={items} />
      {pr.mine ? (
        <>
          <Banner pr={pr} />
          <AgentCard pr={pr} />
        </>
      ) : (
        <>
          <YourReviewCard pr={pr} draft={draft} />
          {pr.agent !== null && <AgentCard pr={pr} />}
        </>
      )}
      <Description prKey={pr.key} body={body} />
      <Conversation pr={pr} items={items} error={conversationError} phone={phone} />
      <ChecksSection pr={pr} items={items} />
      <Details pr={pr} />
      <Threads pr={pr} />
    </aside>
  );
}
