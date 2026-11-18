import { experimental_usePluginId, experimental_useRpcMutation, UrlLink } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { placementContract } from "../../shared/placement-rpc";
import type { PlacementView } from "../../shared/placement-view";
import "./placement.css";

const phases: Record<string, string> = {
  reserved: "Reserved", provisioning: "Starting the machine", bootstrapping: "Setting up", binding: "Setting up",
  carrying: "Carrying the work in", ready: "Ready", running: "Running", preserving: "Saving its work",
  releasing: "Releasing", released: "Released", blocked: "Waiting for setup",
};

export function PlacementFacts({ placement, memberName, variant = "row" }: {
  placement?: PlacementView | null; memberName: string; variant?: "row" | "card" | "compact" | "status";
}) {
  if (variant === "compact" && !placement?.hold && !placement?.blocker) return null;
  return placement ? <PlacedFacts key={`${placement.placementId}:${placement.generation}`} placement={placement} memberName={memberName} variant={variant} /> : null;
}

function PlacedFacts({ placement, memberName, variant }: { placement: PlacementView; memberName: string; variant: "row" | "card" | "compact" | "status" }) {
  const pluginId = experimental_usePluginId();
  const retry = experimental_useRpcMutation({ contract: placementContract, method: "placementRetry" });
  const [refusal, setRefusal] = useState<string | null>(null);
  const status = placement.hold?.message ?? placement.blocker?.message ?? phases[placement.phase] ?? placement.phase;
  const retryable = variant !== "status" && (placement.blocker?.retryable ?? placement.hold !== null);
  const full = variant === "row" || variant === "card";
  const call = async () => {
    setRefusal(null);
    try {
      const out = await retry.mutate({ placementId: placement.placementId, generation: placement.generation });
      if (!out.ok) setRefusal(out.message);
    } catch (error) { setRefusal(error instanceof Error ? error.message : String(error)); }
  };
  const preservation = placement.preservation === "pending" ? "Saving work"
    : placement.preservation === "saved" ? "Work saved"
    : placement.preservation === "unpreserved" && placement.phase === "blocked" && placement.blocker?.stage === "preserve" ? "Work save failed; machine kept"
    : ["unpreserved", "lost", "unknown"].includes(placement.preservation) ? "Work not saved"
    : placement.preservation;
  return <div className={`placement-facts ${variant}`} data-part="PlacementFacts" role="group" aria-label={`Where ${memberName} runs`}>
    {full && <div className="pf-line"><span className="pf-where">{placement.where.label}</span>
      {placement.rule && <UrlLink className="tv-ilink" href={`/plugins/${encodeURIComponent(pluginId)}/tavern/machines/${encodeURIComponent(placement.rule.id)}`}>{placement.rule.label}</UrlLink>}
    </div>}
    <div className="pf-state" role="status" data-hold={placement.hold?.kind}>
      {!placement.hold && placement.blocker && <span>Blocked:{" "}</span>}<span>{status}</span>
      {retryable && <button type="button" className="btn sm" aria-label={`Retry placement for ${memberName}`} disabled={retry.isPending} onClick={() => void call()}>{retry.isPending ? "Retrying…" : "Retry"}</button>}
    </div>
    {full && <div className="pf-posture"><span>{placement.posture.label}</span>{placement.posture.detail && <span>{placement.posture.detail}</span>}</div>}
    {full && placement.source?.includesUncommitted && <p>Started from uncommitted changes in {placement.source.from}.</p>}
    {full && placement.preservation !== "not-needed" && <p role="status">{preservation}{placement.preservationReason && <>: {placement.preservationReason}</>}</p>}
    {refusal && <p role="alert">{refusal}</p>}
  </div>;
}
