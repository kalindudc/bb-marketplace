import type { ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { ConversationItem, PrDetails, PrView, ReviewDraft } from "../contract";
import { AgentControls } from "./agent";
import { NextButtons, useActions } from "./actions";
import { TONE_TEXT } from "./common";
import { AGENT_MODE_META, NEXT_ICONS } from "./constants";
import { checksSummary } from "./checks";
import { useShuttleQuery } from "./data";
import { ago, plural, sizeOf } from "./format";
import { isLive } from "./pills";
import { usePrState, type PrTab } from "./pr-state";

type RowTone = "ok" | "bad" | "warn" | "info" | "neutral";

interface Row {
  id: string;
  label: string;
  tone: RowTone;
  icon: string;
  /** The icon's colour, when the tone's is not it: merged has its own. */
  iconClass?: string;
  text: ReactNode;
  note?: ReactNode;
  /** Where a click goes: a tab, an action, or open in place. */
  go?: PrTab;
  act?: () => void;
  panel?: ReactNode;
}

const ICON_OF: Record<RowTone, string> = { ok: "CircleCheck", bad: "CircleX", warn: "Clock", info: "Bot", neutral: "Circle" };
const b = (text: string) => <b className="font-semibold">{text}</b>;

function list(parts: ReactNode[]): ReactNode {
  return parts.flatMap((part, index) => (index === 0 ? [part] : [<span key={`dot${index}`} className="text-muted-foreground"> · </span>, part]));
}

/** On someone else's PR, your own request and review have their own row. */
function reviewsRow(pr: PrView, me: string | null): Row {
  const others = (pr.reviewers ?? []).filter((reviewer) => pr.mine || reviewer.team || me === null || reviewer.login.toLowerCase() !== me);
  const by = (state: string) => others.filter((reviewer) => reviewer.state === state);
  const name = (login: string, team: boolean) => (team ? `@${login}` : login);
  const parts: ReactNode[] = [];
  for (const reviewer of by("changes")) parts.push(<span key={`c${reviewer.login}`}>{b(name(reviewer.login, reviewer.team))} requested changes</span>);
  for (const reviewer of by("approved")) {
    const older = reviewer.head != null && pr.head !== null && reviewer.head !== pr.head;
    parts.push(<span key={`a${reviewer.login}`}>{b(name(reviewer.login, reviewer.team))} approved{older && <span className="text-muted-foreground"> an older commit</span>}</span>);
  }
  for (const reviewer of by("commented")) parts.push(<span key={`m${reviewer.login}`}>{b(name(reviewer.login, reviewer.team))} commented</span>);
  const waiting = by("requested");
  if (waiting.length > 0) {
    const shown = waiting.slice(0, 3).map((reviewer) => name(reviewer.login, reviewer.team));
    const more = waiting.length - shown.length;
    parts.push(<span key="w">{shown.map((login, index) => <span key={login}>{index > 0 && (index === shown.length - 1 && more === 0 ? " and " : ", ")}{b(login)}</span>)}{more > 0 && ` and ${more} more`} {waiting.length === 1 ? "hasn’t" : "haven’t"} reviewed yet</span>);
  }
  const tone: RowTone = pr.review === "changes" ? "bad" : pr.review === "approved" ? "ok" : pr.reviewers === null ? "neutral" : "warn";
  const text = pr.reviewers === null ? <span className="text-muted-foreground">Loading reviewers…</span>
    : parts.length === 0 ? (pr.state === "draft" ? "Nobody is notified while it is a draft" : "Nobody is asked to review yet") : list(parts);
  return { id: "reviews", label: "Reviews", tone, icon: ICON_OF[tone], text, go: "overview" };
}

function checksRow(pr: PrView, items: readonly ConversationItem[] | undefined, details: PrDetails | null): Row | null {
  const summary = checksSummary(pr, items, details);
  if (summary.state === "none") return null;
  const counts = summary.counts;
  const parts: ReactNode[] = [];
  if (summary.state === "failed") {
    const names = summary.failing.slice(0, 3);
    const more = summary.failing.length - names.length;
    parts.push(<span key="f"><b className="font-semibold text-destructive-text">{counts === null ? "Failing" : `${counts.failed} failing`}</b>{names.length > 0 && `: ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}`}</span>);
  }
  if (counts !== null) {
    if (counts.running > 0) parts.push(<span key="r">{counts.running} running</span>);
    parts.push(summary.state === "passed" ? <span key="p">{b(`All ${counts.passed} passed`)}</span> : <span key="p">{counts.passed} passed</span>);
    if (counts.skipped > 0) parts.push(<span key="s">{counts.skipped} skipped</span>);
  } else if (summary.state === "pending") {
    parts.push(<span key="r">Still running</span>);
  } else if (summary.state === "passed") {
    parts.push(<span key="p">{b("All pass")}</span>);
  }
  const tone: RowTone = summary.state === "failed" ? "bad" : summary.state === "pending" ? "warn" : "ok";
  return { id: "checks", label: "Checks", tone, icon: tone === "warn" ? "Loading" : ICON_OF[tone], text: list(parts), go: "checks" };
}

function mergeRow(pr: PrView, details: PrDetails | null, onMerge: (() => void) | undefined): Row | null {
  if (pr.state === "merged") {
    const merged = details?.timeline?.find((event) => event.kind === "merged") ?? null;
    const into = merged?.detail ?? pr.base;
    return {
      id: "merge", label: "Merge", tone: "neutral", icon: "GitMerge", iconClass: "text-pr-merged",
      text: <>{b("Merged")}{into !== null && <> into {into}</>}{merged?.subject && <> as <span className="font-mono text-[12px]">{merged.subject}</span></>}{merged?.actor && <> by {pr.mine && merged.actor === pr.author ? "you" : merged.actor}</>}{pr.closedAt !== null && <span className="text-muted-foreground"> · {ago(pr.closedAt)}</span>}</>,
      go: "history",
    };
  }
  if (pr.state === "closed") return { id: "merge", label: "Merge", tone: "neutral", icon: "GitPullRequestClosed", text: <>{b("Closed")} without merging{pr.closedAt !== null && <span className="text-muted-foreground"> · {ago(pr.closedAt)}</span>}</>, go: "history" };
  if (pr.autoMerge) return { id: "merge", label: "Merge", tone: "ok", icon: "GitMerge", text: <>{b("Auto-merge is on.")} It merges when its required checks pass.</>, ...(onMerge ? { act: onMerge } : {}) };
  const merge = details?.merge ?? null;
  if (merge === null || merge.state === "unknown") return null;
  const words = { clean: "Can merge.", blocked: "Blocked.", behind: "Behind its base.", conflicts: "Has conflicts.", pending: "Waiting on checks." } as const;
  const tone: RowTone = merge.state === "clean" ? "ok" : merge.state === "conflicts" || merge.state === "blocked" ? "bad" : "warn";
  return { id: "merge", label: "Merge", tone, icon: merge.state === "clean" ? "CircleCheck" : merge.state === "pending" ? "Clock" : merge.state === "behind" ? "GitBranch" : "CircleX", text: <>{b(words[merge.state])}{merge.detail && <> {merge.detail}</>}</>, ...(onMerge ? { act: onMerge } : {}) };
}

function agentRow(pr: PrView): Row | null {
  if (!pr.mine && pr.agent === null) return null;
  if (!isLive(pr)) {
    if (pr.agent === null) return null;
    return { id: "agent", label: "Agent", tone: "neutral", icon: "Bot", text: <>{b(`“${pr.agent.title}”`)} <span className="text-muted-foreground">· gets nothing more now that the PR is {pr.state}</span></> };
  }
  const agent = pr.agent;
  if (agent === null) {
    return { id: "agent", label: "Agent", tone: "warn", icon: "Bot", text: <>{b("No agent.")} New feedback waits in your Inbox.</>, note: pr.suggestedAgent !== null ? `Suggested: “${pr.suggestedAgent.title}”` : undefined, panel: <AgentControls pr={pr} /> };
  }
  const status = agent.mode === "off" ? null : agent.status === "waiting" ? <span className="text-warning-text">waiting on you</span> : agent.status === "working" ? <span className="font-medium text-foreground">working now</span> : agent.status === "archived" ? <span className="text-warning-text">its thread is archived</span> : <span className="text-muted-foreground">idle</span>;
  const note = [agent.lastSent !== null ? `Last sent ${agent.lastSent.text.replace(/^Sent /u, "")}, ${ago(agent.lastSent.at)}` : null, agent.auto ? "picked automatically" : null].filter(Boolean).join(" · ");
  return {
    id: "agent", label: "Agent", tone: agent.mode === "off" ? "neutral" : agent.status === "waiting" ? "warn" : "info", icon: "Bot",
    text: <>{b(`“${agent.title}”`)} · {AGENT_MODE_META[agent.mode].label}{status !== null && <> · {status}</>}</>,
    note: note || undefined,
    panel: <AgentControls pr={pr} />,
  };
}

function yourReviewRow(pr: PrView, draft: ReviewDraft | null): Row | null {
  if (pr.mine || !isLive(pr)) return null;
  const run = pr.lastReview;
  if (draft !== null) {
    const high = draft.findings.filter((finding) => finding.severity === "high").length;
    return { id: "yours", label: "Your review", tone: "info", icon: "Sparkles", text: <>{b("AI draft ready")} · {plural(draft.findings.length, "finding")}{high > 0 && `, ${high} high`} · not posted</>, go: "review" };
  }
  if (run?.state === "running") return { id: "yours", label: "Your review", tone: "info", icon: "Loading", text: <>{b(run.preset)} is reviewing in “{run.title}”, started {ago(run.at)}</>, go: "review" };
  const mine = pr.myReview;
  if (mine !== null) {
    const verb = mine.verdict === "approve" ? "You approved" : mine.verdict === "changes" ? "You requested changes" : mine.verdict === "dismissed" ? "Your review was dismissed" : "You commented";
    const moved = pr.next.kind === "rereview";
    return { id: "yours", label: "Your review", tone: moved ? "warn" : mine.verdict === "approve" ? "ok" : "neutral", icon: moved ? "RotateCcw" : "Check", text: <>{b(verb)}{mine.at !== null && ` ${ago(mine.at)}`}{moved && <span className="text-warning-text"> · updated since</span>}</>, go: "review" };
  }
  return { id: "yours", label: "Your review", tone: "neutral", icon: "UserRound", text: <>{b("Not started")}{pr.requestedAt !== null && <span className="text-muted-foreground"> · asked {ago(pr.requestedAt)}</span>}</>, go: "review" };
}

function sizeRow(pr: PrView, details: PrDetails | null): Row | null {
  if (pr.mine || pr.additions === null || pr.deletions === null) return null;
  const size = sizeOf(pr);
  const word = size === "S" ? "Small" : size === "M" ? "Medium" : size === "L" ? "Large" : "Very large";
  const commits = details?.commits?.total ?? null;
  return {
    id: "size", label: "Size", tone: "neutral", icon: "File",
    text: <>{b(word)} · <span className="text-success">+{pr.additions.toLocaleString()}</span> <span className="text-destructive-text">−{pr.deletions.toLocaleString()}</span>{pr.files !== null && ` in ${plural(pr.files, "file")}`}{commits !== null && ` · ${plural(commits, "commit")}`}</>,
    go: "changes",
  };
}

function StatusRow({ pr, row, onTab }: { pr: PrView; row: Row; onTab(tab: PrTab): void }) {
  const [open, setOpen] = usePrState(pr.key, "agentOpen", false);
  const expandable = row.panel !== undefined;
  const expanded = expandable && open;
  const click = expandable ? () => setOpen(!open) : row.act ?? (row.go !== undefined ? () => onTab(row.go!) : undefined);
  const content = (
    <>
      <Icon name={row.icon} fallback="Circle" className={`mt-0.5 size-4 shrink-0 ${row.iconClass ?? TONE_TEXT[row.tone]} ${row.icon === "Loading" ? "animate-spin" : ""}`} aria-hidden />
      <span className="w-[84px] shrink-0 text-muted-foreground @max-[460px]:hidden">{row.label}</span>
      <span className="min-w-0 flex-1">
        <span className="hidden text-muted-foreground @max-[460px]:inline">{row.label}: </span>
        {row.text}
        {row.note !== undefined && !expanded && <span className="block text-xs text-muted-foreground">{row.note}</span>}
      </span>
      {click !== undefined && <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
    </>
  );
  const className = "flex w-full items-start gap-2.5 px-3.5 py-1.5 text-left text-[13px] leading-[1.45]";
  return (
    <li data-status-row={row.id}>
      {click === undefined ? <div className={className}>{content}</div> : (
        <button type="button" aria-expanded={expandable ? expanded : undefined} className={`${className} cursor-pointer hover:bg-state-hover`} onClick={click}>{content}</button>
      )}
      {expanded && <div className="px-3.5 pb-2.5 pl-[38px] @max-[460px]:pl-3.5">{row.panel}</div>}
    </li>
  );
}

// bb's own tints: surface-destructive for trouble, a faint warning or success wash, a raised surface otherwise.
// surface-selected is the theme's primary, kept for what is selected.
const TOP: Record<RowTone | "merged", string> = {
  ok: "bg-success/5",
  bad: "bg-surface-destructive",
  warn: "bg-warning/5",
  info: "bg-surface-raised",
  neutral: "bg-surface-raised",
  merged: "bg-pr-merged/5",
};
const BADGE: Record<RowTone | "merged", string> = {
  ok: "bg-success/10 text-success",
  bad: "bg-surface-destructive text-destructive-text",
  warn: "bg-warning/10 text-warning-text",
  info: "bg-surface-recessed text-foreground",
  neutral: "bg-surface-recessed text-muted-foreground",
  merged: "bg-pr-merged/10 text-pr-merged",
};

/**
 * Where the PR stands, in one card: what happens next with its buttons, in the server's words, then a row for
 * each part a merge waits on. A row opens the tab that has the rest; the agent's opens its controls in place.
 */
export function StatusCard({ pr, items, details, draft, onTab }: { pr: PrView; items: readonly ConversationItem[] | undefined; details: PrDetails | null; draft: ReviewDraft | null; onTab(tab: PrTab): void }) {
  const actions = useActions();
  const overview = useShuttleQuery("overview", {});
  const me = overview.data?.servers.find((server) => server.id === pr.server)?.login?.toLowerCase() ?? null;
  const next = pr.next;
  const merged = pr.state === "merged";
  const tone: RowTone | "merged" = merged ? "merged" : next.tone;
  const canMerge = pr.mine && isLive(pr) && pr.can.merge;
  const rows = [
    yourReviewRow(pr, draft),
    reviewsRow(pr, me),
    checksRow(pr, items, details),
    mergeRow(pr, details, canMerge ? () => actions.merge(pr) : undefined),
    agentRow(pr),
    sizeRow(pr, details),
  ].filter((row): row is Row => row !== null);
  const buttons = next.primary !== null || next.more.length > 0;
  return (
    <section aria-label="Where it stands" data-status={next.kind} className="@container overflow-hidden rounded-xl border border-border bg-card">
      <div className={`flex gap-3 px-3.5 py-3 ${TOP[tone]}`}>
        <span aria-hidden className={`flex size-8 shrink-0 items-center justify-center rounded-full ${BADGE[tone]}`}>
          <Icon name={NEXT_ICONS[next.kind]} fallback="Circle" className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div data-next-label className="text-[15px] font-semibold leading-snug">{next.label}</div>
          <div className="mt-0.5 text-[13px] leading-normal text-muted-foreground">{next.why}</div>
          {buttons && <div className="mt-2.5 flex flex-wrap items-center gap-1.5"><NextButtons pr={pr} /></div>}
        </div>
      </div>
      {rows.length > 0 && <ul className="border-t border-border py-1">{rows.map((row) => <StatusRow key={row.id} pr={pr} row={row} onTab={onTab} />)}</ul>}
    </section>
  );
}
