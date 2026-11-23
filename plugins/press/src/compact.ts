import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Policy } from "./policy";
import type { PressStore } from "./store";

/**
 * Executing a decision: ask the provider to compact.
 *
 * Press uses `threads.compact` for every provider. Unlike sending `/compact` as text it doesn't
 * depend on the composer or provider's slash-command handling.
 *
 * Instructions cannot travel with that request, and they do not need to: the Press composer builds its
 * prompt from the thread's ledger and the composer config Press publishes next to it. The governor
 * decides when; the composer decides what.
 *
 * The provider capability is not on the SDK's provider info, so Press tries the request once and the
 * caller records a refusal as a failed attempt, which the backoff vetoes keep from repeating.
 */

export interface WorkspaceRef {
  hostId: string | null;
  path: string;
}

export interface CompactResult {
  /** `skip`: the policy disables compaction for the provider, so nothing was sent. */
  method: "compact" | "skip";
  ok: boolean;
  error: string | null;
  compactionId: string;
}

export async function requestCompaction(
  bb: BbPluginApi,
  store: PressStore,
  input: {
    threadId: string;
    decisionId: string | null;
    providerId: string;
    policy: Policy;
    mode: string;
    now: number;
    tokensBefore: number | null;
    point: string | null;
    reason: string | null;
  },
): Promise<CompactResult> {
  const { threadId, providerId, policy } = input;
  const row = store.insertCompaction({
    threadId,
    decisionId: input.decisionId,
    requestedAt: input.now,
    point: input.point,
    reason: input.reason,
    mode: input.mode,
    provider: providerId,
    tokensBefore: input.tokensBefore,
  });

  if (policy.providers[providerId]?.enabled === false) {
    bb.log.info(`skip: provider ${providerId} disabled by policy for ${threadId}`);
    store.cancelUnsent(row.id, input.now, "skip: provider disabled by policy");
    return { method: "skip", ok: false, error: "skip: provider disabled by policy", compactionId: row.id };
  }

  try {
    await bb.sdk.threads.compact({ threadId });
    return { method: "compact", ok: true, error: null, compactionId: row.id };
  } catch (error) {
    const message = messageOf(error);
    bb.log.warn(`compaction request failed (${message}) for ${threadId} on ${providerId}`);
    return { method: "compact", ok: false, error: message, compactionId: row.id };
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
