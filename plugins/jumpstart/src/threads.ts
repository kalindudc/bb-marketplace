import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { KickResult } from "./contract";
import { FAILURE_EVENT_TYPES, failureFromEvents, type Failure } from "./failure";

type Sdk = BbPluginApi["sdk"];
type WaitingOn = Extract<Awaited<ReturnType<Sdk["threads"]["retry"]>>, { delivery: "queued" }>["waitingOn"];

export interface FailedThread extends Failure {
  id: string;
  title: string;
  projectId: string;
  /** A message or retry already waits on the thread, so another retry would be refused. */
  queued: boolean;
}

export const KICK_REASON = "Resumed with Jumpstart";
const PAGE_SIZE = 200;
const READ_CONCURRENCY = 8;
// Each retry starts a turn; a few at a time keeps a fresh connection from being flooded.
const KICK_CONCURRENCY = 4;

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function describeFailure(sdk: Sdk, threadId: string): Promise<Failure> {
  try {
    const events = await sdk.threads.events.list({ threadId, order: "desc", types: FAILURE_EVENT_TYPES, limit: "10" });
    return failureFromEvents(events);
  } catch (error) {
    return { reason: `Could not read this thread's log: ${message(error)}`, failedAt: null, network: false, restart: false };
  }
}

export async function describeFailures(sdk: Sdk, threadIds: readonly string[]): Promise<Record<string, Failure>> {
  const failures = await mapLimit(threadIds, READ_CONCURRENCY, (threadId) => describeFailure(sdk, threadId));
  return Object.fromEntries(threadIds.map((id, index) => [id, failures[index] as Failure]));
}

export async function listFailedThreads(sdk: Sdk): Promise<FailedThread[]> {
  const failed = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await sdk.threads.list({ archived: false, limit: PAGE_SIZE, offset });
    failed.push(...page.filter((thread) => thread.status === "error" && thread.archivedAt === null && thread.visibility !== "hidden"));
    if (page.length < PAGE_SIZE) break;
  }
  const failures = await describeFailures(
    sdk,
    failed.map((thread) => thread.id),
  );
  return failed
    .map((thread) => ({
      id: thread.id,
      title: thread.title ?? thread.titleFallback ?? thread.id,
      projectId: thread.projectId,
      queued: thread.queuedWork !== "none",
      ...(failures[thread.id] as Failure),
    }))
    .sort((a, b) => (b.failedAt ?? 0) - (a.failedAt ?? 0));
}

export function describeWait(waitingOn: WaitingOn): string {
  switch (waitingOn.kind) {
    case "time":
      return "scheduled for later";
    case "thread-busy":
      return "waiting for the thread's current turn";
    case "stopping":
      return "waiting for the thread to stop";
    case "turn-starting":
      return "waiting for a turn that is starting";
    case "provisioning":
      return "waiting for its workspace";
    case "host-offline":
      return `waiting for ${waitingOn.hostName} to come online`;
    case "interaction":
      return "waiting for an answer to a question";
    case "plugin":
      return `held by ${waitingOn.pluginId}: ${waitingOn.reason}`;
    default:
      return "waiting";
  }
}

async function kickThread(sdk: Sdk, threadId: string): Promise<KickResult> {
  const { restart } = await describeFailure(sdk, threadId);
  if (restart) {
    try {
      // Stop releases the dead or hung agent; the retry below starts a fresh one on the same conversation.
      await sdk.threads.stop({ threadId });
    } catch (error) {
      return { threadId, outcome: "failed", message: `Could not restart the agent: ${message(error)}` };
    }
  }
  const restarted = restart ? { restarted: true as const } : {};
  try {
    const result = await sdk.threads.retry({ threadId, reason: KICK_REASON });
    return result.delivery === "sent"
      ? { threadId, outcome: "sent", ...restarted }
      : { threadId, outcome: "queued", waitingOn: describeWait(result.waitingOn), ...restarted };
  } catch (error) {
    return { threadId, outcome: "failed", message: message(error) };
  }
}

export async function kickThreads(sdk: Sdk, threadIds: readonly string[]): Promise<KickResult[]> {
  return mapLimit([...new Set(threadIds)], KICK_CONCURRENCY, (threadId) => kickThread(sdk, threadId));
}
