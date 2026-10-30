import type { ReactNode } from "react";
import { experimental_Icon as Icon, type BbNavigate } from "@get-bb/plugin-sdk/app";
import type { CheckState, HunkLine, LinkCard, PrView } from "../../contract";
import { Avatar } from "../avatar";
import { LabelChip } from "../manage";
import { BUTTON, BUTTON_PRIMARY, TONE_PANEL, TONE_TEXT } from "../common";
import { PANEL_PATH } from "../constants";
import { messageOf, openExternal } from "../data";
import { ago, plural, seconds } from "../format";
import { STATE_LOOKS, StatePill } from "../pills";
import { presetTab } from "../pr-state";
import { formatRoute } from "../route";
import { Tag, tagOf } from "../tags";

const KIND_ICONS: Record<LinkCard["kind"], string> = { pr: "GitPullRequest", comment: "MessageSquare", review: "MessageSquareText", commit: "GitCommit", check: "CirclePlay", issue: "CircleDot" };
type IssueState = NonNullable<LinkCard["issue"]>["state"];
/** As GitHub draws issues, in the theme's colours: open, closed as completed (the merged colour) and not planned. */
const ISSUE_LOOKS: Record<IssueState, { icon: string; className: string; label: string }> = {
  open: { icon: "CircleDot", className: "text-success", label: "Open" },
  completed: { icon: "CircleCheck", className: "text-pr-merged", label: "Closed" },
  not_planned: { icon: "CircleSlash", className: "text-muted-foreground", label: "Not planned" },
};

function IssuePill({ state }: { state: IssueState }) {
  const look = ISSUE_LOOKS[state];
  return (
    <span data-pill={state} className="inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-border bg-background px-2 text-[11.5px] leading-none text-foreground">
      <Icon name={look.icon} fallback="Circle" className={`size-3 ${look.className}`} aria-hidden />{look.label}
    </span>
  );
}
const CHECKS: Record<CheckState, { icon: string; className: string; text: string }> = {
  passed: { icon: "CircleCheck", className: "text-success", text: "Checks pass" },
  failed: { icon: "CircleX", className: "text-destructive-text", text: "Checks fail" },
  pending: { icon: "Loading", className: "text-warning-text", text: "Checks running" },
  none: { icon: "Minus", className: "text-muted-foreground", text: "No checks" },
};
const RUNS = {
  failed: { icon: "CircleX", className: "text-destructive-text", text: "Failed" },
  running: { icon: "Loading", className: "text-warning-text", text: "Running" },
  passed: { icon: "CircleCheck", className: "text-success", text: "Passed" },
  skipped: { icon: "Minus", className: "text-muted-foreground", text: "Skipped" },
} as const;

function Fact({ icon, className = "text-muted-foreground", children }: { icon: string; className?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2 text-xs leading-[1.45]">
      <Icon name={icon} fallback="Circle" className={`mt-px size-3.5 shrink-0 ${className} ${icon === "Loading" ? "animate-spin" : ""}`} aria-hidden />
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function prFacts(pr: PrView): ReactNode[] {
  const facts: ReactNode[] = [];
  const check = CHECKS[pr.checks];
  const counts = pr.checkCounts;
  facts.push(<Fact key="checks" icon={check.icon} className={check.className}>{counts !== null && counts.total > 0 ? `${pr.checks === "failed" ? `${counts.failed} failing` : pr.checks === "pending" ? `${counts.pending} running` : `All ${counts.passed} pass`} · ${plural(counts.total, "check")}` : check.text}</Fact>);
  const reviewers = pr.reviewers ?? [];
  const changes = reviewers.filter((reviewer) => reviewer.state === "changes").map((reviewer) => reviewer.login);
  const approved = reviewers.filter((reviewer) => reviewer.state === "approved").map((reviewer) => reviewer.login);
  const waiting = reviewers.filter((reviewer) => reviewer.state === "requested").length;
  const review = changes.length > 0 ? `${changes.join(", ")} requested changes` : approved.length > 0 ? `Approved by ${approved.join(", ")}` : waiting > 0 ? `${plural(waiting, "reviewer")} asked, nobody has reviewed` : pr.review === "approved" ? "Approved" : "No reviews yet";
  facts.push(<Fact key="reviews" icon={changes.length > 0 ? "CircleX" : approved.length > 0 ? "CircleCheck" : "Clock"} className={changes.length > 0 ? "text-destructive-text" : approved.length > 0 ? "text-success" : "text-muted-foreground"}>{review}</Fact>);
  if (pr.agent !== null) {
    const status = pr.agent.mode === "off" ? "off" : pr.agent.status === "working" ? "working now" : pr.agent.status === "waiting" ? "waiting on you" : "idle";
    facts.push(<Fact key="agent" icon="Bot" className={pr.agent.status === "waiting" ? "text-warning-text" : "text-muted-foreground"}>Agent “{pr.agent.title}” · {status}</Fact>);
  }
  if (pr.draft !== null) facts.push(<Fact key="draft" icon="Sparkles" className="text-foreground">An AI review drafted {plural(pr.draft.findings, "finding")}, not posted</Fact>);
  return facts;
}

function Lines({ lines }: { lines: readonly HunkLine[] }) {
  return (
    <pre className="m-0 mt-1.5 overflow-x-auto rounded-sm border border-border bg-surface-recessed py-0.5 font-mono text-[11px] leading-[1.55]">
      {lines.slice(-3).map((line, index) => (
        <div key={index} className={`whitespace-pre px-2 ${line.kind === "add" ? "bg-diff-added/10" : line.kind === "del" ? "bg-diff-removed/10" : ""}`}>
          <span className="mr-2 inline-block w-6 select-none text-right text-muted-foreground">{line.line ?? ""}</span>{line.text}
        </div>
      ))}
    </pre>
  );
}

const clip = (text: string, max = 280) => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function Quote({ author, bot, at, verdict, children }: { author: string | null; bot: boolean; at: number | null; verdict?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <Avatar login={author ?? "?"} bot={bot} size={20} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <b className="font-semibold">{author ?? "Someone"}</b>
          {verdict}
          {at !== null && <span className="text-muted-foreground">{ago(at)}</span>}
        </div>
        <div className="mt-0.5 text-[12.5px] leading-[1.45] text-foreground [overflow-wrap:anywhere]">{children}</div>
      </div>
    </div>
  );
}

/** What the link names, the next step of its PR, a few facts, then Open in Shuttle and Open on its server. Nothing in it writes. */
export function LinkCardBody({ url, kind, card, error, navigate, onDone, sheet = false }: {
  url: string;
  kind: string;
  card: LinkCard | undefined;
  error: unknown;
  navigate: BbNavigate;
  onDone(): void;
  sheet?: boolean;
}) {
  const icon = KIND_ICONS[(card?.kind ?? kind) as LinkCard["kind"]] ?? "GitPullRequest";
  const pr = card?.pr ?? null;
  const openInShuttle = () => {
    if (!card?.prKey) return;
    presetTab(card.prKey, card.tab);
    navigate.toPluginPanel(PANEL_PATH, { subPath: formatRoute({ view: "pr", key: card.prKey }) });
    onDone();
  };
  const openOnServer = () => {
    openExternal(navigate, url);
    onDone();
  };
  const serverName = card?.serverName ?? "its server";
  const issue = card?.issue ?? null;
  const look = pr !== null ? STATE_LOOKS[pr.state] : issue !== null ? ISSUE_LOOKS[issue.state] : null;
  const openPr = (key: string) => {
    presetTab(key, "overview");
    navigate.toPluginPanel(PANEL_PATH, { subPath: formatRoute({ view: "pr", key }) });
    onDone();
  };

  let body: ReactNode = null;
  if (card === undefined) {
    body = error ? <div className="text-xs text-destructive-text">Could not read it: {messageOf(error)}</div> : (
      <div className="space-y-1.5" aria-label="Reading">
        <div className="h-3 w-4/5 animate-pulse rounded-sm bg-surface-recessed" />
        <div className="h-3 w-3/5 animate-pulse rounded-sm bg-surface-recessed" />
      </div>
    );
  } else {
    const parts: ReactNode[] = [];
    if (card.comment !== null) {
      const item = card.comment.item;
      const tag = pr ? tagOf(pr, item) : null;
      parts.push(
        <div key="comment" data-link-part="comment">
          <Quote author={item.mine ? "You" : item.author} bot={item.bot} at={item.at} verdict={tag ? <Tag tag={tag} /> : undefined}>{clip(item.body)}</Quote>
          {item.path !== null && <div className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">{item.path}{item.line !== null && `:${item.line}`}</div>}
          {item.hunk !== null && <Lines lines={item.hunk} />}
          {item.outcome?.note && <Fact icon="Bot" className="text-success">{item.outcome.note}</Fact>}
          <div className="mt-1.5 text-xs text-muted-foreground">
            {card.comment.resolved ? "Thread resolved" : item.thread !== null ? "Thread still open" : "A comment on the PR"}{card.comment.replies > 0 && ` · ${plural(card.comment.replies, "other comment")} in it`}
          </div>
        </div>,
      );
    }
    if (card.review !== null) {
      const item = card.review.item;
      const state = (item.state ?? "").toLowerCase();
      const verdict = state.includes("approv") ? <span className="text-success">approved</span> : state.includes("change") ? <span className="text-destructive-text">requested changes</span> : <span className="text-muted-foreground">reviewed</span>;
      parts.push(
        <div key="review" data-link-part="review">
          <Quote author={item.mine ? "You" : item.author} bot={item.bot} at={item.at} verdict={verdict}>{item.body.trim() === "" ? <span className="text-muted-foreground">No summary.</span> : clip(item.body)}</Quote>
          {card.review.comments > 0 && (
            <div className="mt-1.5 text-xs text-muted-foreground">{plural(card.review.comments, "comment")} on lines{card.review.open === 0 ? ", all resolved" : `, ${card.review.open} still open`}</div>
          )}
        </div>,
      );
    }
    if (card.commit !== null) {
      const commit = card.commit;
      const checks = commit.checks === null ? null : CHECKS[commit.checks];
      parts.push(
        <div key="commit" data-link-part="commit" className="space-y-1.5">
          <div className="text-[13px] font-semibold leading-snug">{commit.message || "(no message)"}</div>
          <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <code className="rounded-sm bg-surface-recessed px-1 font-mono text-[11px] text-foreground">{commit.sha.slice(0, 7)}</code>
            {commit.author !== null && <span>{commit.author}</span>}
            {commit.at !== null && <span>· {ago(commit.at)}</span>}
            {commit.additions !== null && commit.deletions !== null && <span>· <span className="text-success">+{commit.additions}</span> <span className="text-destructive-text">−{commit.deletions}</span></span>}
          </div>
          {pr !== null && <Fact icon={commit.head ? "CircleDot" : "History"}>{commit.head ? `The head of #${pr.number} now` : `An earlier commit of #${pr.number}`}</Fact>}
          {checks !== null && <Fact icon={checks.icon} className={checks.className}>{checks.text}</Fact>}
          {commit.fixes.slice(0, 2).map((fix, index) => (
            <Fact key={index} icon="GitCommit" className="text-success">Fixes {fix.author ?? "a"}’s comment{fix.path !== null && <> on <span className="font-mono">{fix.path.split("/").at(-1)}{fix.line !== null && `:${fix.line}`}</span></>}</Fact>
          ))}
          {commit.fixes.length > 2 && <div className="text-xs text-muted-foreground">and {plural(commit.fixes.length - 2, "more comment")}</div>}
        </div>,
      );
    }
    if (card.check !== null) {
      const run = card.check;
      const state = RUNS[run.state];
      const took = run.startedAt !== null && run.completedAt !== null && run.completedAt >= run.startedAt ? seconds(run.completedAt - run.startedAt) : null;
      parts.push(
        <div key="check" data-link-part="check" className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Icon name={state.icon} fallback="Circle" className={`size-4 shrink-0 ${state.className} ${run.state === "running" ? "animate-spin" : ""}`} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{run.name}</span>
            {run.required === true && <span className="shrink-0 rounded-sm border border-border px-1 text-[10.5px] leading-4 text-muted-foreground">Required</span>}
          </div>
          <div className="text-xs text-muted-foreground">
            {[state.text + (run.detail ? ` (${run.detail})` : ""), took === null ? null : `after ${took}`, run.state === "running" && run.startedAt !== null ? `started ${ago(run.startedAt)}` : null, run.group].filter(Boolean).join(" · ")}
          </div>
          {run.delivery !== null && <Fact icon="Sent" className="text-foreground">{run.delivery === "sent" ? "Sent to the PR’s agent" : "Going to the PR’s agent soon"}</Fact>}
        </div>,
      );
    }
    if (issue !== null) {
      const facts: ReactNode[] = [];
      if (issue.assignees.length > 0) facts.push(<Fact key="assignees" icon="UserRound">Assigned to {issue.assignees.join(", ")}</Fact>);
      facts.push(<Fact key="comments" icon="MessageSquare">{issue.comments === 0 ? "No comments" : plural(issue.comments, "comment")}</Fact>);
      parts.push(
        <div key="issue" data-link-part="issue" className="space-y-1.5">
          {issue.body.trim() !== "" && <div className="line-clamp-3 text-[12.5px] leading-[1.45] text-foreground [overflow-wrap:anywhere]">{clip(issue.body, 240)}</div>}
          {issue.labels.length > 0 && (
            <div className="flex flex-wrap gap-1">{issue.labels.slice(0, 6).map((label) => <LabelChip key={label.name} label={label} maxChars={24} />)}</div>
          )}
          <div className="space-y-1">{facts}</div>
          {issue.closedBy.length > 0 && (
            <div data-link-part="closed-by" className="space-y-1">
              <div className="text-xs text-muted-foreground">{issue.state === "open" ? "Closes when it merges" : "Closed by"}</div>
              {issue.closedBy.map((linked) => {
                const linkedLook = STATE_LOOKS[linked.state];
                return (
                  <button key={`${linked.repo}#${linked.number}`} type="button" title={linked.key !== null ? "Open in Shuttle" : `Open on ${serverName}`}
                    onClick={() => (linked.key !== null ? openPr(linked.key) : (openExternal(navigate, linked.url), onDone()))}
                    className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-xs hover:bg-state-hover">
                    <Icon name={linkedLook.icon} fallback="GitPullRequest" className={`size-3.5 shrink-0 ${linkedLook.className}`} aria-hidden />
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">#{linked.number}</span>
                    <span className="min-w-0 flex-1 truncate">{linked.title}</span>
                    <span className="shrink-0 text-muted-foreground">{linkedLook.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>,
      );
    }
    if (pr !== null && (card.kind === "pr" || parts.length === 0)) parts.push(<div key="facts" className="space-y-1">{prFacts(pr)}</div>);
    body = (
      <div className="space-y-2.5">
        {pr !== null && (card.kind === "pr" || card.kind === "commit" || card.kind === "check") && (
          <div data-link-part="next" className={`rounded-md border px-2.5 py-1.5 ${TONE_PANEL[pr.next.tone]}`}>
            <div className={`text-xs font-semibold ${TONE_TEXT[pr.next.tone] === "text-muted-foreground" ? "text-foreground" : TONE_TEXT[pr.next.tone]}`}>{pr.next.label}</div>
            <div className="mt-0.5 text-xs leading-[1.4] text-muted-foreground">{clip(pr.next.why, 180)}</div>
          </div>
        )}
        {parts}
        {card.note !== null && <div className="text-xs text-muted-foreground">{card.note}</div>}
      </div>
    );
  }

  return (
    <div data-link-card={card?.kind ?? kind} className={sheet ? "px-4 pb-1" : "px-3 py-2.5"}>
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Icon name={look?.icon ?? icon} fallback="GitPullRequest" className={`size-3.5 shrink-0 ${look?.className ?? "text-muted-foreground"}`} aria-hidden />
        <span className="min-w-0 truncate font-mono text-[11.5px] text-foreground">{card?.label ?? url.replace(/^https?:\/\/(www\.)?/u, "")}</span>
        {card && <span className="shrink-0">{card.serverName}</span>}
        <span className="flex-1" />
        {pr !== null && <StatePill state={pr.state} />}
        {issue !== null && <IssuePill state={issue.state} />}
      </div>
      {issue !== null && (
        <>
          <div className="mt-1 line-clamp-2 text-[13.5px] font-semibold leading-snug">{issue.title}</div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {issue.author !== null && <Avatar login={issue.author} size={16} />}
            <span className="truncate">
              {issue.author ?? "Someone"}{issue.createdAt !== null && ` opened it ${ago(issue.createdAt)}`}
              {issue.closedAt !== null && ` · ${issue.state === "not_planned" ? "closed as not planned" : "closed"} ${ago(issue.closedAt)}`}
            </span>
          </div>
        </>
      )}
      {pr !== null && (
        <>
          <div className="mt-1 line-clamp-2 text-[13.5px] font-semibold leading-snug">{pr.title}</div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Avatar login={pr.author} bot={pr.bot} size={16} />
            <span className="truncate">{pr.mine ? "You" : pr.author}{pr.createdAt !== null && ` opened it ${ago(pr.createdAt)}`}{pr.base !== null && ` · into ${pr.base}`}</span>
          </div>
        </>
      )}
      <div className="mt-2">{body}</div>
      <div className={`mt-2.5 flex flex-wrap items-center gap-1.5 ${sheet ? "pb-1 [&>button]:h-10 [&>button]:flex-1 [&>button]:justify-center [&>button]:text-sm" : ""}`}>
        {card?.prKey && (
          <button type="button" className={BUTTON_PRIMARY} onClick={openInShuttle}>
            <Icon name="shuttle/shuttle" fallback="GitPullRequest" className="size-3.5" aria-hidden />{pr === null ? "Look it up in Shuttle" : "Open in Shuttle"}
          </button>
        )}
        <button type="button" className={BUTTON} onClick={openOnServer}>
          <Icon name="ExternalLink" className="size-3.5" aria-hidden />Open on {serverName}
        </button>
      </div>
    </div>
  );
}
