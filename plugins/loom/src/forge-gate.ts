// The forge boundary: every host call that goes to a pull request's forge (gh or a forge command) passes through here.
// - An answer the host contract refuses there was printed by the forge's own command, so it becomes a ForgeContractError,
//   which pauses the project with the fix (failures.ts); the same refusal from any other host call stays Loom's own.
// - The engine's backoffs by forge host are kept here for every forge operation, not only pull request reads: a rate
//   limit, a network failure, or a server error that names when to try again backs off the host, an answer clears it,
//   and while it lasts no forge call goes there; the step gets the wait as an unavailable answer and waits it out.
// A pull request opened before the boundary learned its repo's forge host, as the first after a restart, is not held back.
import { ForgeContractError } from "./failures";
import { forgeHostOf, nextBackoff, nextNetworkBackoff, type HostBackoffs } from "./forge-waits";
import type { HostInput, HostMethod, HostOutput } from "./host-contract";
import type { HostPort } from "./ports";

const FORGE_METHODS: ReadonlySet<HostMethod> = new Set<HostMethod>(["prBatch", "prFeedback", "prState", "prCreate", "prEdit", "prReady", "prReply", "prRetarget", "prRequestReview", "prReviewState", "prMerge"]);

type Answer = { outcome: string; message?: string; transient?: "server" | "rate_limit" | "network"; retryAfterMs?: number; pulls?: unknown[]; missing?: Array<{ message: string; transient?: "server" | "rate_limit" | "network"; retryAfterMs?: number }> };

/** The host port the engine calls, with forge calls passed through the forge boundary. */
export function forgeBoundary(host: HostPort, gate: { backoffs: () => HostBackoffs; now: () => number }): HostPort {
  // Each checkout's forge host, from the pull request URLs of calls made there, for the calls that carry no URL.
  const repoHosts = new Map<string, string>();
  const hostOf = (method: HostMethod, input: Record<string, unknown>): string | null => {
    const url = typeof input.url === "string" ? forgeHostOf(input.url) : null;
    if (url !== null && typeof input.repo === "string") repoHosts.set(input.repo, url);
    if (method === "prBatch" && typeof input.host === "string") return input.host.toLowerCase();
    return url ?? (typeof input.repo === "string" ? (repoHosts.get(input.repo) ?? null) : null);
  };
  return {
    call: async <M extends HostMethod>(hostId: string, method: M, input: HostInput<M>): Promise<HostOutput<M>> => {
      if (!FORGE_METHODS.has(method)) return host.call(hostId, method, input);
      const forge = hostOf(method, input as Record<string, unknown>);
      const now = gate.now();
      const held = forge === null ? undefined : gate.backoffs().get(forge);
      if (held !== undefined && held.until > now) {
        const wait = { outcome: "unavailable", message: `Loom sends nothing to ${forge} until ${new Date(held.until).toISOString()}: ${held.message}`, transient: held.network === undefined ? "rate_limit" : "network", retryAfterMs: held.until - now } as const;
        return wait as HostOutput<M>;
      }
      let answer: HostOutput<M>;
      try {
        answer = await host.call(hostId, method, input);
      } catch (error) {
        const code: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
        if (code !== "invalid_output") throw error;
        throw new ForgeContractError(method, error instanceof Error ? error.message : String(error), Reflect.get(error as object, "issues"));
      }
      const repo = (input as { repo?: unknown }).repo;
      const opened = (answer as { url?: unknown }).url;
      if (method === "prCreate" && typeof repo === "string" && typeof opened === "string") {
        const learned = forgeHostOf(opened);
        if (learned !== null) repoHosts.set(repo, learned);
      }
      if (forge !== null) settle(gate.backoffs(), forge, answer as Answer, gate.now());
      return answer;
    },
  };
}

/**
 * What a forge's answer does to its host's backoff. One answer is one limit or one failure however many pull requests it
 * covers: a batch that answered some and lost others to a rate limit backs off afresh, with the longest wait it named.
 */
function settle(backoffs: HostBackoffs, host: string, answer: Answer, now: number): void {
  const failed = answer.outcome === "unavailable" ? [{ message: answer.message ?? "", transient: answer.transient, retryAfterMs: answer.retryAfterMs }] : (answer.missing ?? []).filter((miss) => miss.transient === "rate_limit" || miss.transient === "network");
  const answered = answer.outcome !== "unavailable" && (answer.pulls?.length ?? 0) > 0;
  const limited = failed.filter((miss) => miss.transient === "rate_limit");
  const previous = answered ? undefined : backoffs.get(host);
  if (limited.length > 0) {
    const waits = limited.flatMap((miss) => (miss.retryAfterMs === undefined ? [] : [miss.retryAfterMs]));
    backoffs.set(host, nextBackoff(previous, { now, message: limited[0]!.message, ...(waits.length === 0 ? {} : { retryAfterMs: Math.max(...waits) }) }));
    return;
  }
  const offline = failed.find((miss) => miss.transient === "network");
  if (offline !== undefined) {
    backoffs.set(host, nextNetworkBackoff(previous, { now, message: offline.message }));
    return;
  }
  const named = failed.find((miss) => miss.transient === "server" && miss.retryAfterMs !== undefined);
  if (named !== undefined) {
    backoffs.set(host, { until: now + named.retryAfterMs!, delayMs: named.retryAfterMs!, message: named.message });
    return;
  }
  if (answer.outcome !== "unavailable") backoffs.delete(host);
}
