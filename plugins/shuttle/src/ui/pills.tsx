import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { PrView } from "../contract";
import { Pill } from "./common";
import { age, clock, plural } from "./format";

export const isLive = (pr: Pick<PrView, "state">) => pr.state === "open" || pr.state === "draft";

const DAY = 24 * 60 * 60_000;

export function StatePill({ state }: { state: PrView["state"] }) {
  if (state === "draft") return <Pill icon="GitPullRequestDraft">Draft</Pill>;
  if (state === "merged") return <Pill tone="info" icon="GitMerge">Merged</Pill>;
  if (state === "closed") return <Pill tone="bad" icon="GitPullRequestClosed">Closed</Pill>;
  return <Pill tone="ok" icon="GitPullRequest">Open</Pill>;
}

/** "Checks pass", "2 checks fail" or "Checks 5/7", from the counts when the server sent them. */
export function ChecksPill({ pr, failingOnly = false }: { pr: Pick<PrView, "checks" | "checkCounts">; failingOnly?: boolean }) {
  const counts = pr.checkCounts;
  if (pr.checks === "passed") return failingOnly ? null : <Pill tone="ok" icon="Check">Checks pass</Pill>;
  if (pr.checks === "failed") {
    return <Pill tone="bad" icon="X">{counts !== null && counts.failed > 0 ? `${plural(counts.failed, "check")} fail` : "Checks fail"}</Pill>;
  }
  if (pr.checks === "pending") return <Pill tone="warn" icon="Clock">{counts !== null ? `Checks ${counts.passed}/${counts.total}` : "Checks running"}</Pill>;
  return null;
}

/** Approved, Changes requested, or how long it has waited for a first review. */
export function ReviewPill({ pr }: { pr: Pick<PrView, "review" | "state" | "createdAt"> }) {
  if (pr.review === "approved") return <Pill tone="ok" icon="Check">Approved</Pill>;
  if (pr.review === "changes") return <Pill tone="bad">Changes requested</Pill>;
  if (pr.state === "draft") return null;
  const waited = pr.createdAt === null ? null : Date.now() - pr.createdAt;
  return <Pill tone={waited !== null && waited > 2 * DAY ? "warn" : "neutral"} icon="Clock">{waited === null ? "No review" : `No review · ${age(pr.createdAt!)}`}</Pill>;
}

/** Who handles the PR's feedback: nobody (dashed), an agent that fixes, or one that is only told. */
export function AgentPill({ pr }: { pr: Pick<PrView, "agent" | "state"> }) {
  if (!isLive(pr)) return null;
  const agent = pr.agent;
  if (agent === null || agent.mode === "off") {
    return (
      <span data-pill="none" className="inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-dashed border-border px-2 text-[11.5px] leading-none text-muted-foreground">
        <Icon name="Bot" className="size-3" aria-hidden />No agent
      </span>
    );
  }
  const status = agent.status === "waiting" ? { text: "needs you", className: "text-warning-text" } : agent.status === "working" ? { text: "fixing", className: "text-primary" } : null;
  return (
    <Pill tone={agent.mode === "fix" ? "info" : "neutral"} icon="Bot">
      {agent.mode === "fix" ? "Agent fixes" : "Agent told"}
      {status !== null && <> · <b className={`font-semibold ${status.className}`}>{status.text}</b></>}
    </Pill>
  );
}

/** Where your review of someone else's PR stands. */
export function MyReviewPill({ pr }: { pr: PrView }) {
  if (pr.draft !== null) return <Pill tone="info" icon="Check">Draft ready</Pill>;
  if (pr.lastReview?.state === "running") return <Pill tone="info" icon="Bot">AI reviewing</Pill>;
  if (pr.next.kind === "rereview") return <Pill tone="warn" icon="RotateCcw">Updated since</Pill>;
  if (pr.myReview === null) return null;
  if (pr.myReview.verdict === "approve") return <Pill tone="ok" icon="Check">You approved</Pill>;
  return <Pill icon="Check">You reviewed</Pill>;
}

/** Why someone else's PR is in Reviews: you, your teams, a mention, or Track. */
export function ReasonPills({ pr }: { pr: Pick<PrView, "reasons" | "teams" | "tracked"> }) {
  const has = (reason: string) => pr.reasons.some((item) => item.reason === reason);
  const teams = pr.teams;
  return (
    <>
      {has("requested") && <Pill tone="info" icon="UserRound">You</Pill>}
      {has("team") && <Pill icon="UserRoundPlus" title={teams.join("\n")}>{teams.length === 0 ? "Your team" : teams.length > 1 ? `${teams[0]} +${teams.length - 1}` : teams[0]}</Pill>}
      {has("mentioned") && <Pill icon="Mail">Mentioned</Pill>}
      {pr.tracked && <Pill icon="Pin">Tracked</Pill>}
    </>
  );
}

export function SizeChip({ pr }: { pr: Pick<PrView, "additions" | "deletions"> & { size: string | null } }) {
  if (pr.size === null) return null;
  return (
    <span data-size={pr.size} title={`${(pr.additions ?? 0) + (pr.deletions ?? 0)} lines`}
      className="rounded border border-border bg-background px-1 text-[10.5px] font-bold leading-4 text-muted-foreground">
      {pr.size}
    </span>
  );
}

export function StalePill({ pr }: { pr: Pick<PrView, "stale" | "staleSince" | "serverName"> }) {
  if (!pr.stale) return null;
  return (
    <Pill tone="warn" icon="Clock" title={`${pr.serverName}'s last sync could not read this PR, so this is what Shuttle had before`}>
      {pr.staleSince === null ? "May be out of date" : `Data from ${clock(pr.staleSince)}`}
    </Pill>
  );
}
