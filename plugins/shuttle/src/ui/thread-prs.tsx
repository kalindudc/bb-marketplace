import {
  experimental_Icon as Icon, experimental_InfoList as InfoList, experimental_InfoListRow as InfoListRow, experimental_InfoSection as InfoSection,
  type ExperimentalThreadContextSegmentInput, type ExperimentalThreadContextSegmentProps, type ExperimentalThreadInfoProps,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useRef } from "react";
import type { PrView } from "../contract";
import type { Tone } from "./common";
import { useShuttleQuery } from "./data";
import { plural, shortKey } from "./format";
import { rememberPanelPr, threadPrsOpen } from "./prefs";
import { useOpenShuttleTab } from "./tab";

interface Attention {
  label: string;
  tone: Tone;
  /** Higher is worse; a thread's summary shows its worst PR. */
  rank: number;
}

const STATE_LABELS: Record<PrView["state"], string> = { open: "open", draft: "draft", merged: "merged", closed: "closed" };

function attentionOf(pr: PrView): Attention {
  if (pr.review === "changes") return { label: "changes requested", tone: "bad", rank: 3 };
  if (pr.checks === "failed") return { label: "checks failing", tone: "bad", rank: 2 };
  if (pr.pendingItems > 0) return { label: `${pr.pendingItems} unsent`, tone: "info", rank: 1 };
  return { label: STATE_LABELS[pr.state], tone: "neutral", rank: 0 };
}

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  ok: "text-success",
  bad: "text-destructive-text",
  warn: "text-warning-text",
  info: "text-foreground",
  brand: "text-foreground",
};

function useThreadPrs(threadId: string): PrView[] {
  return useShuttleQuery("threadPrs", { threadId }).data?.prs ?? [];
}

/** Opens the Shuttle tab on one PR in full. */
function useOpenPr(threadId: string) {
  const openTab = useOpenShuttleTab();
  return (pr: PrView) => {
    rememberPanelPr(threadId, pr.key);
    openTab(threadId);
  };
}

function ChecksGlyph({ checks }: { checks: PrView["checks"] }) {
  if (checks === "passed") return <Icon name="Check" aria-label="Checks pass" className="size-3.5 text-success" />;
  if (checks === "failed") return <Icon name="X" aria-label="Checks fail" className="size-3.5 text-destructive-text" />;
  if (checks === "pending") return <Icon name="Clock" aria-label="Checks running" className="size-3.5 text-warning-text" />;
  return null;
}

function Trailing({ pr, threadId }: { pr: PrView; threadId: string }) {
  const agent = pr.agent;
  return (
    <span className="inline-flex items-center gap-1.5">
      <ChecksGlyph checks={pr.checks} />
      {agent !== null && agent.mode !== "off" && (
        <Icon name="Bot" aria-label={agent.threadId === threadId ? "This thread is the agent" : `Agent: ${agent.title}`} className={`size-3.5 ${agent.threadId === threadId ? "text-success" : "text-muted-foreground"}`} />
      )}
    </span>
  );
}

const contextOf = (pr: PrView) => {
  const attention = attentionOf(pr);
  return attention.rank === 0 ? STATE_LABELS[pr.state] : `${STATE_LABELS[pr.state]} · ${attention.label}`;
};

/** The thread Info tab's "Pull requests": every PR linked to the thread. */
export function PullRequestsInfo({ threadId }: ExperimentalThreadInfoProps) {
  const prs = useThreadPrs(threadId);
  const openPr = useOpenPr(threadId);
  if (prs.length === 0) return null;
  return (
    <InfoSection label="Pull requests" count={prs.length}>
      <InfoList items={prs} getKey={(pr) => pr.key} renderItem={(pr) => (
        <InfoListRow
          leading={<Icon name="GitPullRequest" className="size-4" aria-hidden />}
          leadingLabel={pr.serverName}
          name={shortKey(pr)}
          title={pr.title}
          context={contextOf(pr)}
          trailing={<Trailing pr={pr} threadId={threadId} />}
          onSelect={() => openPr(pr)}
        />
      )} />
    </InfoSection>
  );
}

export const useHasThreadPrs = ({ threadId }: ExperimentalThreadContextSegmentInput) => useThreadPrs(threadId).length > 0;

/** bb does not remember which segment was open, so the list reopens once per thread when it was left open on this device. */
function useReopen(threadId: string, isExpanded: boolean, onToggle: () => void) {
  const reopened = useRef<string | null>(null);
  useEffect(() => {
    if (reopened.current === threadId) return;
    reopened.current = threadId;
    if (threadPrsOpen.get() && !isExpanded) onToggle();
  }, [threadId, isExpanded, onToggle]);
}

/** One PR's key and state, or "N PRs" and the worst state among them. */
export function PullRequestsSummary({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const prs = useThreadPrs(threadId);
  useReopen(threadId, isExpanded, onToggle);
  if (prs.length === 0) return null;
  const worst = prs.map(attentionOf).reduce((a, b) => (b.rank > a.rank ? b : a));
  const only = prs.length === 1 ? prs[0]! : null;
  const label = only !== null ? shortKey(only) : `${prs.length} PRs`;
  const named = only !== null ? shortKey(only) : plural(prs.length, "linked PR");
  return (
    <button type="button" data-segment-summary aria-expanded={isExpanded}
      onClick={() => {
        threadPrsOpen.set(!isExpanded);
        onToggle();
      }}
      aria-label={`Shuttle: ${named}, ${worst.label}`} title={isExpanded ? "Hide the linked PRs" : "Show the linked PRs"}
      className="flex min-h-6 items-center gap-1.5 overflow-hidden rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
      <Icon name="shuttle/shuttle" fallback="GitPullRequest" className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate font-mono">{label}</span>
      {(only !== null || worst.rank > 0) && (
        <>
          <span aria-hidden>·</span>
          <span className={`truncate ${TONE_TEXT[worst.tone]}`}>{worst.label}</span>
        </>
      )}
      <Icon name={isExpanded ? "ChevronDown" : "ChevronRight"} className="size-3 shrink-0" aria-hidden />
    </button>
  );
}

export function PullRequestsDetails({ threadId, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const prs = useThreadPrs(threadId);
  const openPr = useOpenPr(threadId);
  if (!isExpanded) return null;
  return (
    <ul aria-label="Linked pull requests" className="flex max-h-48 flex-col overflow-y-auto py-1">
      {prs.map((pr) => {
        const attention = attentionOf(pr);
        return (
          <li key={pr.key} data-pr={pr.key}>
            <button type="button" onClick={() => openPr(pr)} title={pr.title}
              className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-state-hover">
              <span className="shrink-0 font-mono">{shortKey(pr)}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{pr.title}</span>
              <span className={`shrink-0 ${TONE_TEXT[attention.tone]}`}>{attention.label}</span>
              <Trailing pr={pr} threadId={threadId} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function PullRequestsAction({ threadId }: ExperimentalThreadContextSegmentProps) {
  const openTab = useOpenShuttleTab();
  return (
    <button type="button" aria-label="Open the Shuttle tab" title="Open the Shuttle tab" onClick={() => openTab(threadId)}
      className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
      <Icon name="PanelRight" className="size-3.5" aria-hidden />
    </button>
  );
}
