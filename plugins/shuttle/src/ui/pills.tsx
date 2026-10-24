import type { PrView, ReviewRunView } from "../contract";
import { Pill } from "./common";
import { plural } from "./format";

export function StatePill({ state }: { state: PrView["state"] }) {
  if (state === "draft") return <Pill icon="GitPullRequestDraft">Draft</Pill>;
  if (state === "merged") return <Pill tone="brand" icon="GitMerge">Merged</Pill>;
  if (state === "closed") return <Pill tone="bad" icon="GitPullRequestClosed">Closed</Pill>;
  return <Pill tone="ok" icon="GitPullRequest">Open</Pill>;
}

export function ChecksPill({ checks }: { checks: PrView["checks"] }) {
  if (checks === "passed") return <Pill tone="ok" icon="Check">Checks pass</Pill>;
  if (checks === "failed") return <Pill tone="bad" icon="X">Checks fail</Pill>;
  if (checks === "pending") return <Pill tone="warn" icon="Clock">Checks running</Pill>;
  return null;
}

export function ReviewPill({ review }: { review: PrView["review"] }) {
  if (review === "approved") return <Pill tone="ok">Approved</Pill>;
  if (review === "changes") return <Pill tone="bad">Changes requested</Pill>;
  if (review === "required") return <Pill>Review required</Pill>;
  return null;
}

export function ReasonPills({ pr }: { pr: Pick<PrView, "reasons"> }) {
  return (
    <>
      {pr.reasons.map(({ reason, teams }) => {
        if (reason === "requested") return <Pill key={reason} tone="info" icon="UserRound">Requested you</Pill>;
        if (reason === "team") return <Pill key={reason} icon="UserRoundPlus">{teams.length > 0 ? teams.join(", ") : "Your team"}</Pill>;
        if (reason === "mentioned") return <Pill key={reason} icon="Mail">Mentioned you</Pill>;
        return null;
      })}
    </>
  );
}

function WatchPill({ watch }: { watch: PrView["watch"] }) {
  if (watch === null) return null;
  return <Pill tone="ok" icon="Eye">{watch === "act" ? "Watching: send and act" : "Watching: send only"}</Pill>;
}

export function LastReviewPill({ run }: { run: ReviewRunView | null }) {
  if (run === null) return null;
  const who = run.trigger === "auto" ? "Auto review" : "Review";
  if (run.state === "running") return <Pill tone="brand" icon="Bot">{who} running</Pill>;
  if (run.state === "failed") return <Pill tone="bad" icon="Bot">{who} failed</Pill>;
  return <Pill tone="brand" icon="Bot">{who} done</Pill>;
}

export function PrPills({ pr }: { pr: PrView }) {
  return (
    <>
      <StatePill state={pr.state} />
      <ChecksPill checks={pr.checks} />
      <ReviewPill review={pr.review} />
      <ReasonPills pr={pr} />
      <WatchPill watch={pr.watch} />
      <LastReviewPill run={pr.lastReview} />
      {pr.pendingItems > 0 && <Pill tone="info">{plural(pr.pendingItems, "new item")}</Pill>}
      {pr.stale && <Pill tone="warn" icon="AlertTriangle" title="This server's last sync failed">May be out of date</Pill>}
    </>
  );
}
