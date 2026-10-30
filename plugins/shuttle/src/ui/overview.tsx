import type { ReactNode } from "react";
import { experimental_Icon as Icon, Markdown } from "@get-bb/plugin-sdk/app";
import type { PrDetails, PrView, Reviewer } from "../contract";
import { useActions } from "./actions";
import { Avatar } from "./avatar";
import { BUTTON_GHOST, ICON_GHOST, ICON_GHOST_SMALL, PaneSection, Pill, type Tone } from "./common";
import { useShuttleMutation, useShuttleQuery } from "./data";
import { useEditPr } from "./edit";
import { ago, clock, plural } from "./format";
import { REVIEWER_LOOKS, ReviewerChoices } from "./manage";
import { Picker } from "./picker";
import { isLive } from "./pills";
import { copy } from "./pr-menu";
import { usePrState } from "./pr-state";

const LONG_DESCRIPTION = 1500;

/** The PR's own description, rendered by bb's sanitizing Markdown renderer; a long one is cut until asked. */
export function Description({ prKey, body }: { prKey: string; body: string | null }) {
  const [expanded, setExpanded] = usePrState(prKey, "description", false);
  const long = body !== null && body.length > LONG_DESCRIPTION;
  return (
    <PaneSection title="Description">
      {body === null ? (
        <div className="text-sm text-muted-foreground">Loading the description…</div>
      ) : body.trim() === "" ? (
        <div className="text-sm text-muted-foreground">No description.</div>
      ) : (
        <div className="rounded-lg border border-border bg-card px-3.5 py-3">
          <div data-description className={`min-w-0 overflow-x-auto break-words text-[13.5px] ${long && !expanded ? "max-h-80 overflow-y-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]" : ""}`}>
            <Markdown content={body} />
          </div>
          {long && (
            <button type="button" className="mt-2 cursor-pointer text-xs text-primary hover:underline" onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show less" : "Show the whole description"}
            </button>
          )}
        </div>
      )}
    </PaneSection>
  );
}

function reviewerNote(pr: PrView, reviewer: Reviewer, compact: boolean): string {
  const head = reviewer.head ?? null;
  const older = pr.head !== null && head !== null && head !== pr.head;
  const on = head === null ? "" : compact ? ` · ${head.slice(0, 7)}${older ? " (older)" : ""}` : ` · on ${head.slice(0, 7)}${older ? ", an older commit" : ""}`;
  if (reviewer.state === "requested") return reviewer.at ? `Asked again after reviewing ${ago(reviewer.at)}` : "Asked to review";
  return reviewer.at ? `${ago(reviewer.at)}${on}` : on.replace(/^ · /u, "");
}

/** Who wrote it and who reviews it, each with where their review stands; on your PR, request, withdraw and ask again. */
export function People({ pr, compact = false }: { pr: PrView; compact?: boolean }) {
  const actions = useActions();
  const edit = useEditPr(pr);
  const me = useShuttleQuery("overview", {}).data?.servers.find((server) => server.id === pr.server)?.login?.toLowerCase() ?? null;
  const canEdit = pr.mine && isLive(pr) && pr.actions.includes("reviewers");
  const reviewers = pr.reviewers;
  const aside = canEdit && (
    <Picker phone={actions.phone} title="Request reviewers" triggerLabel="Request reviewers" triggerClassName={BUTTON_GHOST}
      trigger={<><Icon name="Plus" className="size-3.5" aria-hidden />{compact ? "Request" : "Request reviewers"}</>}>
      <ReviewerChoices pr={pr} edit={edit} />
    </Picker>
  );
  return (
    <PaneSection title="People" aside={aside}>
      <ul data-people className="overflow-hidden rounded-lg border border-border bg-card">
        <li data-person={pr.author} className="flex items-center gap-2.5 px-3 py-2 text-[13px]">
          <Avatar login={pr.author} bot={pr.bot} />
          <span className="min-w-0 flex-1"><b className="font-semibold">{pr.mine ? "You" : pr.author}</b><span className="block text-xs text-muted-foreground">Author</span></span>
        </li>
        {reviewers === null && <li className="border-t border-border px-3 py-2 text-xs text-muted-foreground">Loading reviewers…</li>}
        {reviewers !== null && reviewers.length === 0 && (
          <li className="border-t border-border px-3 py-2 text-xs text-muted-foreground">Nobody is asked to review yet.{pr.state === "draft" ? " Requests on a draft wait until it's ready." : ""}</li>
        )}
        {reviewers?.map((reviewer) => {
          const look = REVIEWER_LOOKS[reviewer.state];
          return (
            <li key={`${reviewer.team ? "team" : "person"}:${reviewer.login}`} data-reviewer={reviewer.login} className="flex items-center gap-2.5 border-t border-border px-3 py-2 text-[13px]">
              <Avatar login={reviewer.login} team={reviewer.team} bot={reviewer.bot === true} />
              <span className="min-w-0 flex-1 break-words">
                <b className="font-semibold">{reviewer.team ? `@${reviewer.login}` : reviewer.login.toLowerCase() === me ? "You" : reviewer.login}</b>
                {reviewer.team && <span className="text-xs text-muted-foreground"> team</span>}
                <span className="block truncate text-xs text-muted-foreground">{reviewerNote(pr, reviewer, compact)}</span>
              </span>
              <span title={look.label} className={`inline-flex shrink-0 items-center gap-1 text-xs ${look.className}`}>
                <Icon name={look.icon} className="size-3.5" aria-hidden />{!compact && look.label}
              </span>
              {canEdit && (reviewer.state === "requested" ? (
                <button type="button" aria-label={`Withdraw the request to ${reviewer.login}`} title="Withdraw the request" className={ICON_GHOST}
                  onClick={() => edit.apply({ kind: "reviewers", remove: [{ login: reviewer.login, team: reviewer.team }] })}>
                  <Icon name="X" className="size-3.5" aria-hidden />
                </button>
              ) : (
                <button type="button" aria-label={`Ask ${reviewer.login} to review again`} title="Ask for a new review" className={ICON_GHOST}
                  onClick={() => edit.apply({ kind: "reviewers", add: [{ login: reviewer.login, team: reviewer.team }] })}>
                  <Icon name="RotateCcw" className="size-3.5" aria-hidden />
                </button>
              ))}
            </li>
          );
        })}
      </ul>
    </PaneSection>
  );
}

const date = (at: number) => new Date(at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function reasonsOf(pr: PrView): string | null {
  const has = (reason: string) => pr.reasons.some((item) => item.reason === reason);
  const parts: string[] = [];
  if (has("requested")) parts.push(`asked you${pr.requestedAt === null ? "" : ` ${ago(pr.requestedAt)}`}`);
  if (has("team")) parts.push(`asked ${pr.teams.length === 0 ? "your team" : pr.teams.map((team) => `@${team}`).join(", ")}`);
  if (has("mentioned")) parts.push("mentioned you");
  if (has("reviewed")) parts.push("you reviewed it");
  if (pr.tracked) parts.push("you track it");
  if (parts.length === 0) return null;
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The facts of the PR, in a table: where it lives, its branch and head, its size and its dates. */
export function About({ pr, details, compact = false }: { pr: PrView; details: PrDetails | null; compact?: boolean }) {
  const actions = useActions();
  const last = details?.commits?.items.at(-1) ?? null;
  const commits = details?.commits?.total ?? null;
  const rows: [string, ReactNode][] = [[ "Repository", <>{pr.repo} <span className="text-muted-foreground">on {pr.serverName}</span></> ]];
  if (pr.headRef !== null) {
    rows.push(["Branch", (
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        <code className="max-w-full truncate rounded-sm bg-surface-recessed px-1 font-mono text-xs text-foreground" title={pr.headRef}>{pr.headRef}</code>
        <button type="button" aria-label="Copy the branch name" title="Copy" className={ICON_GHOST_SMALL} onClick={() => copy(pr.headRef!, "the branch name")}>
          <Icon name="Copy" className="size-3" aria-hidden />
        </button>
        {pr.base !== null && <><span className="text-muted-foreground">into</span><code className="rounded-sm bg-surface-recessed px-1 font-mono text-xs text-foreground">{pr.base}</code></>}
      </span>
    )]);
  }
  if (pr.head !== null) rows.push(["Head commit", <><span className="font-mono text-[12px]">{pr.head.slice(0, 7)}</span>{last?.at != null && last.sha === pr.head && <span className="text-muted-foreground"> · committed {ago(last.at)}</span>}</>]);
  if (pr.additions !== null && pr.deletions !== null) {
    rows.push(["Size", (
      <>
        <span className="text-success">+{pr.additions.toLocaleString()}</span> <span className="text-destructive-text">−{pr.deletions.toLocaleString()}</span>
        <span className="text-muted-foreground">{pr.files !== null && ` in ${plural(pr.files, "file")}`}{commits !== null && ` · ${plural(commits, "commit")}`}</span>
      </>
    )]);
  }
  if (pr.createdAt !== null) rows.push(["Opened", <>{date(pr.createdAt)} <span className="text-muted-foreground">({ago(pr.createdAt)})</span></>]);
  if (pr.closedAt !== null && (pr.state === "merged" || pr.state === "closed")) rows.push([pr.state === "merged" ? "Merged" : "Closed", <>{date(pr.closedAt)} <span className="text-muted-foreground">({ago(pr.closedAt)})</span></>]);
  if (pr.mine && isLive(pr)) {
    rows.push(["Auto-merge", pr.autoMerge ? "On: it merges when its checks pass" : (
      <>Off{pr.can.merge && <button type="button" className="ml-2 cursor-pointer text-primary hover:underline" onClick={() => actions.merge(pr)}>Merge…</button>}</>
    )]);
  }
  const reasons = pr.mine ? null : reasonsOf(pr);
  if (reasons !== null) rows.push(["In your lists", reasons]);
  if (pr.snoozedUntil !== null) rows.push(["Snoozed", `Until ${clock(pr.snoozedUntil)}, or until it changes`]);
  return (
    <PaneSection title="About this PR" label="About">
      {/* The labels' column never goes below its longest word, which a monospace theme makes wider than the default font. */}
      <dl data-about className={`grid ${compact ? "grid-cols-[minmax(min-content,88px)_minmax(0,1fr)]" : "grid-cols-[minmax(min-content,116px)_minmax(0,1fr)]"} overflow-hidden rounded-lg border border-border bg-card text-[13px]`}>
        {rows.map(([name, value], index) => (
          <div key={name} className="contents">
            <dt className={`bg-surface-recessed px-3 py-2 text-muted-foreground ${index > 0 ? "border-t border-border" : ""}`}>{name}</dt>
            <dd className={`m-0 min-w-0 break-words px-3 py-2 ${index > 0 ? "border-t border-border" : ""}`}>{value}</dd>
          </div>
        ))}
      </dl>
    </PaneSection>
  );
}

/** The bb threads linked to the PR, the agent's marked as such; open, unlink, or link another. */
export function Threads({ pr, compact = false }: { pr: PrView; compact?: boolean }) {
  const actions = useActions();
  const unlink = useShuttleMutation("unlink");
  const roleOf = (threadId: string, role: string): { label: string; tone: Tone } =>
    pr.agent?.threadId === threadId ? { label: "Agent", tone: "info" } : role === "review" ? { label: "Review", tone: "neutral" } : { label: "Reference", tone: "neutral" };
  return (
    <PaneSection title="Threads in bb" label="Threads" aside={(
      <button type="button" className={BUTTON_GHOST} onClick={() => actions.link(pr)}>
        <Icon name="Link" className="size-3.5" aria-hidden />{compact ? "Link" : "Link a thread"}
      </button>
    )}>
      {pr.links.length === 0 ? <div className="text-sm text-muted-foreground">No thread.</div> : (
        <ul className="overflow-hidden rounded-lg border border-border bg-card">
          {pr.links.map((entry) => {
            const role = roleOf(entry.threadId, entry.role);
            return (
              <li key={entry.threadId} data-link={entry.threadId} className="flex items-center gap-2 border-t border-border px-3 py-1.5 first:border-t-0">
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
      )}
    </PaneSection>
  );
}

/** What sits beside a full-page PR, and under its description elsewhere. */
export function Facts({ pr, details, compact = false }: { pr: PrView; details: PrDetails | null; compact?: boolean }) {
  return (
    <>
      <People pr={pr} compact={compact} />
      <About pr={pr} details={details} compact={compact} />
      <Threads pr={pr} compact={compact} />
    </>
  );
}

