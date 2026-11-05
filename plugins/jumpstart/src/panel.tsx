import { useMemo, useState } from "react";
import {
  experimental_useRpcKeyedQuery,
  experimental_useRpcMutation,
  experimental_useSidebarThreads,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { rpcContract, type KickResult } from "./contract";
import { ago, buildRows, isFailed, startsSelected, summarize, type KickRecord, type Row } from "./rows";

function resumeLabel(count: number): string {
  if (count === 0) return "Resume";
  return count === 1 ? "Resume 1 thread" : `Resume ${count} threads`;
}

function reasonText(row: Row): string {
  if (row.failure === undefined) return "Reading the error…";
  const reason = row.failure.reason ?? "bb logged no error for its last turn";
  return row.thread.queuedWork === "none" ? reason : `A message is already queued · ${reason}`;
}

function ResultLine({ result }: { result: KickResult }) {
  switch (result.outcome) {
    case "sent":
      return <span className="block text-xs text-foreground">{result.restarted ? "Restarted the agent, resuming…" : "Resuming…"}</span>;
    case "queued":
      return (
        <span className="block text-xs text-foreground">
          {result.restarted ? "Restarted the agent, queued: " : "Queued: "}
          {result.waitingOn}
        </span>
      );
    case "failed":
      return <span className="block text-xs text-destructive">Could not resume: {result.message}</span>;
  }
}

function FailedRow({
  row,
  selected,
  disabled,
  now,
  onToggle,
  onOpen,
}: {
  row: Row;
  selected: boolean;
  disabled: boolean;
  now: number;
  onToggle: (selected: boolean) => void;
  onOpen: () => void;
}) {
  const { thread } = row;
  const checkboxId = `jumpstart-${thread.id}`;
  const reason = reasonText(row);
  const failedAt = row.failure?.failedAt ?? thread.updatedAt;
  return (
    <li className="flex items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-state-hover">
      <Checkbox
        id={checkboxId}
        className="mt-0.5"
        checked={selected}
        disabled={disabled}
        onCheckedChange={(checked) => onToggle(checked === true)}
      />
      <label htmlFor={checkboxId} className="min-w-0 flex-1 cursor-pointer">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm">{thread.displayTitle}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground" title={new Date(failedAt).toLocaleString()}>
            {ago(failedAt, now)}
          </span>
        </span>
        <span className="block truncate text-xs text-muted-foreground" title={reason}>
          {reason}
        </span>
        {row.result ? <ResultLine result={row.result} /> : null}
      </label>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
        aria-label={`Open ${thread.displayTitle}`}
        onClick={onOpen}
      >
        <Icon name="ArrowUpRight" className="size-3.5" />
      </Button>
    </li>
  );
}

export function JumpstartPanel() {
  const { status, threads } = experimental_useSidebarThreads();
  const navigate = useBbNavigate();
  const keys = useMemo(
    () => threads.filter(isFailed).map((thread) => thread.id),
    [threads],
  );
  const failures = experimental_useRpcKeyedQuery({ contract: rpcContract, method: "failures", keys });
  const kick = experimental_useRpcMutation({ contract: rpcContract, method: "kick" });
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [kicks, setKicks] = useState<ReadonlyMap<string, KickRecord>>(new Map());

  const rows = useMemo(() => buildRows(threads, failures.data, kicks), [threads, failures.data, kicks]);
  const isSelected = (row: Row) => choices.get(row.thread.id) ?? startsSelected(row);
  const selected = rows.filter(isSelected);
  const now = Date.now();

  const choose = (ids: readonly string[], value: boolean) =>
    setChoices((current) => new Map([...current, ...ids.map((id) => [id, value] as const)]));

  const resume = async () => {
    const threadIds = selected.map((row) => row.thread.id);
    try {
      const { results } = await kick.mutate({ threadIds });
      const at = Date.now();
      setKicks((current) => new Map([...current, ...results.map((result) => [result.threadId, { result, at }] as const)]));
      setChoices((current) => new Map([...current].filter(([id]) => !threadIds.includes(id))));
      const summary = summarize(results);
      if (summary.failed) toast.error(summary.text);
      else toast.success(summary.text);
    } catch (error) {
      toast.error(`Jumpstart could not resume threads: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (status === "loading") {
    return <p className="p-3 text-xs text-muted-foreground">Loading threads…</p>;
  }

  if (rows.length === 0) {
    return (
      <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
        <Icon name="CircleCheck" className="size-4" />
        No failed threads.
      </div>
    );
  }

  return (
    <div className="flex max-h-[min(30rem,70vh)] flex-col gap-2 p-2 text-sm">
      <div className="flex items-center justify-between gap-2 px-1.5 pt-1">
        <span className="font-medium">
          Failed threads <span className="text-muted-foreground tabular-nums">{rows.length}</span>
        </span>
        {rows.length > 1 ? (
          <span className="flex gap-1">
            <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => choose(rows.map((row) => row.thread.id), true)}>
              All
            </Button>
            <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => choose(rows.map((row) => row.thread.id), false)}>
              None
            </Button>
          </span>
        ) : null}
      </div>
      <p className="px-1.5 text-xs text-muted-foreground">Threads that stopped on a network error start ticked.</p>
      {failures.error ? (
        <p className="flex items-center gap-2 px-1.5 text-xs text-destructive">
          Could not read why they failed: {failures.error.message}
          <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => void failures.refetch()}>
            Retry
          </Button>
        </p>
      ) : null}
      <ul className={cn("min-h-0 overflow-y-auto", kick.isPending && "opacity-70")}>
        {rows.map((row) => (
          <FailedRow
            key={row.thread.id}
            row={row}
            selected={isSelected(row)}
            disabled={kick.isPending}
            now={now}
            onToggle={(value) => choose([row.thread.id], value)}
            onOpen={() => navigate.toThread(row.thread.id)}
          />
        ))}
      </ul>
      <Button size="sm" className="w-full" disabled={selected.length === 0 || kick.isPending} onClick={() => void resume()}>
        <Icon name={kick.isPending ? "Loading" : "RotateCcw"} className={cn(kick.isPending && "animate-spin")} />
        {kick.isPending ? "Resuming…" : resumeLabel(selected.length)}
      </Button>
    </div>
  );
}
