import type { ReactNode } from "react";
import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { CheckRun, CheckState, ConversationItem, PrDetails, PrView, RunState } from "../contract";
import { BUTTON_GHOST } from "./common";
import { openExternal } from "./data";
import { ago, checkName, plural, seconds } from "./format";
import { usePrState } from "./pr-state";
import { Tag, tagOf } from "./tags";

export interface ChecksSummary {
  state: CheckState;
  /** By state; null when the server gave the overall state only. */
  counts: Record<RunState, number> & { total: number } | null;
  /** Names of the failing checks. */
  failing: string[];
  /** Every check is listed, not only the failing ones. */
  listed: boolean;
}

const RANK: Record<CheckState, number> = { none: 0, passed: 1, pending: 2, failed: 3 };

/**
 * Where the head's checks stand: from the full list when the server sent one, else from the PR's counts and failed
 * items. A list the server cut short cannot say that everything passed, so the PR's own state and counts, which cover
 * every check, win over it.
 */
export function checksSummary(pr: PrView, items: readonly ConversationItem[] | undefined, details: PrDetails | null): ChecksSummary {
  const list = details?.checks ?? null;
  if (list !== null) {
    const count = (state: RunState) => list.items.filter((run) => run.state === state).length;
    const seen = { failed: count("failed"), running: count("running"), passed: count("passed"), skipped: count("skipped"), total: list.total };
    const fromList: CheckState = seen.failed > 0 ? "failed" : seen.running > 0 ? "pending" : list.items.length === 0 ? "none" : "passed";
    const failing = list.items.filter((run) => run.state === "failed").map((run) => run.name);
    if (list.total <= list.items.length) return { state: fromList, counts: seen, failing, listed: true };
    const known = pr.checkCounts;
    // Without the PR's counts the numbers are unknown, not the visible ones: the card then says "Failing" alone.
    const counts = known === null ? null : { failed: known.failed, running: known.pending, passed: known.passed, skipped: Math.max(0, known.total - known.failed - known.pending - known.passed), total: Math.max(known.total, list.total) };
    const state = RANK[pr.checks] > RANK[fromList] ? pr.checks : fromList;
    // The first checks passing says nothing of the rest when the server gave no state of its own: claim nothing.
    return { state: state === "passed" && pr.checks === "none" ? "none" : state, counts, failing, listed: true };
  }
  const failing = (items ?? []).filter((item) => item.kind === "check").map((item) => checkName(item.body));
  const known = pr.checkCounts;
  const counts = known === null ? null : { failed: known.failed, running: known.pending, passed: known.passed, skipped: 0, total: known.total };
  return { state: pr.checks, counts, failing, listed: false };
}

const LOOKS: Record<RunState, { icon: string; className: string; title: string }> = {
  failed: { icon: "CircleX", className: "text-destructive-text", title: "Failing" },
  running: { icon: "Loading", className: "text-warning-text", title: "Running" },
  passed: { icon: "CircleCheck", className: "text-success", title: "Passed" },
  skipped: { icon: "Minus", className: "text-muted-foreground", title: "Skipped" },
};

const durationOf = (run: CheckRun) =>
  run.startedAt !== null && run.completedAt !== null && run.completedAt >= run.startedAt ? seconds(run.completedAt - run.startedAt) : null;

function Row({ pr, run, items }: { pr: PrView; run: CheckRun; items: readonly ConversationItem[] }) {
  const navigate = useBbNavigate();
  const look = LOOKS[run.state];
  const item = run.itemId === null ? undefined : items.find((entry) => entry.id === run.itemId);
  const tag = item === undefined ? null : tagOf(pr, item);
  const sub = [run.group, run.state === "running" && run.startedAt !== null ? `started ${ago(run.startedAt)}` : null, run.detail].filter(Boolean).join(" · ");
  const duration = durationOf(run);
  return (
    <li data-check={run.name} data-run={run.state} className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-border px-3 py-2 text-[13px]">
      <Icon name={look.icon} fallback="Circle" className={`size-4 ${look.className} ${run.state === "running" ? "animate-spin" : ""}`} aria-label={look.title} />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{run.name}</span>
          {run.required === true && <span className="shrink-0 rounded border border-border px-1 text-[10.5px] leading-4 text-muted-foreground">Required</span>}
        </div>
        {sub !== "" && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {tag !== null && <Tag tag={tag} />}
        {duration !== null && <span>{duration}</span>}
        {run.url !== null && (
          <button type="button" className="inline-flex cursor-pointer items-center gap-1 text-primary hover:underline" onClick={() => openExternal(navigate, run.url!)}>
            {run.state === "running" ? "Watch" : "Log"}<Icon name="ExternalLink" className="size-3" aria-hidden />
          </button>
        )}
      </div>
    </li>
  );
}

function Group({ pr, state, runs, items, open: initial }: { pr: PrView; state: RunState; runs: readonly CheckRun[]; items: readonly ConversationItem[]; open: boolean }) {
  const [open, setOpen] = usePrState(pr.key, "open", initial, `checks/${state}`);
  if (runs.length === 0) return null;
  const required = runs.filter((run) => run.required === true).length;
  return (
    <section aria-label={`${LOOKS[state].title} checks`} data-check-group={state} className="mb-2.5 overflow-hidden rounded-lg border border-border bg-card">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[13px] font-semibold hover:bg-state-hover">
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5 text-muted-foreground" aria-hidden />
        {LOOKS[state].title} · {runs.length}
        <span className="flex-1" />
        {required > 0 && <span className="text-xs font-normal text-muted-foreground">{required} required</span>}
      </button>
      {open && <ul>{runs.map((run, index) => <Row key={`${run.name}-${index}`} pr={pr} run={run} items={items} />)}</ul>}
    </section>
  );
}

function Bar({ counts }: { counts: NonNullable<ChecksSummary["counts"]> }) {
  const all = counts.failed + counts.running + counts.passed + counts.skipped || 1;
  const part = (n: number, className: string) => n > 0 && <span className={`block h-full ${className}`} style={{ width: `${(n / all) * 100}%` }} />;
  return (
    <div aria-hidden className="mb-2.5 flex h-2 gap-0.5 overflow-hidden rounded-full">
      {part(counts.failed, "bg-destructive")}{part(counts.running, "bg-warning")}{part(counts.passed, "bg-success")}{part(counts.skipped, "bg-border")}
    </div>
  );
}

function Legend({ counts }: { counts: NonNullable<ChecksSummary["counts"]> }) {
  const entry = (n: number, state: RunState, words: string) => n > 0 && (
    <span className={`inline-flex items-center gap-1 ${LOOKS[state].className}`}><Icon name={LOOKS[state].icon} fallback="Circle" className="size-3.5" aria-hidden />{n} {words}</span>
  );
  return (
    <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[12.5px]">
      {entry(counts.failed, "failed", "failing")}{entry(counts.running, "running", "running")}{entry(counts.passed, "passed", "passed")}{entry(counts.skipped, "skipped", "skipped")}
    </div>
  );
}

/** Every check on the head, failing ones first; passed and skipped ones fold. A server that sends no list shows what it does say. */
export function ChecksPane({ pr, items, details }: { pr: PrView; items: readonly ConversationItem[] | undefined; details: PrDetails | null }) {
  const navigate = useBbNavigate();
  const summary = checksSummary(pr, items, details);
  const list = details?.checks ?? null;
  const loaded = items ?? [];
  const head = pr.head === null ? null : pr.head.slice(0, 7);
  const note: ReactNode[] = [];
  if (head !== null) note.push(<span key="head">On <span className="font-mono">{head}</span>.</span>);
  if (pr.mine && pr.agent !== null && pr.agent.mode !== "off") note.push(<span key="agent"> Failed checks go to the agent.</span>);
  if (list !== null && list.total > list.items.length) note.push(<span key="cut"> Showing {list.items.length} of {plural(list.total, "check")}.</span>);

  if (summary.state === "none" && (list === null || list.items.length === 0)) {
    return <div data-checks className="text-sm text-muted-foreground">No checks ran on this PR's head.</div>;
  }
  return (
    <div data-checks>
      <div className="mb-3.5 rounded-lg border border-border bg-card px-3.5 py-3">
        {summary.counts !== null && <><Bar counts={summary.counts} /><Legend counts={summary.counts} /></>}
        {summary.counts === null && summary.state !== "none" && <div className="text-[13px]">{summary.state === "failed" ? "Some checks fail." : summary.state === "pending" ? "Checks are still running." : "All checks pass."}</div>}
        {note.length > 0 && <div className="mt-2 text-xs text-muted-foreground">{note}</div>}
      </div>
      {list !== null ? (
        <>
          <Group pr={pr} state="failed" runs={list.items.filter((run) => run.state === "failed")} items={loaded} open />
          <Group pr={pr} state="running" runs={list.items.filter((run) => run.state === "running")} items={loaded} open />
          <Group pr={pr} state="passed" runs={list.items.filter((run) => run.state === "passed")} items={loaded} open={false} />
          <Group pr={pr} state="skipped" runs={list.items.filter((run) => run.state === "skipped")} items={loaded} open={false} />
        </>
      ) : (
        <>
          {loaded.filter((item) => item.kind === "check").length > 0 && (
            <ul aria-label="Failing checks" className="mb-2.5 overflow-hidden rounded-lg border border-border bg-card">
              {loaded.filter((item) => item.kind === "check").map((item) => {
                const tag = tagOf(pr, item);
                return (
                  <li key={item.id} data-failing-check className="flex items-center gap-2.5 border-t border-border px-3 py-2 text-[13px] first:border-t-0">
                    <Icon name="CircleX" fallback="X" className="size-4 shrink-0 text-destructive-text" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{checkName(item.body)}</span>
                    {tag !== null && <Tag tag={tag} />}
                    {item.url !== null && <button type="button" className="cursor-pointer text-xs text-primary hover:underline" onClick={() => openExternal(navigate, item.url!)}>Log</button>}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{items === undefined ? "Loading the checks…" : `${pr.serverName} lists only the failing checks here.`}</span>
            <button type="button" className={BUTTON_GHOST} onClick={() => openExternal(navigate, pr.url)}>Open on {pr.serverName}<Icon name="ExternalLink" className="size-3" aria-hidden /></button>
          </div>
        </>
      )}
    </div>
  );
}
