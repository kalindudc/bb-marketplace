import { experimental_useRpcMutation } from "@get-bb/plugin-sdk/app";
import { useRef } from "react";
import { rpcContract, type ThreadStatusDto } from "../contract";
import { POINT_IDS, type PointId } from "../policy";
import { Glyph } from "./glyphs";
import { errorText, useFeedback, useInflight } from "./live";
import { plural, POINT_LABELS } from "./model";

export function overridesText(overrides: ThreadStatusDto["overrides"]): string | null {
  const parts = [overrides.mode ? "Mode" : null, overrides.points.length > 0 ? plural(overrides.points.length, "point") : null].filter(Boolean);
  if (parts.length === 0) return null;
  return `${parts.join(" and ")} set for this thread`;
}

export function PressPoints({ d }: { d: ThreadStatusDto }) {
  const { threadId } = d;
  const summary = useRef<HTMLElement>(null);
  const [feedback, setFeedback] = useFeedback();
  const inflight = useInflight<PointId | "reset">();
  const point = experimental_useRpcMutation({
    contract: rpcContract, method: "setThreadPoint",
    optimistic: ({ threadId, point, enabled }, cache) => cache.update("status", { threadId }, (current) => ({
      ...current,
      points: { ...current.points, [point]: enabled },
      overrides: { ...current.overrides, points: current.overrides.points.includes(point) ? current.overrides.points : [...current.overrides.points, point] },
    })),
  });
  const reset = experimental_useRpcMutation({ contract: rpcContract, method: "resetThread" });
  const on = POINT_IDS.filter((id) => d.points[id]).length;
  const overridden = overridesText(d.overrides);
  const pending = (id: PointId) => inflight.has(id);

  const toggle = (id: PointId, enabled: boolean) => void inflight.run(id, async () => {
    setFeedback("");
    try {
      await point.mutate({ threadId, point: id, enabled });
    } catch (error) {
      setFeedback(errorText(error, "Press could not change the point."));
    }
  });

  const resetThread = () => void inflight.run("reset", async () => {
    try {
      await reset.mutate({ threadId });
      // The button leaves with the overrides; keep focus in the fold rather than on the page.
      summary.current?.focus();
      setFeedback("This thread follows the plugin settings again.");
    } catch (error) {
      setFeedback(errorText(error, "Press could not reset this thread."));
    }
  });

  return <details className="pp-section pp-points">
    <summary className="pp-h" ref={summary}>
      <span>Points and model</span>
      <span className="pp-meta"><span>{on} of {POINT_IDS.length} on{overridden ? " · this thread" : ""}</span><Glyph name="chev" /></span>
    </summary>
    <ul className="pp-point-list">
      {POINT_IDS.map((id) => <li key={id}>
        <label className="pp-point" title={POINT_LABELS[id].description}>
          <span>
            <span className="pp-point-name">
              {POINT_LABELS[id].label}
              {d.nextPoint === id && <span className="pp-tag">next</span>}
              {d.overrides.points.includes(id) && <span className="pp-tag">this thread</span>}
            </span>
            <span className="pp-point-desc">{POINT_LABELS[id].description}</span>
          </span>
          <input type="checkbox" role="switch" checked={d.points[id]} aria-label={`${POINT_LABELS[id].label} point`}
            aria-disabled={pending(id) || undefined}
            onChange={(event) => { if (!pending(id)) toggle(id, event.currentTarget.checked); }} />
          <span className="pp-switch" aria-hidden="true" />
        </label>
      </li>)}
    </ul>
    {overridden && <div className="pp-reset">
      <span>{overridden}</span>
      <button type="button" className="pp-quiet" aria-disabled={inflight.has("reset") || undefined} onClick={resetThread}>Reset to settings</button>
    </div>}
    <p className="pp-feedback" role="status">{feedback}</p>
    <p className="pp-model"><span>Summary model</span><span>{d.summaryModel ?? "the thread's own model"}</span></p>
  </details>;
}
