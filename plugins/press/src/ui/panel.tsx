import { experimental_useRpcQuery, experimental_useTabVisible, type ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState } from "react";
import { rpcContract, type ThreadStatusDto } from "../contract";
import { PressThreadControls } from "./controls";
import { PressDecisionPath } from "./decision-path";
import { PressGauge } from "./gauge";
import { PressHistory } from "./history";
import { useNow, usePrevious, useReceivedAt } from "./live";
import { PressNextStep } from "./next-step";
import { PressPoints } from "./points";
import { deriveState, detectLanding, needsClock, nextStep, type Landing } from "./runway";

/** How long the "Compacted · freed …" moment stays before the panel returns to its usual next step. */
export const LANDING_MS = 120_000;
const REFETCH_GAP_MS = 5_000;
const TICK_MS = 1_000;
const QUIET_TICK_MS = 60_000;

function useLanding(d: ThreadStatusDto): Landing | null {
  const previous = usePrevious(d);
  const [landing, setLanding] = useState<Landing | null>(null);
  useEffect(() => {
    if (d.compacting || d.held) {
      setLanding(null);
      return;
    }
    const next = detectLanding(previous, d);
    if (next) setLanding(next);
  }, [d, previous]);
  useEffect(() => {
    if (landing === null) return;
    const timer = setTimeout(() => setLanding(null), LANDING_MS);
    return () => clearTimeout(timer);
  }, [landing]);
  return landing;
}

function PressRunway({ d, stale, refetch }: { d: ThreadStatusDto; stale: boolean; refetch: () => Promise<void> }) {
  const landing = useLanding(d);
  const receivedAt = useReceivedAt(d);
  const now = useNow(needsClock(d) ? TICK_MS : QUIET_TICK_MS, d);
  const elapsed = Math.max(0, (now - receivedAt) / 1000);
  const state = deriveState(d, landing);
  const step = nextStep(d, state, landing, now, elapsed);

  // Nothing on the server announces a cooldown running out, so read the status again when one does.
  // Only a countdown that was running counts, and at most every few seconds, so a server that still
  // reports zero left can never start a refetch loop.
  const expired = d.blockers.some((b) => b.remainingSeconds !== null && b.remainingSeconds > 0 && b.remainingSeconds - elapsed <= 0);
  const lastRefetch = useRef(0);
  useEffect(() => {
    if (!expired || Date.now() - lastRefetch.current < REFETCH_GAP_MS) return;
    lastRefetch.current = Date.now();
    void refetch();
  }, [expired, refetch]);

  return <div className="press-panel" data-state={state.key}>
    {/* Mounted for the panel's lifetime so a failed refresh is announced when its text arrives. */}
    <p className="pp-stale" role="status">{stale && <>Could not refresh, showing the last status. <button type="button" className="pp-link" onClick={() => void refetch()}>Retry</button></>}</p>
    <PressGauge d={d} state={state} landing={landing} />
    <PressNextStep step={step} state={state} now={now} title={d.held?.reason} />
    <PressThreadControls d={d} />
    <PressDecisionPath d={d} state={state} elapsed={elapsed} />
    <PressHistory d={d} now={now} />
    <PressPoints d={d} />
  </div>;
}

export function PressPanel({ threadId }: ExperimentalThreadTabProps) {
  const visible = experimental_useTabVisible();
  const { data, error, refetch } = experimental_useRpcQuery({ contract: rpcContract, method: "status", input: { threadId }, enabled: visible });
  if (error && !data) {
    return <div className="press-panel">
      <div className="pp-error" role="alert" data-error>
        <p className="pp-next-title">Could not load Press status</p>
        <p className="pp-next-sub">{error.message || "The status request failed."}</p>
        <button type="button" className="pp-quiet" onClick={() => void refetch()}>Retry</button>
      </div>
    </div>;
  }
  if (!data) {
    return <div className="press-panel">
      <div className="pp-loading" role="status" aria-label="Loading Press">
        <span className="pp-skel is-hero" /><span className="pp-skel" /><span className="pp-skel is-70" />
        <span className="pp-skel is-85 is-gap" /><span className="pp-skel is-60" />
      </div>
    </div>;
  }
  return <PressRunway key={threadId} d={data} stale={error !== null} refetch={refetch} />;
}
