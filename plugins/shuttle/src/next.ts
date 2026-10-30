// What happens next with a PR, decided once on the server so the Inbox, the rows and the PR view
// always say the same thing. Pure: views.ts gathers the facts.
import type { AgentView, CheckCounts, InboxRuleKind, MyReview, NextAction, NextKind, NextStep, NextTone, PrState, Reason, Reviewer, ReviewRunView, ReviewState, CheckState } from "./contract";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A PR of yours waiting this long for a first review reads as a warning. */
const SLOW_REVIEW_MS = 2 * DAY;

export interface NextFacts {
  now: number;
  mine: boolean;
  state: PrState;
  checks: CheckState;
  checkCounts: CheckCounts | null;
  review: ReviewState;
  head: string | null;
  author: string;
  createdAt: number | null;
  updatedAt: number | null;
  reviewers: Reviewer[] | null;
  agent: AgentView | null;
  suggestedAgent: { title: string } | null;
  handled: boolean;
  autoMerge: boolean;
  snoozed: boolean;
  /** Dismissed from the Inbox, or a rule keeps it out. */
  keptOut: boolean;
  /** The server has the commands. */
  can: { merge: boolean; comment: boolean; ready: boolean; reopen: boolean; cancelAutoMerge: boolean; approve: boolean };
  // other people's PRs
  reasons: Reason[];
  teams: string[];
  tracked: boolean;
  bot: boolean;
  requestedAt: number | null;
  lastReview: ReviewRunView | null;
  lastReviewFinishedAt: number | null;
  /** A draft, posted or discarded, came from the last review. */
  lastReviewHandled: boolean;
  draft: { findings: number; preset: string | null; auto: boolean } | null;
  myReview: MyReview | null;
  additions: number | null;
  deletions: number | null;
  files: number | null;
  inboxRequests: boolean;
  inboxRequestDays: number;
}

export function agoText(ms: number): string {
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return plural(Math.round(ms / MINUTE), "minute", " ago");
  if (ms < DAY) return plural(Math.round(ms / HOUR), "hour", " ago");
  return plural(Math.round(ms / DAY), "day", " ago");
}

export function shortAge(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))}m`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
  return `${Math.round(ms / DAY)}d`;
}

function plural(n: number, word: string, suffix = ""): string {
  return `${n} ${word}${n === 1 ? "" : "s"}${suffix}`;
}

function names(list: string[]): string {
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

const act = (id: NextAction, label: string) => ({ id, label });

function step(kind: NextKind, tone: NextTone, label: string, why: string, extra: Partial<Pick<NextStep, "clears" | "inbox" | "primary" | "more">> = {}): NextStep {
  return { kind, tone, label, why, clears: extra.clears ?? null, inbox: extra.inbox ?? false, primary: extra.primary ?? null, more: extra.more ?? [] };
}

function feedbackText(f: NextFacts): string {
  const parts: string[] = [];
  if (f.review === "changes") {
    const who = (f.reviewers ?? []).filter((r) => r.state === "changes").map((r) => r.login);
    parts.push(who.length ? `changes requested by ${names(who)}` : "changes requested");
  }
  if (f.checks === "failed") parts.push(f.checkCounts?.failed ? plural(f.checkCounts.failed, "check") + " failing" : "checks failing");
  return names(parts);
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The agent can receive feedback: it exists, is on, and its thread is not archived. */
export const agentActive = (agent: AgentView | null): agent is AgentView => agent !== null && agent.mode !== "off" && agent.status !== "archived";

function mineNext(f: NextFacts): NextStep {
  if (f.state === "merged") return step("merged", "neutral", "Merged", "Merged.");
  if (f.state === "closed") return step("closed", "neutral", "Closed", "Closed without merging.", { primary: f.can.reopen ? act("reopen", "Reopen") : null });
  const agent = f.agent;
  const active = agentActive(agent) ? agent : null;
  if (active?.status === "waiting") {
    return step("agent_waiting", "warn", "The agent needs your answer", `\u201c${active.title}\u201d asked you something in its thread.`, {
      inbox: true,
      clears: "Leaves when you answer in the thread.",
      primary: act("open_agent", "Answer in the thread"),
    });
  }
  const feedback = f.review === "changes" || f.checks === "failed";
  // A draft is work in progress: its failing checks are not news until it is ready.
  if (f.state === "draft" && !active) {
    const note = feedback ? `${capital(feedbackText(f))}. ` : "";
    return step("draft", "neutral", "Draft", `${note}Reviewers are not notified until it is ready.`, { primary: f.can.ready ? act("ready", "Ready for review") : null });
  }
  if (feedback && !active) {
    const what = feedbackText(f);
    if (f.handled) {
      return step("yours", "neutral", "You\u2019re on it", `You took ${what} yourself. New feedback brings it back to your Inbox.`, { more: [act("pick_agent", "Hand it to an agent")] });
    }
    const why = agent === null ? "It has no agent" : agent.status === "archived" ? "Its agent\u2019s thread is archived" : "Its agent is off";
    return step("nobody", "bad", f.review === "changes" ? "Changes requested, and nobody is on it" : "Checks fail, and nobody is on it", `${capital(what)}. ${why}, so nothing has been sent anywhere.`, {
      inbox: true,
      clears: "Leaves when an agent takes it or you say you\u2019ll do it. New feedback brings it back.",
      primary: f.suggestedAgent ? act("assign_suggested", "Hand it to its thread") : act("pick_agent", "Hand it to an agent"),
      more: [act("handle", "I\u2019ll do it")],
    });
  }
  if (feedback && active) {
    const what = feedbackText(f);
    return active.mode === "fix"
      ? step("agent_on_it", "info", "The agent is on it", `\u201c${active.title}\u201d has ${what} and is asked to fix it.`, { more: [act("open_agent", "Open the thread")] })
      : step("agent_on_it", "info", "Sent to its thread", `\u201c${active.title}\u201d was told about ${what}, and not asked to fix it.`, { more: [act("open_agent", "Open the thread")] });
  }
  if (f.state === "draft") {
    return step("draft", "neutral", "Draft", "Reviewers are not notified until it is ready.", { primary: f.can.ready ? act("ready", "Ready for review") : null });
  }
  const counts = f.checkCounts;
  if (f.autoMerge) {
    const pending = counts ? counts.pending : 0;
    return step("auto_merge", "ok", "Merges when checks pass", pending ? `Auto-merge is on: ${plural(pending, "check")} still running.` : "Auto-merge is on.", {
      more: f.can.cancelAutoMerge ? [act("cancel_auto_merge", "Cancel auto-merge")] : [],
    });
  }
  const approvers = (f.reviewers ?? []).filter((r) => r.state === "approved").map((r) => r.login);
  const approved = approvers.length ? `Approved by ${names(approvers)}` : "Approved";
  if (f.review === "approved" && (f.checks === "passed" || f.checks === "none")) {
    const checks = f.checks === "passed" ? (counts?.total ? `, and all ${counts.total} checks pass` : ", and its checks pass") : "; its server reports no checks";
    return step("ready_to_merge", "ok", "Ready to merge", `${approved}${checks}.`, {
      inbox: true,
      clears: "Leaves when it merges, or when you snooze it.",
      primary: f.can.merge ? act("merge", "Merge\u2026") : null,
    });
  }
  if (f.review === "approved") {
    return step("approved_pending", "ok", "Approved, checks running", counts?.total ? `${approved}. ${counts.passed} of ${counts.total} checks done.` : `${approved}. Checks are still running.`, {
      primary: f.can.merge ? act("merge", "Merge when ready\u2026") : null,
    });
  }
  const since = f.createdAt ?? f.updatedAt;
  const waited = since === null ? null : f.now - since;
  const asked = (f.reviewers ?? []).filter((r) => r.state === "requested");
  const people = asked.filter((r) => !r.team).length;
  const label = waited === null ? "Waiting for review" : `Waiting for review \u00b7 ${shortAge(waited)}`;
  const why = asked.length === 0 && f.reviewers !== null ? "Nobody is asked to review it yet." : asked.length ? `${plural(asked.length, "reviewer")} asked; nobody has approved yet.` : "Nobody has approved it yet.";
  const checksNote = f.checks === "pending" && counts?.total ? ` Checks: ${counts.passed} of ${counts.total} done.` : "";
  return step("waiting_review", waited !== null && waited > SLOW_REVIEW_MS ? "warn" : "neutral", label, why + checksNote, {
    more: f.can.comment && people > 0 ? [act("nudge", "Nudge reviewers")] : [],
  });
}

const VERDICT_WORDS: Record<MyReview["verdict"], string> = { approve: "approved", changes: "requested changes", comment: "commented", dismissed: "reviewed" };

function size(f: NextFacts): string {
  const lines = f.additions !== null && f.deletions !== null ? `+${f.additions} \u2212${f.deletions}` : null;
  const files = f.files !== null ? plural(f.files, "file") : null;
  return [lines, files].filter(Boolean).join(" in ");
}

function othersNext(f: NextFacts): NextStep {
  if (f.state === "merged") return step("merged", "neutral", "Merged", "Merged.");
  if (f.state === "closed") return step("closed", "neutral", "Closed", "Closed without merging.");
  const run = f.lastReview;
  const reviewMore = f.can.approve ? [act("approve", "Approve\u2026")] : [];
  if (f.draft) {
    const from = f.draft.preset ? ` from ${f.draft.preset}${f.draft.auto ? " (started by auto review)" : ""}` : "";
    return step("post", "info", "AI review ready: choose what to post", `${plural(f.draft.findings, "finding")}${from}. Nothing is posted yet.`, {
      inbox: true,
      clears: "Leaves when you post it or discard it.",
      primary: act("choose", "Choose what to post"),
    });
  }
  if (run?.state === "running") {
    return step("running", "info", "AI review running", `${run.preset} in \u201c${run.title}\u201d, started ${agoText(f.now - run.at)}. Its findings land here.`, {
      more: [act("open_review", "Open the thread")],
    });
  }
  const my = f.myReview;
  const reviewedAfterRun = my?.at != null && f.lastReviewFinishedAt !== null && my.at >= f.lastReviewFinishedAt;
  if (run?.state === "failed" && !reviewedAfterRun) {
    return step("review_failed", "bad", "The review thread failed", `\u201c${run.title}\u201d stopped with an error.`, {
      inbox: true,
      clears: "Leaves when you start another review, or when you snooze it.",
      primary: act("review", "Try again\u2026"),
      more: [act("open_review", "Open the thread")],
    });
  }
  if (run?.state === "done" && !f.lastReviewHandled && !reviewedAfterRun) {
    return step("review_done", "info", "AI review finished", `${run.preset} finished in \u201c${run.title}\u201d without a draft for Shuttle. Read it in its thread.`, {
      inbox: true,
      clears: "Leaves when you review it, or when you snooze it.",
      primary: act("open_review", "Read it in its thread"),
      more: reviewMore,
    });
  }
  if (my) {
    const when = my.at !== null ? ` ${agoText(f.now - my.at)}` : "";
    const askedAgain = f.reasons.includes("requested") && f.requestedAt !== null && my.at !== null && f.requestedAt > my.at;
    const moved = my.head !== null && f.head !== null && my.head !== f.head;
    if (askedAgain || moved) {
      const why = askedAgain ? `${f.author} asked you to review again since you ${VERDICT_WORDS[my.verdict]}${when}.` : `New commits since you ${VERDICT_WORDS[my.verdict]}${when}.`;
      return step("rereview", "warn", "Updated after your review", why, {
        inbox: askedAgain || my.verdict !== "approve",
        clears: "Leaves when you review again, or when you snooze it.",
        primary: act("review", "Re-review\u2026"),
        more: reviewMore,
      });
    }
    const label = my.verdict === "approve" ? "You approved" : my.verdict === "changes" ? "You requested changes" : my.verdict === "comment" ? "You commented" : "You reviewed";
    return step("reviewed", my.verdict === "approve" ? "ok" : "neutral", my.at !== null ? `${label} \u00b7 ${shortAge(f.now - my.at)}` : label, "Waiting on the author. It comes back to your Inbox when they push or ask again.");
  }
  const byName = f.reasons.includes("requested") || f.reasons.includes("mentioned");
  if (byName || f.reasons.includes("team")) {
    const age = f.requestedAt !== null ? f.now - f.requestedAt : null;
    const fresh = byName && f.inboxRequests && !f.bot && age !== null && age < f.inboxRequestDays * DAY;
    const who = f.reasons.includes("requested") ? "you" : f.reasons.includes("mentioned") ? "mentioned you" : f.teams.length ? f.teams[0]! : "your team";
    const asked = who === "mentioned you" ? `${f.author} mentioned you` : `${f.author} asked ${who}`;
    const facts = [`${asked}${age !== null ? ` ${agoText(age)}` : ""}`, size(f)].filter(Boolean).join(" \u00b7 ");
    if (fresh) {
      return step("new_request", "info", f.reasons.includes("requested") ? "New review request" : "Mentioned you", `${facts}.`, {
        inbox: true,
        clears: `Leaves when you start a review or say Not now. After ${plural(f.inboxRequestDays, "day")} it waits in Reviews.`,
        primary: act("review", "Start AI review"),
        more: [act("not_now", "Not now"), ...reviewMore],
      });
    }
    return step("not_reviewed", "neutral", age !== null ? `Not reviewed \u00b7 asked ${shortAge(age)} ago` : "Not reviewed", `${facts}.`, {
      primary: act("review", "Start AI review"),
      more: reviewMore,
    });
  }
  return f.tracked
    ? step("looked_up", "neutral", "Tracked", "You track it. It comes to your Inbox when it changes after your review.", { primary: act("review", "Start AI review"), more: reviewMore })
    : step("looked_up", "neutral", "Not in your lists", "You looked this up. Track it to keep it in Reviews.", { primary: act("track", "Track"), more: [act("review", "Start AI review"), ...reviewMore] });
}

/** The step as if nothing held the PR out of the Inbox. */
export function stepOf(f: NextFacts): NextStep {
  return f.mine ? mineNext(f) : othersNext(f);
}

/** A snooze, a dismissal or a rule holds every card out of the Inbox, so each means the same on every kind. */
export function nextStep(f: NextFacts, step: NextStep = stepOf(f)): NextStep {
  return (f.snoozed || f.keptOut) && step.inbox ? { ...step, inbox: false } : step;
}

/** It mentions you and nobody asked you by name; your own PRs never count. */
export function mentionOnly(pr: { mine: boolean; reasons: readonly Reason[] }): boolean {
  return !pr.mine && pr.reasons.includes("mentioned") && !pr.reasons.includes("requested");
}

/** Logins and repos belong to a server, so every rule names one. */
export function ruleMatches(
  rule: { kind: InboxRuleKind; server: string; value: string },
  pr: { mine: boolean; server: string; author: string; repo: string; reasons: readonly Reason[] },
): boolean {
  if (pr.server !== rule.server) return false;
  switch (rule.kind) {
    case "author":
      return !pr.mine && pr.author === rule.value;
    case "repo":
      return pr.repo === rule.value;
    case "mention":
      return pr.repo === rule.value && mentionOnly(pr);
  }
}

/** The Inbox's order: what blocks others or waits on you first. */
export const INBOX_ORDER: readonly NextKind[] = ["agent_waiting", "nobody", "ready_to_merge", "post", "review_failed", "review_done", "rereview", "new_request"];

/** The feedback a "I'll do it" covers: who asked for changes or commented, and failing checks on this head. */
export function feedbackSignature(reviewers: Reviewer[] | null, checks: CheckState, head: string | null): string[] {
  const out = (reviewers ?? []).filter((r) => r.state === "changes" || r.state === "commented").map((r) => `${r.login}:${r.state}:${r.at ?? ""}`);
  if (checks === "failed") out.push(`checks:${head ?? ""}`);
  return out.sort();
}

/** Handled holds while every piece of current feedback was already there when the user took it. */
export function stillHandled(sig: string | null, current: string[]): boolean {
  if (sig === null) return false;
  const taken = new Set(JSON.parse(sig) as string[]);
  return current.every((part) => taken.has(part));
}

/** The phase a PR of yours is in, for Insights. */
export function phaseOf(state: PrState, review: ReviewState, checks: CheckState): string | null {
  if (state === "draft") return "draft";
  if (state !== "open") return null;
  if (review === "changes" || checks === "failed") return "fixing";
  if (review === "approved") return "approved";
  return "waiting";
}
