import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Policy } from "./policy";
import type { Ledger } from "./ledger";
import type { PressStore } from "./store";

/**
 * Executing a decision: ask the provider to compact.
 *
 * Press uses `threads.compact` for every provider. Unlike sending `/compact` as text it doesn't
 * depend on the composer or provider's slash-command handling.
 *
 * Instructions cannot travel with that request, and they do not need to: the Press composer builds its
 * prompt from the workspace ledger and the policy, which is where the constraints and the resume
 * contract already live. The governor decides when; the composer decides what.
 *
 * The provider capability is not on the SDK's provider info, so Press tries the request once and records
 * the refusal; the `previousCompactionFailed` veto stops any retry storm.
 */

export interface WorkspaceRef {
  hostId: string | null;
  path: string;
}

export interface CompactResult {
  method: "compact" | "skip";
  ok: boolean;
  error: string | null;
  compactionId: string;
  instructionsHash: string | null;
}

export async function requestCompaction(
  bb: BbPluginApi,
  store: PressStore,
  input: {
    threadId: string;
    decisionId: string | null;
    providerId: string;
    policy: Policy;
    ledger: Ledger | null;
    mode: string;
    now: number;
    tokensBefore: number | null;
    point: string | null;
  },
): Promise<CompactResult> {
  const { threadId, providerId, policy } = input;

  const providerPolicy = policy.providers[providerId];
  if (providerPolicy !== undefined && providerPolicy.enabled === false) {
    bb.log.info(`skip: provider ${providerId} disabled by policy for ${threadId}`);
    return recordSkip(store, input, providerId);
  }

  // No capability flag on the SDK provider info, so try the explicit request once and record the answer.
  const row = store.insertCompaction({
    threadId,
    decisionId: input.decisionId,
    requestedAt: input.now,
    point: input.point,
    mode: input.mode,
    provider: providerId,
    method: "compact",
    instructionsHash: null,
    tokensBefore: input.tokensBefore,
  });
  try {
    await bb.sdk.threads.compact({ threadId });
    return { method: "compact", ok: true, error: null, compactionId: row.id, instructionsHash: null };
  } catch (error) {
    const message = messageOf(error);
    bb.log.warn(`compaction request failed (${message}) for ${threadId} on ${providerId}; not retrying`);
    return { method: "compact", ok: false, error: message, compactionId: row.id, instructionsHash: null };
  }
}

function recordSkip(
  store: PressStore,
  input: { threadId: string; decisionId: string | null; now: number; mode: string },
  provider: string,
): CompactResult {
  const row = store.insertCompaction({
    threadId: input.threadId,
    decisionId: input.decisionId,
    requestedAt: input.now,
    point: null,
    mode: input.mode,
    provider,
    method: "compact",
    instructionsHash: null,
    tokensBefore: null,
  });
  store.settleCompaction(row.id, "cancelled", input.now, "skip: unsupported", null);
  return { method: "skip", ok: false, error: "skip: unsupported", compactionId: row.id, instructionsHash: null };
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}