import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { MergeRunState, MergeView, PrView } from "../contract";
import { mergeText } from "../next";
import { patchPr, threadsOf, useShuttleQuery, useShuttleMutation, type Input } from "./data";
import { tinyKey } from "./format";

// Shared by every surface on the page, so a page and a thread tab open at once say each outcome once.
const known = new Map<number, MergeRunState>();
const told = new Set<number>();

const toastId = (id: number) => `shuttle-merge-${id}`;
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const pending = (state: MergeRunState | undefined) => state === "queued" || state === "merging";

/** A merge this page queued: its outcome gets a toast even if it finishes before the next read of the queue. */
export function expectMerge(merge: MergeView): void {
  known.set(merge.id, merge.state);
}

export function mergedText(merge: MergeView): string {
  if (merge.outcome === "auto_merge" || (merge.outcome === null && merge.auto)) return `Auto-merge is on for ${merge.display}: it merges once ${merge.serverName} lets it.`;
  if (merge.outcome === "sent") return `${merge.serverName} took the merge of ${merge.display}, and it is still open: it may be waiting in the repository's merge queue.`;
  return `Merged ${merge.display} on ${merge.serverName} (${merge.method})${merge.deleteBranch ? ", and deleted its branch" : ""}.`;
}

export function failedText(merge: MergeView): string {
  const why = merge.error ?? "it failed";
  return merge.auto ? `Auto-merge didn\u2019t turn on for ${merge.display}: ${why}` : `Your merge of ${merge.display} didn\u2019t go through: ${why}`;
}

/** Tells the user how each merge they saw waiting or under way went, once it is done. */
export function useMergeToasts(): void {
  const merges = useShuttleQuery("merges", {}).data?.merges;
  useEffect(() => {
    if (merges === undefined) return;
    for (const merge of merges) {
      const before = known.get(merge.id);
      known.set(merge.id, merge.state);
      if (!pending(before) || pending(merge.state) || told.has(merge.id)) continue;
      told.add(merge.id);
      if (merge.state === "done") toast.success(mergedText(merge), { id: toastId(merge.id) });
      else if (merge.state === "failed") toast.error(failedText(merge), { id: toastId(merge.id) });
    }
  }, [merges]);
}

/** A merge of this PR waiting or under way, so nothing may queue another. */
export const mergeInQueue = (pr: Pick<PrView, "merge">) => pr.merge?.state === "queued" || pr.merge?.state === "merging";

/** The PR as the server will have it once the merge is queued; its merge has no id until the server gives it one. */
function queuedPr(pr: PrView, input: Input<"queueMerge">, at: number): PrView {
  const merge: MergeView = {
    id: 0, key: pr.key, display: `${pr.repo}${pr.sep}${pr.number}`, serverName: pr.serverName, method: input.method, auto: input.auto, deleteBranch: input.deleteBranch,
    head: input.head, state: "queued", outcome: null, error: null, at, startedAt: null, finishedAt: null,
  };
  const label = input.auto ? "Auto-merge is queued to turn on" : "Queued to merge";
  return { ...pr, merge, next: { ...pr.next, kind: "merging", tone: "info", label, why: `${mergeText(merge)}. Queued just now.`, inbox: false, clears: null, primary: null, more: [] } };
}

/** Queues a merge and says so; the outcome comes from useMergeToasts. The PR shows it queued from the click, not from the next read. */
export function useQueueMerge() {
  const at = useRef(0);
  const threads = useRef<string[]>([]);
  const queue = useShuttleMutation("queueMerge", (input, cache) => patchPr(cache, input.key, (pr) => queuedPr(pr, input, at.current), threads.current));
  const run = async (pr: PrView, input: Omit<Input<"queueMerge">, "key">) => {
    at.current = Date.now();
    threads.current = threadsOf([pr]);
    const out = await queue.run({ key: pr.key, ...input });
    if (out === null) return null;
    expectMerge(out.merge);
    toast(`Queued ${tinyKey(pr)}: ${lowerFirst(mergeText(out.merge))}. Shuttle does it on ${pr.serverName} in the background.`, { id: toastId(out.merge.id) });
    return out;
  };
  return { run, isPending: queue.isPending };
}

export function useMergeWrites() {
  const cancel = useShuttleMutation("cancelMerge");
  const retry = useShuttleMutation("retryMerge");
  const clear = useShuttleMutation("clearMerge");
  const cancelMerge = async (pr: PrView) => {
    if (pr.merge === null) return;
    if ((await cancel.run({ id: pr.merge.id })) !== null) toast.success(`Cancelled the ${pr.merge.auto ? "auto-merge" : "merge"} of ${tinyKey(pr)}. Nothing changed on ${pr.serverName}.`, { id: toastId(pr.merge.id) });
  };
  const retryMerge = async (pr: PrView) => {
    if (pr.merge === null) return;
    const out = await retry.run({ id: pr.merge.id });
    if (out === null) return;
    expectMerge(out.merge);
    told.delete(out.merge.id);
    toast(`Trying ${tinyKey(pr)} again. Shuttle does it on ${pr.serverName} in the background.`, { id: toastId(out.merge.id) });
  };
  const clearMerge = async (pr: PrView) => {
    if (pr.merge !== null) await clear.run({ id: pr.merge.id });
  };
  return { cancelMerge, retryMerge, clearMerge };
}
