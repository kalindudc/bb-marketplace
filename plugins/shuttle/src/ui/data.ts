import { toast } from "sonner";
import {
  experimental_PluginRpcCallError as PluginRpcCallError, experimental_useRpcMutation, experimental_useRpcQuery,
  type BbNavigate, type ExperimentalRpcOptimisticCache, type PluginRpcCallArgs, type PluginRpcResult, type StandardSchemaV1InferInput,
} from "@get-bb/plugin-sdk/app";
import { AREAS, rpcContract, type InboxView, type PrView } from "../contract";

type Contract = typeof rpcContract;
type Method = keyof Contract & string;
export type Input<M extends Method> = StandardSchemaV1InferInput<Contract[M]["input"]>;
export type Output<M extends Method> = PluginRpcResult<Contract[M]>;
export type Cache = ExperimentalRpcOptimisticCache<Contract>;
type Optimistic<M extends Method> = (input: Input<M>, cache: Cache) => void;

export const UNDO_MS = 5000;

/** The server's message, with its validation issues when it names them. */
export function messageOf(error: unknown): string {
  const failure = PluginRpcCallError.from(error);
  const issues = failure.issues ?? [];
  if (issues.length === 0) return failure.message;
  const detail = issues.map((issue) => (issue.path && issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message)).join("; ");
  return failure.message.includes(detail) ? failure.message : `${failure.message}: ${detail}`;
}

export const isNotFound = (error: unknown) => error !== null && PluginRpcCallError.from(error).code === "not_found";

/** A live read of Shuttle's server: it refreshes by itself when a write or a background sync invalidates its tags. */
export function useShuttleQuery<M extends Method>(method: M, input: Input<M>, enabled = true) {
  return experimental_useRpcQuery({ contract: rpcContract, method, input, enabled });
}

/**
 * A write. `run` shows a refusal in a toast and resolves null; `mutate` rejects with the
 * server's error for callers that keep it on screen.
 */
export function useShuttleMutation<M extends Method>(method: M, optimistic?: Optimistic<M>) {
  const mutation = experimental_useRpcMutation({ contract: rpcContract, method, optimistic });
  const run = async (...args: PluginRpcCallArgs<Contract[M]>): Promise<Output<M> | null> => {
    try {
      return await mutation.mutate(...args);
    } catch (error) {
      toast.error(messageOf(error));
      return null;
    }
  };
  return { run, mutate: mutation.mutate, isPending: mutation.isPending };
}

/** A toast whose Undo stays for about five seconds. */
export function undoToast(message: string, undo: () => void) {
  toast.success(message, { duration: UNDO_MS, action: { label: "Undo", onClick: undo } });
}

/**
 * Shows a change to one PR at once in the Inbox, every list, its detail and the given threads' PR
 * lists. `threadIds` come from the caller when the write starts, so a replay sees the same ones.
 */
export function patchPr(cache: Cache, key: string, patch: (pr: PrView) => PrView, threadIds: readonly string[]) {
  const each = (pr: PrView) => (pr.key === key ? patch(pr) : pr);
  cache.update("inbox", {}, (current) => sortInbox(current, each));
  for (const area of AREAS) cache.update("list", { area }, (current) => ({ prs: current.prs.map(each) }));
  cache.update("detail", { key }, (current) => ({ ...current, pr: each(current.pr) }));
  for (const threadId of threadIds) cache.update("threadPrs", { threadId }, (current) => ({ ...current, prs: current.prs.map(each) }));
}

/**
 * The Inbox's lists after a patch: a PR moves to Snoozed or Dismissed, or back, at once. The rest stay in `prs`, where
 * the page shows only those whose step is in the Inbox.
 */
function sortInbox(current: InboxView, each: (pr: PrView) => PrView): InboxView {
  const all = [...current.prs, ...current.snoozed, ...current.dismissed].map(each);
  const dismissed = all.filter((pr) => pr.dismissed !== null);
  const snoozed = all.filter((pr) => pr.dismissed === null && pr.snoozed);
  return { ...current, prs: all.filter((pr) => pr.dismissed === null && !pr.snoozed), snoozed, dismissed };
}

/** Every thread a PR's lists in thread tabs may be cached under. */
export const threadsOf = (prs: readonly PrView[]) => [...new Set(prs.flatMap((pr) => [...pr.links.map((link) => link.threadId), ...(pr.agent ? [pr.agent.threadId] : [])]))];

/** openUrl is experimental and owns only HTTP(S); anything it declines opens the ordinary way. */
export function openExternal(navigate: BbNavigate, url: string): void {
  if (!navigate.openUrl(url)) window.open(url, "_blank", "noopener,noreferrer");
}
