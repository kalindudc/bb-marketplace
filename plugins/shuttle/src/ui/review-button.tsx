import { useState } from "react";
import { toast } from "sonner";
import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Preset } from "../config";
import type { PrView, ReviewInput } from "../contract";
import { BUTTON_GHOST, BUTTON_PRIMARY, Choice, Dialog, FIELD } from "./common";
import { useShuttleMutation } from "./data";
import { tinyKey } from "./format";

/** The preset the server uses when a review names none. */
export const defaultPresetOf = (presets: readonly Preset[]): Preset | null => presets.find((preset) => preset.default) ?? presets[0] ?? null;

export function presetSummary(preset: Pick<Preset, "skill" | "model" | "reasoningLevel">): string {
  const parts = [preset.skill || "no skill", preset.model ?? "bb default model"];
  if (preset.reasoningLevel) parts.push(`thinking ${preset.reasoningLevel}`);
  return parts.join(" · ");
}

export function useStartReview() {
  const review = useShuttleMutation("review");
  const navigate = useBbNavigate();
  const start = async (input: ReviewInput, presetName: string) => {
    const result = await review.run(input);
    if (result !== null) {
      const where = result.revived ? " in its review thread, brought back from the archive" : "";
      toast.success(`${presetName} started${where}. Its findings land on the PR.`, { action: { label: "Open", onClick: () => navigate.toThread(result.threadId) } });
    }
    return result;
  };
  return { busy: review.isPending, start };
}

/** A re-review goes to the thread of the last one, which already knows your review. */
export const reReviewThread = (pr: PrView): { threadId: string; title: string } | null =>
  pr.next.kind === "rereview" && pr.lastReview !== null ? { threadId: pr.lastReview.threadId, title: pr.lastReview.title } : null;

/** Pick a preset and start an AI review; "Change for this run…" opens the per-run dialog. */
export function PresetDialog({ pr, presets, onCustomize, onClose }: { pr: PrView; presets: readonly Preset[]; onCustomize(): void; onClose(): void }) {
  const { busy, start } = useStartReview();
  const [presetId, setPresetId] = useState(defaultPresetOf(presets)?.id ?? null);
  const again = reReviewThread(pr);
  const preset = presets.find((item) => item.id === presetId) ?? null;
  const submit = async () => {
    if (preset === null) return;
    if (await start({ key: pr.key, presetId: preset.id, ...(again === null ? {} : { threadId: again.threadId }) }, preset.name)) onClose();
  };
  return (
    <Dialog title={again !== null ? `Re-review ${tinyKey(pr)}` : `Start an AI review of ${tinyKey(pr)}`} leading={<Icon name="Play" className="size-4" aria-hidden />} onClose={onClose}
      footer={(
        <>
          <button type="button" className={BUTTON_GHOST} onClick={onCustomize}>Change for this run…</button>
          <span className="flex-1" />
          <button type="button" className={BUTTON_PRIMARY} disabled={busy || preset === null} onClick={() => void submit()}>
            <Icon name="Play" className="size-3.5" aria-hidden />Start
          </button>
        </>
      )}>
      <div role="radiogroup" aria-label="Preset">
        {presets.map((item) => (
          <Choice key={item.id} on={item.id === presetId} onPick={() => setPresetId(item.id)} hint={presetSummary(item)}
            title={<>{item.name}{item.default && <span className="ml-1.5 text-xs font-normal text-muted-foreground">default</span>}</>} />
        ))}
      </div>
      {again !== null
        ? <div className="mt-1.5 text-xs text-muted-foreground">Goes to the same thread, “{again.title}”, which already knows your last review.</div>
        : pr.reviewThread !== null && (
          <div data-review-thread className="mt-1.5 text-xs text-muted-foreground">
            Goes to its review thread, “{pr.reviewThread.title}”{pr.reviewThread.archived ? ", brought back from the archive" : ""}.
          </div>
        )}
      <div className="mt-1.5 text-xs text-muted-foreground">It drafts findings here. Nothing is posted until you choose.</div>
    </Dialog>
  );
}

/** Approve someone else's PR as you, with an optional comment. */
export function ApproveDialog({ pr, onClose }: { pr: PrView; onClose(): void }) {
  const [text, setText] = useState("");
  const submit = useShuttleMutation("submitReview");
  const approve = async () => {
    if ((await submit.run({ key: pr.key, verdict: "approve", body: text.trim(), findings: [] })) === null) return;
    toast.success(`Approved ${tinyKey(pr)} on ${pr.serverName}.`);
    onClose();
  };
  return (
    <Dialog title={`Approve ${tinyKey(pr)}`} leading={<Icon name="Check" className="size-4" aria-hidden />} onClose={onClose}
      footer={(
        <>
          <span className="flex-1" />
          <button type="button" className={BUTTON_GHOST} onClick={onClose}>Cancel</button>
          <button type="button" className={`${BUTTON_PRIMARY} border-success bg-success`} disabled={submit.isPending} onClick={() => void approve()}>
            <Icon name="Check" className="size-3.5" aria-hidden />Approve
          </button>
        </>
      )}>
      <textarea aria-label="Optional comment" rows={3} className={`${FIELD} w-full`} placeholder="Optional comment" value={text} onChange={(event) => setText(event.target.value)} />
    </Dialog>
  );
}
