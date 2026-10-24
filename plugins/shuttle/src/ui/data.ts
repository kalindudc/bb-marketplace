import { toast } from "sonner";
import {
  experimental_PluginRpcCallError as PluginRpcCallError, experimental_useRpcMutation, experimental_useRpcQuery,
  type BbNavigate, type ExperimentalRpcOptimisticCache, type PluginRpcCallArgs, type PluginRpcResult, type StandardSchemaV1InferInput,
} from "@get-bb/plugin-sdk/app";
import { rpcContract, SECTIONS, type PrView } from "../contract";

type Contract = typeof rpcContract;
type Method = keyof Contract & string;
type Input<M extends Method> = StandardSchemaV1InferInput<Contract[M]["input"]>;
export type Output<M extends Method> = PluginRpcResult<Contract[M]>;
type Optimistic<M extends Method> = (input: Input<M>, cache: ExperimentalRpcOptimisticCache<Contract>) => void;

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

/**
 * Turns watching on or off, showing it at once in every loaded list, the PR's detail and the
 * given threads' PR lists. `threadIds` are captured when the write starts, so a replay sees the same ones.
 */
export function useWatchMutation(threadIds: readonly string[]) {
  return useShuttleMutation("watch", ({ key, mode }, cache) => {
    const patch = (pr: PrView): PrView => (pr.key === key ? { ...pr, watch: mode } : pr);
    for (const section of SECTIONS) cache.update("list", { section }, (current) => ({ prs: current.prs.map(patch) }));
    cache.update("detail", { key }, (current) => ({ ...current, pr: patch(current.pr) }));
    for (const threadId of threadIds) cache.update("threadPrs", { threadId }, (current) => ({ ...current, prs: current.prs.map(patch) }));
  });
}

/** openUrl is experimental and owns only HTTP(S); anything it declines opens the ordinary way. */
export function openExternal(navigate: BbNavigate, url: string): void {
  if (!navigate.openUrl(url)) window.open(url, "_blank", "noopener,noreferrer");
}
