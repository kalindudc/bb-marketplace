import type { MergeConfirmView } from "../contract";
import { ConfirmButton, useAction, useLoomWrite } from "./common";

const short = (sha: string) => sha.slice(0, 12);

function stateText(confirm: MergeConfirmView, compact: boolean): string {
  const sha = short(confirm.sha);
  if (confirm.confirmed) return compact ? `Merge of ${sha} confirmed` : `You confirmed the merge of ${sha}. Loom asks the forge to merge the pull request once it is ready.`;
  if (confirm.requested !== null) return compact ? `The planner asks you to confirm ${sha}` : `The planner asks you to confirm the merge of ${sha}: “${confirm.requested.note}”. Loom merges it only once you confirm.`;
  if (confirm.ready) return compact ? `Ready at ${sha}: waits for your confirmation` : `Ready to merge at ${sha}. auto_merge.mode is manual, so Loom waits for you to confirm the merge of this commit.`;
  return compact ? `Merges at ${sha} once you confirm` : `auto_merge.mode is manual: Loom merges this pull request at ${sha} only once you confirm it. You may confirm now; a new push needs a new confirmation.`;
}

/**
 * A manual merge's state with the button that confirms it. The confirmation names the pull request and commit shown here,
 * so the server refuses it once the head has moved; the button is keyed on them, so one armed for a commit that has since
 * changed disarms instead of confirming the new one.
 */
export function MergeConfirm({ ticketKey, confirm, compact = false, disabled = false }: { ticketKey: string; confirm: MergeConfirmView; compact?: boolean; disabled?: boolean }) {
  const send = useLoomWrite("confirmMerge");
  const { busy, act } = useAction();
  const tone = confirm.confirmed ? "text-success-foreground" : confirm.ready || confirm.requested !== null ? "text-warning-text" : "text-muted-foreground";
  const { prUrl, sha } = confirm;
  return (
    <div data-merge-confirm={ticketKey} data-sha={sha} className={`flex flex-wrap items-center gap-2 ${compact ? "mt-1" : ""}`}>
      <span className={`${compact ? "text-xs" : "text-sm"} ${tone} [overflow-wrap:anywhere]`}>{stateText(confirm, compact)}</span>
      {!confirm.confirmed && (
        <ConfirmButton
          key={`${prUrl} ${sha}`}
          label="Confirm merge"
          confirmLabel={`Click again to merge ${short(sha)}`}
          disabled={disabled || busy}
          onConfirm={() => void act(() => send({ key: ticketKey, prUrl, sha, confirm: true }), `${ticketKey} merge of ${short(sha)} confirmed`)}
        />
      )}
    </div>
  );
}
