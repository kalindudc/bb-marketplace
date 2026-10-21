import { Fragment, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, ThreadDto, TimelineEntry, TimelineRun, TimelineStage } from "../contract";
import { endLabel, formatDuration } from "../format";
import { BUTTON, HEADING, messageOf } from "./common";

const STAGE_NAMES: Record<TimelineStage, string> = { work: "Work", checks: "Checks", review: "Review", merge: "Merge", other: "Other" };
const OK_MARKS = { pass: { mark: "✓", tone: "text-success" }, fail: { mark: "✗", tone: "text-destructive-text" }, none: { mark: "·", tone: "text-muted-foreground" } } as const;

/** Seconds with a decimal under a minute, as the check post shows them. */
const stepDuration = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : formatDuration(ms));
const ago = (at: number) => `${formatDuration(Math.max(0, Date.now() - at))} ago`;

function runText(entry: TimelineEntry, run: TimelineRun): string {
  if (run.running) return `running, started ${ago(entry.at)}`;
  if (entry.ok === null) return "did not finish";
  const took = run.durationMs === null ? "" : stepDuration(run.durationMs);
  if (run.timedOut) return `timed out after ${took}`;
  return run.exitCode === null ? took : `exit ${run.exitCode}${took === "" ? "" : ` · ${took}`}`;
}

function RunOutput({ id }: { id: number }) {
  const rpc = useRpc<typeof rpcContract>();
  const client = useRef(rpc);
  client.current = rpc;
  const [state, setState] = useState<{ output: string | null; error: string | null }>({ output: null, error: null });
  useEffect(() => {
    let live = true;
    client.current.call("runOutput", { id }).then(
      (result) => live && setState(result === null ? { output: null, error: "Loom has no output for this step." } : { output: result.output, error: null }),
      (failure: unknown) => live && setState({ output: null, error: messageOf(failure) }),
    );
    return () => {
      live = false;
    };
  }, [id]);
  if (state.error !== null) return <p role="alert" className="mt-1 text-xs text-destructive-text">Could not load the output: {state.error}</p>;
  if (state.output === null) return <p role="status" className="mt-1 text-xs text-muted-foreground">Loading…</p>;
  return <pre data-run-output className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border-seam p-2 font-mono text-xs">{state.output}</pre>;
}

function Entry({ entry, open, onToggle }: { entry: TimelineEntry; open: boolean; onToggle(): void }) {
  const navigate = useBbNavigate();
  const run = entry.run;
  const ok = entry.ok === null ? "none" : entry.ok ? "pass" : "fail";
  const { mark, tone } = OK_MARKS[ok];
  return (
    <li data-timeline-entry={entry.kind} data-ok={ok} className="py-1.5">
      <div className="flex flex-wrap items-center gap-x-2 text-sm">
        <span aria-hidden="true" className={`w-3 shrink-0 text-center ${tone}`}>
          {mark}
        </span>
        <span className={run === null ? "font-medium [overflow-wrap:anywhere]" : "font-mono text-xs [overflow-wrap:anywhere]"}>{entry.title}</span>
        {run !== null && <span className="text-xs text-muted-foreground">{runText(entry, run)}</span>}
        <span className="text-xs text-subtle-foreground">{ago(entry.at)}</span>
        {entry.threadId !== null && (
          <button type="button" aria-label={`Open the thread of ${entry.title}`} onClick={() => navigate.toThread(entry.threadId!)} className={BUTTON}>
            Open thread
          </button>
        )}
        {run !== null && !run.running && run.outputChars > 0 && (
          <button type="button" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} the output of ${entry.title}`} onClick={onToggle} className={BUTTON}>
            {open ? "Hide output" : "Show output"}
          </button>
        )}
      </div>
      {entry.detail !== null && <div className="ml-5 mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground [overflow-wrap:anywhere]">{entry.detail}</div>}
      {run?.running === true && <p className="ml-5 mt-0.5 text-xs text-muted-foreground">The output appears when the command ends.</p>}
      {run !== null && open && (
        <div className="ml-5">
          <RunOutput id={run.id} />
        </div>
      )}
    </li>
  );
}

/** What happened to a ticket, stage by stage. A run's output loads only when the person asks for it. */
export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  if (entries.length === 0) return null;
  const toggle = (id: number) =>
    setOpen((before) => {
      const next = new Set(before);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <section data-timeline className="space-y-1">
      <h2 className={HEADING}>What happened</h2>
      <ol className="space-y-0.5">
        {entries.map((entry, index) => (
          <Fragment key={entry.run === null ? `${entry.kind}-${entry.at}-${index}` : `run-${entry.run.id}`}>
            {(index === 0 || entries[index - 1]!.stage !== entry.stage) && (
              <li data-timeline-stage className={`${HEADING} pt-2`}>
                {STAGE_NAMES[entry.stage]}
              </li>
            )}
            <Entry entry={entry} open={entry.run !== null && open.has(entry.run.id)} onToggle={() => entry.run !== null && toggle(entry.run.id)} />
          </Fragment>
        ))}
      </ol>
    </section>
  );
}

const THREAD_STATE_TEXT = { spawning: "starting", active: "working", ending: "ending" } as const;
const CELL = "py-1 pr-3 align-top";

/** Every worker and reviewer thread of a ticket, ended ones included: bb still opens an archived thread. */
export function ThreadList({ threads }: { threads: ThreadDto[] }) {
  const navigate = useBbNavigate();
  if (threads.length === 0) return null;
  return (
    <section data-ticket-threads className="space-y-1">
      <h2 className={HEADING}>Threads</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className={CELL}>Role</th>
              <th className={CELL}>Attempt or round</th>
              <th className={CELL}>Status</th>
              <th className={CELL}>Ran for</th>
              <th className={CELL}>
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {threads.map((thread, index) => {
              const which = thread.role === "reviewer" ? `round ${thread.reviewRound}` : thread.attempt === null ? null : `attempt ${thread.attempt}`;
              return (
                <tr key={thread.threadId ?? `${thread.role}-${index}`} data-thread-row={thread.threadId ?? thread.role}>
                  <td className={CELL}>{thread.role}</td>
                  <td className={CELL}>{which ?? "—"}</td>
                  <td className={CELL}>{thread.state === "ended" ? endLabel(thread.endReason) : THREAD_STATE_TEXT[thread.state]}</td>
                  <td className={CELL}>{formatDuration((thread.endedAt ?? Date.now()) - thread.startedAt)}</td>
                  <td className={CELL}>
                    {thread.threadId !== null && (
                      <button type="button" aria-label={`Open ${thread.role} thread${which === null ? "" : ` (${which})`}`} onClick={() => navigate.toThread(thread.threadId!)} className={BUTTON}>
                        Open
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
