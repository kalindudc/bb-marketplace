// The forge boundary: every host call that goes to a pull request's forge (gh or a forge command) passes through here.
// - An answer the host contract refuses there was printed by the forge's own command, so it becomes a ForgeContractError,
//   which pauses the project with the fix (failures.ts); so does an unavailable answer that says the command broke its
//   contract, such as a read that printed no JSON object. The same refusal from any other host call stays Loom's own.
// - The engine's backoffs by forge host are kept here for every forge operation, not only pull request reads: a rate
//   limit, a network failure, or a server error that names when to try again backs off the host, an answer clears it,
//   and while it lasts no forge call goes there: the caller gets a "held" answer, which says nothing was sent, so it
//   tries again later, as if it had not called, and counts no attempt and no unknown outcome.
// A pull request opened in a checkout whose forge host the boundary has not seen since Loom started is not held back.
import { ForgeContractError, brokeContract } from "./failures";
import { forgeHostOf, nextBackoff, nextNetworkBackoff, type HostBackoffs } from "./forge-waits";
import type { HostInput, HostMethod, HostOutput } from "./host-contract";
import type { HostPort } from "./ports";

/** The backoff of the host's review gate starts alone, beside the host's own in the same map. */
const startKey = (host: string) => `${host} review_start`;
const SERVER_FIRST_MS = 5 * 60_000;
const SERVER_LONGEST_MS = 30 * 60_000;

const FORGE_METHODS: ReadonlySet<HostMethod> = new Set<HostMethod>(["prBatch", "prFeedback", "prState", "prCreate", "prEdit", "prReady", "prReply", "prRetarget", "prRequestReview", "prReviewState", "prMerge", "prReviewStart", "prReviewRead"]);

type Answer = { outcome: string; message?: string; transient?: "server" | "rate_limit" | "network"; retryAfterMs?: number; pulls?: unknown[]; missing?: Array<{ message: string; transient?: "server" | "rate_limit" | "network"; retryAfterMs?: number }> };

/** The host port the engine calls, with forge calls passed through the forge boundary. */
export function forgeBoundary(host: HostPort, gate: { backoffs: () => HostBackoffs; now: () => number }): HostPort {
  // Each checkout's forge host, by machine and path, from the calls made there, for the calls that carry no URL.
  const repoHosts = new Map<string, string>();
  const checkout = (hostId: string, repo: string) => `${hostId}\u0000${repo}`;
  const hostOf = (hostId: string, method: HostMethod, input: Record<string, unknown>): string | null => {
    const named = method === "prBatch" && typeof input.host === "string" ? input.host.toLowerCase() : typeof input.url === "string" ? forgeHostOf(input.url) : null;
    if (typeof input.repo !== "string") return named;
    if (named !== null) repoHosts.set(checkout(hostId, input.repo), named);
    return named ?? repoHosts.get(checkout(hostId, input.repo)) ?? null;
  };
  return {
    call: async <M extends HostMethod>(hostId: string, method: M, input: HostInput<M>): Promise<HostOutput<M>> => {
      if (!FORGE_METHODS.has(method)) return host.call(hostId, method, input);
      const forge = hostOf(hostId, method, input as Record<string, unknown>);
      const now = gate.now();
      const backoffs = gate.backoffs();
      const own = forge === null || method !== "prReviewStart" ? undefined : backoffs.get(startKey(forge));
      const shared = forge === null ? undefined : backoffs.get(forge);
      const held = [shared, own].find((each) => each !== undefined && each.until > now);
      if (held !== undefined) {
        const wait = { outcome: "held", message: `Loom sent nothing to ${forge}, which it waits out until ${new Date(held.until).toISOString()}: ${held.message}`, until: held.until, transient: held.network === undefined ? "rate_limit" : "network", retryAfterMs: held.until - now } as const;
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
        if (learned !== null) repoHosts.set(checkout(hostId, repo), learned);
      }
      if (forge !== null) settle(gate.backoffs(), forge, method, answer as Answer, gate.now());
      // A command that ran and printed what its contract forbids answers unavailable from the host; it is the same broken forge.
      const failed = answer as Answer;
      if (failed.outcome === "unavailable" && brokeContract({ message: failed.message ?? "", ...(failed.transient === undefined ? {} : { transient: failed.transient }) })) throw new ForgeContractError(method, failed.message ?? "", []);
      return answer;
    },
  };
}

/**
 * What a forge's answer does to its host's backoff. One answer is one limit or one failure however many pull requests it
 * covers: a batch that answered some and lost others to a rate limit backs off afresh, with the longest wait it named.
 */
function settle(backoffs: HostBackoffs, host: string, method: HostMethod, answer: Answer, now: number): void {
  // A failed answer of any outcome counts when it says what failed, as a review_start that exited with a rate limit does.
  const failed = answer.outcome === "unavailable" || answer.transient !== undefined ? [{ message: answer.message ?? "", transient: answer.transient, retryAfterMs: answer.retryAfterMs }] : (answer.missing ?? []).filter((miss) => miss.transient === "rate_limit" || miss.transient === "network");
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
  // A review_start that failed with a server error talked to the review gate's own service, not the forge, so only the
  // host's review gate starts wait: until the time it names, else 5 minutes, doubling to 30.
  const server = failed.find((miss) => miss.transient === "server");
  if (server !== undefined && method === "prReviewStart" && answer.outcome !== "unavailable") {
    const before = backoffs.get(startKey(host));
    const delayMs = server.retryAfterMs ?? (before === undefined ? SERVER_FIRST_MS : Math.min(SERVER_LONGEST_MS, before.delayMs * 2));
    backoffs.set(startKey(host), { until: now + delayMs, delayMs, message: server.message });
    return;
  }
  // Any other server error backs off the host only when it names a time; a read's waits on its ticket (retry.ts).
  if (server !== undefined && server.retryAfterMs !== undefined) {
    backoffs.set(host, { until: now + server.retryAfterMs, delayMs: server.retryAfterMs, message: server.message });
    return;
  }
  if (method === "prReviewStart" && answer.outcome === "ok") backoffs.delete(startKey(host));
  // Only an answer from the forge itself says the host takes calls again; a command that failed or ran out of time does not.
  if (answer.outcome === "ok" || answer.outcome === "rejected") backoffs.delete(host);
}

/** The answer the gate gives for a forge call it did not send. */
export type Held = Extract<HostOutput<"prState">, { outcome: "held" }>;

/** A held call as a failure worth waiting out until the host's backoff ends, for a step that waits on its ticket: nothing was sent. */
export function unheld<T extends { outcome: string }>(answer: T | Held): Exclude<T, Held> | { outcome: "unavailable"; message: string; transient: Held["transient"]; retryAfterMs: number } {
  if (answer.outcome !== "held") return answer as Exclude<T, Held>;
  const held = answer as Held;
  return { outcome: "unavailable", message: held.message, transient: held.transient, retryAfterMs: held.retryAfterMs };
}
