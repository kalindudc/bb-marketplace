import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { BbPluginApi, MessageDispatchHookContext, MessageDispatchHookDecision, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import { vi } from "vitest";
import { PressService } from "../src/service";
import { MIGRATIONS, PressStore } from "../src/store";

/**
 * A fake `bb` for the service tests. Thread, timeline and event shapes come from the SDK's own types,
 * so a fixture that drifts from what bb really sends fails `tsc`.
 */

export type TimelineRow = Exclude<Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["timeline"]>>, { delta: unknown }>["rows"][number];
type OperationRow = Exclude<Extract<TimelineRow, { kind: "system"; systemKind: "operation" }>, { operationKind: "parent-change" }>;
type UserRow = Extract<TimelineRow, { kind: "conversation"; role: "user" }>;
type AssistantRow = Extract<TimelineRow, { kind: "conversation"; role: "assistant" }>;
type CommandRow = Extract<TimelineRow, { kind: "work"; workKind: "command" }>;
type ThreadDto = MessageDispatchHookContext["thread"];
type EventRow = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number];
type QueuedEntry = PluginThreadEventPayloads["message.queued"]["entry"];

export const threadId = "thr_test";
export const root = "/workspace";
export const START = Date.parse("2026-11-22T01:00:00.000Z");

function baseRow(at: number) {
  return { id: `row-${at}`, threadId, turnId: null, sourceSeqStart: at, sourceSeqEnd: at, createdAt: at, startedAt: at };
}

export function compactionRow(startedAt: number, completedAt: number, status: OperationRow["status"] = "completed"): OperationRow {
  return {
    ...baseRow(startedAt), kind: "system", systemKind: "operation", operationKind: "compaction", title: "Compaction",
    detail: null, status, completedAt,
  };
}

export function userRow(at: number, id = `user-${at}`): UserRow {
  return {
    ...baseRow(at), id, kind: "conversation", role: "user", initiator: "user", text: "Next", messageSeq: at,
    attachments: null, mentions: [], senderThreadId: null, systemMessageKind: "unlabeled", systemMessageSubject: null,
    turnRequest: { kind: "message", isGrouped: false, status: "accepted" },
  };
}

export function assistantRow(at: number, id = `assistant-${at}`): AssistantRow {
  return { ...baseRow(at), id, kind: "conversation", role: "assistant", text: "Done", messageSeq: at, attachments: null, turnRequest: null };
}

/** A finished shell command, as bb's timeline reports it. */
export function commandRow(at: number, command: string, fields: Partial<CommandRow> = {}): CommandRow {
  return {
    ...baseRow(at), turnId: "turn-1", kind: "work", workKind: "command", status: "completed", callId: `call-${at}`, completedAt: at + 1,
    command, exitCode: 0, output: "", source: null, cwd: null, description: null, approvalStatus: null, activityIntents: [], ...fields,
  };
}

export function compactedEvent(seq: number, createdAt: number): EventRow {
  return {
    id: `evt-${seq}`, scope: { kind: "thread" } as EventRow["scope"], threadId, seq, createdAt,
    type: "thread/compacted", data: { providerThreadId: "provider-thread" },
  } as EventRow;
}

export function queuedEntry(id: string): QueuedEntry {
  return {
    id, threadId, waitingOn: { kind: "plugin", pluginId: "press", reason: "Press is compacting this thread before the next turn" },
  } as QueuedEntry;
}

export interface HarnessOptions {
  settings?: Record<string, unknown>;
  usedTokens?: number | null;
}

export function harness(options: HarnessOptions = {}) {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  const store = new PressStore(db);
  let now = START;
  const clock = {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
    set(at: number) {
      now = at;
    },
  };

  const thread = {
    id: threadId, environmentId: "env_test", providerId: "pi", status: "idle", updatedAt: START - 1_000, archivedAt: null,
  } as unknown as ThreadDto & { status: ThreadDto["status"]; updatedAt: number };
  /** What `threads.get` answers; tests can make it differ from an event's payload. */
  const current = { status: null as ThreadDto["status"] | null };
  const rows: TimelineRow[] = [];
  const compactions: EventRow[] = [];
  const usage = { modelContextWindow: 1_000_000, usedTokens: options.usedTokens ?? 100_000, available: options.usedTokens !== null, estimated: false };
  const files = new Map<string, string>();
  const handlers = new Map<string, (payload: unknown) => void>();
  let dispatchHandler: ((context: MessageDispatchHookContext) => Promise<MessageDispatchHookDecision> | MessageDispatchHookDecision) | null = null;
  const settings: Record<string, unknown> = { mode: "auto", ...options.settings };

  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const compact = vi.fn(async (_args: { threadId: string }) => ({ ok: true as const }));
  const timeline = vi.fn(async () => ({ rows: [...rows] }));
  const listEvents = vi.fn(async (args: { types?: readonly string[] }) =>
    args.types?.includes("thread/compacted") ? [...compactions].sort((a, b) => b.seq - a.seq).slice(0, 1) : []);
  const context = vi.fn(async () => ({
    usage: usage.available ? { modelContextWindow: usage.modelContextWindow, usedTokens: usage.usedTokens, estimated: usage.estimated } : null,
  }));
  const read = vi.fn(async ({ path }: { path: string }) => {
    const content = files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return { content };
  });
  const write = vi.fn(async ({ path, content, expectedSha256 }: { path: string; content: string; expectedSha256?: string | null }) => {
    const existing = files.get(path);
    if (expectedSha256 !== undefined && (existing === undefined ? null : sha(existing)) !== expectedSha256) {
      return { outcome: "conflict" as const, currentSha256: existing === undefined ? null : sha(existing) };
    }
    files.set(path, content);
    return { outcome: "written" as const, sha256: sha(content), sizeBytes: content.length };
  });
  const recheck = vi.fn(async () => undefined);
  const invalidate = vi.fn();
  const invalidateAll = vi.fn();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const bb = {
    pluginId: "press",
    sdk: {
      threads: {
        list: vi.fn(async () => [{ ...thread }]),
        get: vi.fn(async () => ({ ...thread, ...(current.status !== null ? { status: current.status } : {}) })),
        context, timeline, compact,
        events: { list: listEvents },
      },
      environments: { get: vi.fn(async () => ({ path: root, hostId: "host_test" })) },
      files: {
        read, write,
        mkdir: vi.fn(async () => ({})),
        move: vi.fn(async ({ sourcePath, destinationPath }: { sourcePath: string; destinationPath: string }) => {
          if (files.has(destinationPath)) throw new Error("Destination already exists");
          files.set(destinationPath, files.get(sourcePath) ?? "");
          files.delete(sourcePath);
        }),
        remove: vi.fn(async ({ path }: { path: string }) => {
          files.delete(path);
        }),
      },
    },
    server: { experimental_dataDir: "/press-test-no-user-policy" },
    rpc: { experimental_invalidate: invalidate, experimental_invalidateAll: invalidateAll },
    log,
    events: { on: (name: string, handler: (payload: unknown) => void) => handlers.set(name, handler) },
    experimental_hooks: {
      on: (_hook: string, handler: typeof dispatchHandler) => {
        dispatchHandler = handler;
      },
      recheck,
    },
  } as unknown as BbPluginApi;

  const service = new PressService(bb, store, clock.now, async () => settings);
  service.register();

  return {
    bb, service, store, clock, thread, current, rows, compactions, usage, files, settings,
    compact, timeline, listEvents, context, read, write, recheck, invalidate, invalidateAll, log,
    emit(name: string, payload: unknown) {
      const handler = handlers.get(name);
      if (handler === undefined) throw new Error(`no handler for ${name}`);
      handler(payload);
    },
    dispatch(fields: Partial<MessageDispatchHookContext> = {}) {
      if (dispatchHandler === null) throw new Error("no dispatch hook");
      return dispatchHandler({ thread: { ...thread }, attempt: "start-turn", queuedMessages: [], ...fields } as MessageDispatchHookContext);
    },
    statusInvalidations: () => invalidate.mock.calls.filter(([tags]) => (tags as string[]).includes(`status:${threadId}`)).length,
  };
}

/** Let fire-and-forget work (event handlers, background compaction requests) finish. */
export async function flush(times = 20): Promise<void> {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
}
