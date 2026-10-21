import type { ThreadEventRow } from "./types";

type RequestedEvent = Extract<ThreadEventRow, { type: "client/turn/requested" }>;
type RequestData = RequestedEvent["data"];
type PromptPart = RequestData["input"][number];
export type SystemMessageKind = NonNullable<RequestData["systemMessageKind"]>;

/** The events that say what bb sent an agent and whether the agent took it. */
export const REQUEST_EVENT_TYPES = ["client/turn/requested", "turn/input/accepted", "client/turn/rejected"] as const;

/**
 * Input bb delivered to the agent that its timeline leaves out: `agent-only`
 * parts (plugin steers, mention context, retries) and system messages whose
 * tool-call subject asks to be suppressed.
 */
export interface HiddenMessage {
  kind: "hidden";
  id: string;
  requestId: string;
  /** Where bb's timeline would place the message: at its acceptance for a steer, at its request otherwise. */
  seq: number;
  startedAt: number;
  turnId: string | null;
  steer: boolean;
  retry: boolean;
  rejected: boolean;
  initiator: RequestData["initiator"];
  senderThreadId: string | null;
  systemMessageKind: SystemMessageKind;
  subjectThread: { threadId: string; threadName: string } | null;
  suppressedTool: string | null;
  /** The chat shows other parts of the same message, so this is extra context rather than a message of its own. */
  alongsideVisible: boolean;
  text: string;
  attachments: readonly string[];
  request: {
    seq: number;
    createdAt: number;
    expectedTurnId: string | null;
    threadStart: boolean;
    accepted: { seq: number; createdAt: number; turnId: string | null } | null;
  };
}

// Mirrors bb's parsePromptInput: a part the chat renders.
function isVisible(part: PromptPart): boolean {
  if (part.visibility === "agent-only") return false;
  return part.type !== "text" || part.text.length > 0;
}

function describeAttachment(part: PromptPart): string | null {
  switch (part.type) {
    case "text": return null;
    case "image": return `Image: ${part.url}`;
    case "localImage": return `Image: ${part.path}`;
    case "localFile": return `File: ${part.name ?? part.path}`;
  }
}

// bb treats a request as a steer while it still targets the turn it expected (resolveTurnRequestKind).
function settle(message: HiddenMessage): HiddenMessage {
  const { request } = message;
  const steer = request.expectedTurnId !== null &&
    (request.accepted?.turnId ?? request.expectedTurnId) === request.expectedTurnId;
  const placed = steer && request.accepted ? request.accepted : request;
  return {
    ...message,
    steer,
    seq: placed.seq,
    startedAt: placed.createdAt,
    turnId: request.threadStart ? null : request.accepted?.turnId ?? request.expectedTurnId,
  };
}

export function hiddenMessagesOf(event: RequestedEvent): HiddenMessage[] {
  const { data } = event;
  const subject = data.systemMessageSubject ?? null;
  const suppressedTool = data.initiator === "system" && subject?.kind === "tool-call" && subject.suppress
    ? subject.toolName : null;
  const groups = data.inputGroups ?? [data.input];
  const messages: HiddenMessage[] = [];
  groups.forEach((group, index) => {
    const parts = suppressedTool === null ? group.filter((part) => part.visibility === "agent-only") : group;
    if (parts.length === 0) return;
    messages.push(settle({
      kind: "hidden",
      id: groups.length > 1 ? `hidden:${data.requestId}:${index}` : `hidden:${data.requestId}`,
      requestId: data.requestId,
      seq: event.seq,
      startedAt: event.createdAt,
      turnId: null,
      steer: false,
      retry: data.retryOfRequestId !== undefined,
      rejected: false,
      initiator: data.initiator,
      senderThreadId: data.senderThreadId,
      systemMessageKind: data.systemMessageKind ?? "unlabeled",
      subjectThread: subject?.kind === "thread" ? { threadId: subject.threadId, threadName: subject.threadName } : null,
      suppressedTool,
      alongsideVisible: suppressedTool === null && group.some(isVisible),
      text: parts.flatMap((part) => part.type === "text" && part.text ? [part.text] : []).join("\n\n"),
      attachments: parts.flatMap((part) => describeAttachment(part) ?? []),
      request: {
        seq: event.seq,
        createdAt: event.createdAt,
        expectedTurnId: "expectedTurnId" in data.target ? data.target.expectedTurnId : null,
        threadStart: data.target.kind === "thread-start",
        accepted: null,
      },
    }));
  });
  return messages;
}

function updateRequest(
  messages: readonly HiddenMessage[],
  requestId: string,
  update: (message: HiddenMessage) => HiddenMessage,
): readonly HiddenMessage[] {
  if (!messages.some((message) => message.requestId === requestId)) return messages;
  return messages.map((message) => message.requestId === requestId ? update(message) : message);
}

/**
 * Folds request events, oldest first, into the hidden messages read so far. Returns
 * `messages` itself when nothing changed, and otherwise a new list ordered by `seq`.
 */
export function applyRequestEvents(
  messages: readonly HiddenMessage[],
  events: readonly ThreadEventRow[],
): readonly HiddenMessage[] {
  let next = messages;
  for (const event of events) {
    if (event.type === "client/turn/requested") {
      const known = new Set(next.map((message) => message.id));
      const added = hiddenMessagesOf(event).filter((message) => !known.has(message.id));
      if (added.length > 0) next = [...next, ...added];
    } else if (event.type === "turn/input/accepted") {
      const accepted = {
        seq: event.seq,
        createdAt: event.createdAt,
        turnId: event.scope.kind === "turn" ? event.scope.turnId : null,
      };
      next = updateRequest(next, event.data.clientRequestId,
        (message) => settle({ ...message, request: { ...message.request, accepted } }));
    } else if (event.type === "client/turn/rejected") {
      next = updateRequest(next, event.data.requestId, (message) => ({ ...message, rejected: true }));
    }
  }
  return next === messages ? messages : [...next].sort((left, right) => left.seq - right.seq);
}
