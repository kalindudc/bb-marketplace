import type { MergeConfirmView } from "../contract";
import { Docked } from "./answer-dock";
import { ConfirmButton, useAction, useLoomWrite } from "./common";

const short = (sha: string) => sha.slice(0, 12);

function stateText(confirm: MergeConfirmView, compact: boolean): string {
  const sha = short(confirm.sha);
  if (confirm.confirmed) return compact ? `Merge of ${sha} confirmed` : `You confirmed the merge of ${sha}. Loom asks the forge to merge the pull request at its next read.`;
  const asked = confirm.requested === null ? "" : compact ? " The planner asks you to confirm it." : ` The planner asks you to confirm it: “${confirm.requested.note}”.`;
  if (confirm.waiting !== null) return compact ? `Merge waits: ${confirm.waiting}.${asked}` : `Loom offers the merge of ${sha} for you to confirm once it is ready. It waits: ${confirm.waiting}.${asked}`;
  if (confirm.requested !== null) return compact ? `Ready at ${sha}: the planner asks you to confirm` : `Ready to merge at ${sha}. The planner asks you to confirm the merge: “${confirm.requested.note}”. Loom merges it only once you confirm.`;
  return compact ? `Ready at ${sha}: waits for your confirmation` : `Ready to merge at ${sha}. auto_merge.mode is manual, so Loom waits for you to confirm the merge of this commit.`;
}

/**
 * A manual merge's state with the button that confirms it. The confirmation names the pull request and commit shown here,
 * so the server refuses it once the head has moved; the button is keyed on them, so one armed for a commit that has since
 * changed disarms instead of confirming the new one.
 */
export function MergeConfirm({ ticketKey, confirm, compact = false, disabled = false, then = null, hold = null }: { ticketKey: string; confirm: MergeConfirmView; compact?: boolean; disabled?: boolean; then?: string | null; hold?: string | null }) {
  const send = useLoomWrite("confirmMerge");
  const { busy, act } = useAction();
  const tone = confirm.confirmed ? "text-[var(--loom-ok)]" : confirm.ready ? "text-[var(--loom-warn)]" : "text-[var(--loom-muted)]";
  const { prUrl, sha } = confirm;
  return (
    <div data-merge-confirm={ticketKey} data-sha={sha} className={`flex flex-wrap items-center gap-2 ${compact ? "mt-1" : ""}`}>
      <span className={`${compact ? "text-xs" : "text-sm"} ${tone} [overflow-wrap:anywhere]`}>{stateText(confirm, compact)}</span>
      {then !== null && !confirm.confirmed && (
        <span data-merge-then className="basis-full text-xs text-[var(--loom-muted)] [overflow-wrap:anywhere]">
          <span className="font-semibold text-foreground">Then</span> {then}
        </span>
      )}
      {hold !== null && confirm.ready && !confirm.confirmed && (
        <span data-merge-hold className="basis-full text-xs text-[var(--loom-warn)] [overflow-wrap:anywhere]">
          {hold}
        </span>
      )}
      {confirm.ready && (
        <Docked>
          <ConfirmButton
            key={`${prUrl} ${sha}`}
            label="Confirm merge"
            confirmLabel={`Yes, merge ${short(sha)}`}
            disabled={disabled || busy}
            onConfirm={() => void act(() => send({ key: ticketKey, prUrl, sha, confirm: true }), `${ticketKey} merge of ${short(sha)} confirmed`)}
          />
        </Docked>
      )}
    </div>
  );
}
