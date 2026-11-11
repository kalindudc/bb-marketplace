import type { BoardCard } from "../contract";
import { ConfirmButton, useAction, useLoomWrite } from "./common";
import { Docked } from "./answer-dock";

/**
 * A draft pull request's state: one the human holds as a draft (keep_draft), with the button that releases it, one Loom
 * publishes once it can ship (merge.publish) with what it waits for, or one Loom marks ready for review at its next read.
 * Nothing for any other pull request.
 */
export function DraftHold({ ticketKey, prUrl, draft, publishWait = null, requested, compact = false, disabled = false }: { ticketKey: string; prUrl: string | null; draft: BoardCard["draft"]; publishWait?: string | null; requested: BoardCard["releaseRequested"]; compact?: boolean; disabled?: boolean }) {
  const send = useLoomWrite("releaseDraft");
  const { busy, act } = useAction();
  if (draft === null) return null;
  const size = compact ? "text-xs" : "text-sm";
  if (draft === "marking" && publishWait !== null) {
    return (
      <p data-draft-hold="publishing" className={`${compact ? "mt-1" : ""} ${size} text-[var(--loom-muted)] [overflow-wrap:anywhere]`}>
        {`Draft until it can ship: ${publishWait}`}
      </p>
    );
  }
  if (draft === "marking") {
    return (
      <p data-draft-hold="marking" className={`${compact ? "mt-1" : ""} ${size} text-[var(--loom-muted)]`}>
        Draft: being marked ready for review
      </p>
    );
  }
  const asked = requested === null ? "" : compact ? " The planner asks you to release it." : ` The planner asks you to release it: “${requested.note}”.`;
  return (
    <div data-draft-hold="held" className={`flex flex-wrap items-center gap-2 ${compact ? "mt-1" : ""}`}>
      <span className={`${size} text-[var(--loom-warn)] [overflow-wrap:anywhere]`}>{`Held as a draft: you release it.${asked}`}</span>
      {prUrl !== null && (
        <Docked>
          <ConfirmButton
            key={prUrl}
            label="Release draft"
            confirmLabel="Yes, mark it ready for review"
            disabled={disabled || busy}
            onConfirm={() => void act(() => send({ key: ticketKey, prUrl, confirm: true }), `${ticketKey} released from draft`)}
          />
        </Docked>
      )}
    </div>
  );
}
