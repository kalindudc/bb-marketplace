import { experimental_useRpcMutation, experimental_useRpcQuery, experimental_useTabVisible, type ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import { useId, useState, type ReactNode } from "react";
import { rpcContract, type CompactionSummary, type ThreadStatusDto } from "../contract";
import { modeSchema, POINT_IDS } from "../policy";
import { chipText, numberText, POINT_LABELS, secondsText } from "./model";
import { PressSummary } from "./summary";

function Stat({ name, children }: { name: string; children: ReactNode }) {
  return <div className="press-stat"><dt>{name}</dt><dd>{children}</dd></div>;
}

function HistoryRow({ row, threadId }: { row: CompactionSummary; threadId: string }) {
  const [open, setOpen] = useState(false);
  const detail = [row.ms === null ? null : secondsText(row.ms), row.point, row.outcome === "ok" ? null : row.outcome ?? "pending"]
    .filter((part) => part !== null).join(" · ");
  return <details className="press-history" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <span>{row.tokensBefore === null && row.tokensAfter === null ? "Context compacted" : `${numberText(row.tokensBefore)} → ${numberText(row.tokensAfter)}`}</span>
      <small>{detail}</small>
      <span className="press-chevron" aria-hidden="true">⌄</span>
    </summary>
    {open && (row.summaryPath === null ? <p className="press-feedback">No summary is available.</p>
      : <PressSummary threadId={threadId} at={row.at} />)}
  </details>;
}

function ThreadControls({ data }: { data: ThreadStatusDto }) {
  const { threadId } = data;
  const radioGroup = useId();
  const [message, setMessage] = useState<string | null>(null);
  const compact = experimental_useRpcMutation({ contract: rpcContract, method: "compactNow" });
  const mode = experimental_useRpcMutation({ contract: rpcContract, method: "setThreadMode",
    optimistic: ({ threadId, mode }, cache) => cache.update("status", { threadId }, (current) => ({ ...current, mode })),
  });
  const point = experimental_useRpcMutation({ contract: rpcContract, method: "setThreadPoint",
    optimistic: ({ threadId, point, enabled }, cache) => cache.update("status", { threadId }, (current) => ({
      ...current, points: { ...current.points, [point]: enabled },
    })),
  });
  const busy = compact.isPending || mode.isPending || point.isPending;
  const update = async (action: () => Promise<string | void>) => {
    setMessage(null);
    try {
      setMessage(await action() ?? null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Press could not complete the request.");
    }
  };
  return <>
    <section className="press-section" aria-label="Thread controls">
      <h3>This thread</h3>
      <div className="press-stat press-control-mode">
        <span>Mode</span>
        <div className="press-segments" role="radiogroup" aria-label="Press mode for this thread">
          {modeSchema.options.map((value) => <label key={value}>
            {value}
            <input type="radio" name={radioGroup} checked={data.mode === value} disabled={busy}
              onChange={() => void update(async () => { await mode.mutate({ threadId, mode: value }); })} />
          </label>)}
        </div>
      </div>
      <button type="button" className="press-compact" disabled={busy}
        onClick={() => void update(async () => (await compact.mutate({ threadId })).message)}>
        {compact.isPending ? "Requesting compaction…" : "Compact now"}
      </button>
      {message !== null && <p className="press-feedback" role="status">{message}</p>}
    </section>
    <section className="press-section" aria-label="Compaction points">
      <h3>Compaction points</h3>
      {POINT_IDS.map((id) => <label className="press-point" key={id} title={POINT_LABELS[id].description}>
        {POINT_LABELS[id].label}
        <input type="checkbox" role="switch" checked={data.points[id]} disabled={busy} aria-label={`${POINT_LABELS[id].label} compaction point`}
          onChange={(event) => {
            const enabled = event.currentTarget.checked;
            void update(async () => { await point.mutate({ threadId, point: id, enabled }); });
          }} />
        <span aria-hidden="true" />
      </label>)}
    </section>
  </>;
}

export function PressPanel({ threadId }: ExperimentalThreadTabProps) {
  const visible = experimental_useTabVisible();
  const { data, error } = experimental_useRpcQuery({ contract: rpcContract, method: "status", input: { threadId }, enabled: visible });
  if (error && !data) return <div className="press-panel" role="alert">Could not load Press status.</div>;
  if (!data) return <div className="press-panel" role="status">Loading Press…</div>;
  const last = data.history.find((row) => row.outcome === "ok");
  const percent = data.percent === null ? null : Math.min(100, Math.max(0, Math.round(data.percent)));
  return <div className="press-panel">
    <header className="press-panel-heading"><h2>Estimated context</h2><strong>{data.percent === null ? "—" : `${Math.round(data.percent)}%`}</strong></header>
    <div className="press-meter" role={percent === null ? undefined : "meter"} aria-label="Estimated context"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
      <span style={{ width: `${percent ?? 0}%` }} />
    </div>
    <p className="press-usage">{data.tokens === null ? "No context usage reported yet." : `${numberText(data.tokens)} / ${numberText(data.window)} tokens`}</p>
    <section className="press-section" aria-label="Compaction stats">
      <dl>
        <Stat name="Mode">{data.mode}</Stat>
        <Stat name="Next point">{data.nextPoint ?? "—"}</Stat>
        <Stat name="Last compaction">{last ? [
          last.tokensBefore === null && last.tokensAfter === null ? "Context compacted" : `${numberText(last.tokensBefore)} → ${numberText(last.tokensAfter)} tokens`,
          last.ms === null ? null : secondsText(last.ms),
        ].filter((part) => part !== null).join(" · ") : "—"}</Stat>
        <Stat name="Summary model">{last?.model ?? data.summaryModel ?? "Thread model"}</Stat>
        <Stat name="Cost">{last?.ms != null ? `last took ${secondsText(last.ms, 0)}` : "—"}</Stat>
      </dl>
    </section>
    <ThreadControls key={threadId} data={data} />
    <section className="press-section" aria-label="Compaction history">
      <h3>Compaction history</h3>
      {data.history.length === 0 ? <p className="press-feedback">No compactions yet.</p>
        : data.history.map((row) => <HistoryRow key={row.id} row={row} threadId={threadId} />)}
    </section>
  </div>;
}
