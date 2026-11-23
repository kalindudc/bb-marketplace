import { experimental_useRpcMutation } from "@get-bb/plugin-sdk/app";
import { useId } from "react";
import { rpcContract, type ThreadStatusDto } from "../contract";
import { modeSchema } from "../policy";
import { errorText, useFeedback, useInflight } from "./live";
import { MODE_DESCRIPTIONS, PROVIDER_OFF_TEXT } from "./model";

export const RUNNING_REFUSAL = "Compact now waits until this turn ends.";
export const PROVIDER_OFF = `${PROVIDER_OFF_TEXT}.`;

/**
 * Mode and Compact now. Pending writes mark their control `aria-disabled` and ignore input instead
 * of setting `disabled`, which would drop keyboard focus to the page (F39).
 */
export function PressThreadControls({ d }: { d: ThreadStatusDto }) {
  const { threadId } = d;
  const group = useId();
  const feedbackId = useId();
  const [feedback, setFeedback] = useFeedback();
  const inflight = useInflight<"compact" | "mode">();
  const compact = experimental_useRpcMutation({ contract: rpcContract, method: "compactNow" });
  const mode = experimental_useRpcMutation({
    contract: rpcContract, method: "setThreadMode",
    optimistic: ({ threadId, mode }, cache) => cache.update("status", { threadId }, (current) => ({
      ...current, mode, overrides: { ...current.overrides, mode: true },
    })),
  });
  const busy = d.compacting !== null || d.held !== null;
  const requesting = inflight.has("compact");
  const modePending = inflight.has("mode");
  const refusal = !d.providerEnabled ? PROVIDER_OFF : d.running ? RUNNING_REFUSAL : null;
  const compactBlocked = busy || requesting || refusal !== null;
  const compactLabel = busy ? "Compacting…" : requesting ? "Requesting…" : "Compact now";

  const runCompact = () => {
    if (busy || requesting) return;
    if (refusal !== null) {
      setFeedback(refusal);
      return;
    }
    void inflight.run("compact", async () => {
      setFeedback("");
      try {
        setFeedback((await compact.mutate({ threadId })).message);
      } catch (error) {
        setFeedback(errorText(error, "Press could not request a compaction."));
      }
    });
  };

  const chooseMode = (value: ThreadStatusDto["mode"]) => {
    if (value === d.mode) return;
    void inflight.run("mode", async () => {
      setFeedback("");
      try {
        await mode.mutate({ threadId, mode: value });
      } catch (error) {
        setFeedback(errorText(error, "Press could not change the mode."));
      }
    });
  };

  return <>
    <div className="pp-actions">
      <div className="pp-seg" role="radiogroup" aria-label="Press mode for this thread" aria-disabled={modePending || undefined}>
        {modeSchema.options.map((value) => <label key={value} title={MODE_DESCRIPTIONS[value]}>
          <input type="radio" name={group} value={value} checked={d.mode === value} aria-disabled={modePending || undefined}
            onChange={() => chooseMode(value)} />
          {value}
        </label>)}
      </div>
      <button type="button" className="pp-btn" aria-disabled={compactBlocked || undefined}
        aria-describedby={feedbackId} title={busy ? undefined : refusal ?? undefined}
        onClick={runCompact}>
        {compactLabel}
      </button>
    </div>
    <p className="pp-feedback" id={feedbackId} role="status">{feedback}</p>
  </>;
}
