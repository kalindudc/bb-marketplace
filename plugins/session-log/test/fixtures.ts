import type { ThreadEventRow, TimelineResponse, TimelineRow } from "../src/types";

type UserRow = Extract<TimelineRow, { kind: "conversation"; role: "user" }>;
type AssistantRow = Extract<TimelineRow, { kind: "conversation"; role: "assistant" }>;
type ReasoningRow = Extract<TimelineRow, { kind: "system"; systemKind: "operation" }> & {
  operationKind: "reasoning";
};
type WorkRow<K extends string> = Extract<TimelineRow, { kind: "work"; workKind: K }>;
type TurnRow = Extract<TimelineRow, { kind: "turn" }>;

function baseRow(id: string) {
  return {
    id,
    threadId: "thr_1",
    turnId: "turn-1",
    sourceSeqStart: 10,
    sourceSeqEnd: 10,
    createdAt: 1_000,
    startedAt: 1_000,
  };
}

export function userRow(id = "user-1", overrides: Partial<UserRow> = {}): UserRow {
  return {
    ...baseRow(id),
    kind: "conversation",
    role: "user",
    initiator: "user",
    text: "Please check the tests.",
    messageSeq: 10,
    attachments: null,
    mentions: [],
    senderThreadId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    turnRequest: { kind: "message", isGrouped: false, status: "accepted" },
    ...overrides,
  };
}

export function assistantRow(id = "agent-1", overrides: Partial<AssistantRow> = {}): AssistantRow {
  return {
    ...baseRow(id),
    kind: "conversation",
    role: "assistant",
    text: "The tests passed.",
    messageSeq: 11,
    attachments: null,
    turnRequest: null,
    ...overrides,
  };
}

export function reasoningRow(id = "reason-1", overrides: Partial<ReasoningRow> = {}): ReasoningRow {
  return {
    ...baseRow(id),
    kind: "system",
    systemKind: "operation",
    operationKind: "reasoning",
    title: "Thought for 2s",
    detail: "I should check the tests.",
    status: "completed",
    completedAt: 2_000,
    ...overrides,
  };
}

export function commandRow(id = "cmd-1", overrides: Partial<WorkRow<"command">> = {}): WorkRow<"command"> {
  return {
    ...baseRow(id),
    kind: "work",
    workKind: "command",
    status: "completed",
    completedAt: 1_500,
    callId: `call-${id}`,
    command: "npm test",
    output: "passed",
    exitCode: 0,
    cwd: null,
    source: null,
    approvalStatus: null,
    activityIntents: [],
    ...overrides,
  };
}

export function toolRow(id = "tool-1", overrides: Partial<WorkRow<"tool">> = {}): WorkRow<"tool"> {
  return {
    ...baseRow(id),
    kind: "work",
    workKind: "tool",
    status: "completed",
    completedAt: 1_500,
    callId: `call-${id}`,
    toolName: "read",
    toolArgs: { path: "src/file.ts" },
    output: "contents",
    approvalStatus: null,
    ...overrides,
  };
}

export function fileChangeRow(id = "file-1", overrides: Partial<WorkRow<"file-change">> = {}): WorkRow<"file-change"> {
  return {
    ...baseRow(id),
    kind: "work",
    workKind: "file-change",
    status: "completed",
    callId: `call-${id}`,
    change: {
      kind: "edit",
      path: "src/file.ts",
      movePath: null,
      diff: "@@ -1 +1 @@\n-old\n+new",
      diffStats: { added: 1, removed: 1 },
    },
    stdout: null,
    stderr: null,
    approvalStatus: null,
    ...overrides,
  };
}

export function delegationRow(id = "delegate-1", overrides: Partial<WorkRow<"delegation">> = {}): WorkRow<"delegation"> {
  return {
    ...baseRow(id),
    kind: "work",
    workKind: "delegation",
    status: "completed",
    completedAt: 1_500,
    callId: `call-${id}`,
    toolName: "spawn",
    childRef: "thr_child",
    background: false,
    subagentType: "minion",
    description: "Review the tests",
    output: "Review complete.",
    childRows: null,
    ...overrides,
  };
}

export function turnRow(id = "turn-row-1", overrides: Partial<TurnRow> = {}): TurnRow {
  return {
    ...baseRow(id),
    kind: "turn",
    turnId: "turn-1",
    status: "completed",
    completedAt: 2_000,
    summaryCount: 0,
    children: null,
    ...overrides,
  };
}

export function timelineResponse(rows: TimelineRow[] = [], overrides: Partial<TimelineResponse> = {}): TimelineResponse {
  return {
    activeBackgroundCommands: [],
    activePromptMode: null,
    activeThinking: null,
    activeWorkflows: [],
    completedTurnDisplay: "flat",
    contextBoundarySeq: null,
    goal: null,
    maxSeq: rows.at(-1)?.sourceSeqEnd ?? 0,
    modelFallback: null,
    pendingTodos: null,
    providerCommands: null,
    rows,
    sessionOptions: null,
    timelinePage: {
      historySnapshot: "snapshot-1",
      olderCursor: null,
      olderRowsSourceSeqEnd: null,
      returnedSegmentCount: 1,
    },
    ...overrides,
  };
}

type RequestedEvent = Extract<ThreadEventRow, { type: "client/turn/requested" }>;
type RequestData = RequestedEvent["data"];

/** A `client/turn/requested` event; the default is a plugin's agent-only steer into turn-1. */
export function requestEvent(seq: number, overrides: Partial<RequestData> = {}): RequestedEvent {
  return {
    id: `evt_${seq}`,
    scope: { kind: "thread" },
    threadId: "thr_1",
    seq,
    createdAt: seq * 100,
    type: "client/turn/requested",
    data: {
      direction: "outbound",
      requestId: `creq_${seq}`,
      source: "tell",
      initiator: "user",
      senderThreadId: null,
      systemMessageKind: "unlabeled",
      systemMessageSubject: null,
      input: [{ type: "text", text: "Relevant memory: task 42", mentions: [], visibility: "agent-only" }],
      target: { kind: "steer", expectedTurnId: "turn-1" },
      request: { method: "turn/start", params: {} },
      execution: {
        model: "model", serviceTier: "default", reasoningLevel: "high", permissionMode: "full",
        source: "client/turn/requested",
      },
      ...overrides,
    },
  };
}

export function acceptedEvent(seq: number, requestId: string, turnId = "turn-1"): ThreadEventRow {
  return {
    id: `evt_${seq}`,
    scope: { kind: "turn", turnId },
    threadId: "thr_1",
    seq,
    createdAt: seq * 100,
    type: "turn/input/accepted",
    data: { providerThreadId: "provider-thread", clientRequestId: requestId },
  };
}

export function rejectedEvent(seq: number, requestId: string): ThreadEventRow {
  return {
    id: `evt_${seq}`,
    scope: { kind: "thread" },
    threadId: "thr_1",
    seq,
    createdAt: seq * 100,
    type: "client/turn/rejected",
    data: { requestId, reason: "turn-ended", message: "The turn ended" },
  };
}

/** jsdom has no ResizeObserver; this records what the panel observes and lets a test report a resize. */
export class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly targets: Element[] = [];
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.push(target);
  }

  unobserve(): void {}

  disconnect(): void {
    FakeResizeObserver.instances = FakeResizeObserver.instances.filter((observer) => observer !== this);
  }

  static resizeAll(): void {
    for (const observer of [...FakeResizeObserver.instances]) {
      observer.callback([], observer as unknown as ResizeObserver);
    }
  }
}
