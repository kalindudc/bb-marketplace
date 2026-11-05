import {
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  createBridgeIo,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  modelListParamsSchema,
  providerMaintenanceParamsSchema,
  runBridgeRequest,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  type ClientTurnRequestId,
  type DeltaPresentation,
  type PromptInput,
  type ProviderHealthResult,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { randomUUID } from "node:crypto";
import { MODEL_ID, NOT_AN_AGENT, RENDERER_MODEL, parseRenderPrompt } from "./provider";

// The renderer's side of the Provider Bridge Protocol: line-delimited JSON-RPC over stdio. A turn echoes its prompt
// as one assistant message and ends; there is no model, no tool and no usage to report.

type JsonRpcId = string | number;
type Outbound = { jsonrpc: "2.0" } & Record<string, unknown>;

const io = createBridgeIo<Outbound>();
const nonce = randomUUID().replaceAll("-", "").slice(0, 12);
let threadCounter = 0;

interface Session {
  threadId: string;
  providerThreadId: string;
  turns: number;
}

const sessions = new Map<string, Session>();

const MESSAGE_PRESENTATION: DeltaPresentation = {
  label: { pending: "Showing a flare", completed: "Showed a flare" },
  icon: { glyph: "flare/flare" },
};

const HEALTH: ProviderHealthResult = {
  supported: true,
  health: {
    status: "ready",
    statusMessage: null,
    accountEmail: null,
    planLabel: null,
    installedVersion: null,
    minimumSupportedVersion: null,
    canInstall: false,
    canUpdate: false,
    loginCommand: null,
  },
};

function promptText(input: readonly PromptInput[]): string {
  return input
    .filter((item): item is Extract<PromptInput, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("");
}

/** The message a prompt turns into: the flare after the marker, or a note for anything Flare did not send. */
export function replyFor(prompt: string): string {
  return parseRenderPrompt(prompt)?.text ?? NOT_AN_AGENT;
}

function emit(threadId: string, deltas: ThreadDelta[]): void {
  io.send({ jsonrpc: "2.0", method: THREAD_DELTA_NOTIFICATION_METHOD, params: { threadId, deltas } });
}

function runTurn(session: Session, input: readonly PromptInput[], clientRequestId?: ClientTurnRequestId): void {
  const text = replyFor(promptText(input));
  if (text.trim() === "") {
    // Nothing to show: settle the turn without opening one, as a provider does for a prompt that did no work.
    emit(session.threadId, [
      ...(clientRequestId === undefined ? [] : [{ kind: "input.accepted" as const, clientRequestId }]),
      { kind: "turn.boundary", status: "completed", claimIfIdle: true },
    ]);
    return;
  }
  session.turns += 1;
  const key = { providerItemId: `flare-${session.providerThreadId}-t${session.turns}` };
  emit(session.threadId, [
    ...(clientRequestId === undefined ? [] : [{ kind: "input.accepted" as const, clientRequestId }]),
    { kind: "turn.open" },
    { kind: "item.open", key, item: { type: "agentMessage", text: "" }, presentation: MESSAGE_PRESENTATION },
    { kind: "item.textDelta", key, channel: "agentMessage", text },
    { kind: "item.textClose", key, channel: "agentMessage", text },
    { kind: "turn.boundary", status: "completed" },
  ]);
}

function openSession(threadId: string, providerThreadId: string): Session {
  const session: Session = { threadId, providerThreadId, turns: 0 };
  sessions.set(threadId, session);
  io.send({ jsonrpc: "2.0", method: BRIDGE_NOTIFICATION_METHODS.threadIdentity, params: { threadId, providerThreadId } });
  emit(threadId, [{ kind: "session.reset" }]);
  return session;
}

function invalidParams(id: JsonRpcId, method: string, issues: unknown): void {
  io.send({ jsonrpc: "2.0", id, error: { code: BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, message: `Invalid params for ${method}`, data: issues } });
}

type Handler = (id: JsonRpcId, params: unknown) => void;

const handlers: Record<string, Handler> = {
  [BRIDGE_REQUEST_METHODS.initialize]: (id, params) => {
    const parsed = initializeParamsSchema.safeParse(params);
    if (!parsed.success) return invalidParams(id, BRIDGE_REQUEST_METHODS.initialize, parsed.error.issues);
    io.sendResult(id, {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      capabilities: {
        // The handshake takes a [min, max] range; v3 is both.
        grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
        sessionRestore: true,
        threadArchive: false,
        threadRename: false,
        threadGoalClear: false,
        fork: "none",
        approvalEnforcedBy: "runtime",
        steerMode: "queue",
      },
    });
  },
  [BRIDGE_REQUEST_METHODS.modelList]: (id, params) => {
    const parsed = modelListParamsSchema.safeParse(params);
    if (!parsed.success) return invalidParams(id, BRIDGE_REQUEST_METHODS.modelList, parsed.error.issues);
    io.sendResult(id, { models: [{ ...RENDERER_MODEL, model: MODEL_ID }], selectedOnlyModels: [] });
  },
  [BRIDGE_REQUEST_METHODS.providerHealth]: (id, params) => {
    const parsed = providerMaintenanceParamsSchema.safeParse(params);
    if (!parsed.success) return invalidParams(id, BRIDGE_REQUEST_METHODS.providerHealth, parsed.error.issues);
    io.sendResult(id, HEALTH);
  },
  [BRIDGE_REQUEST_METHODS.threadStart]: (id, params) => {
    const parsed = threadStartParamsSchema.safeParse(params);
    if (!parsed.success) return invalidParams(id, BRIDGE_REQUEST_METHODS.threadStart, parsed.error.issues);
    threadCounter += 1;
    const providerThreadId = `flare_${nonce}_${threadCounter}`;
    const session = openSession(parsed.data.threadId, providerThreadId);
    io.sendResult(id, { providerThreadId, sessionRestorable: true });
    if (parsed.data.input !== undefined && parsed.data.input.length > 0) runTurn(session, parsed.data.input);
  },
  [BRIDGE_REQUEST_METHODS.threadResume]: (id, params) => {
    const parsed = threadResumeParamsSchema.safeParse(params);
    if (!parsed.success) return invalidParams(id, BRIDGE_REQUEST_METHODS.threadResume, parsed.error.issues);
    openSession(parsed.data.threadId, parsed.data.providerThreadId);
    io.sendResult(id, { providerThreadId: parsed.data.providerThreadId, sessionRestorable: true });
  },
  [BRIDGE_REQUEST_METHODS.turnStart]: (id, params) => {
    const parsed = turnStartParamsSchema.safeParse(params);
    if (!parsed.success) return invalidParams(id, BRIDGE_REQUEST_METHODS.turnStart, parsed.error.issues);
    const session = sessions.get(parsed.data.threadId);
    if (session === undefined) {
      return io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, `No session for thread ${parsed.data.threadId}; send thread/start or thread/resume first`);
    }
    io.sendResult(id, {});
    runTurn(session, parsed.data.input, parsed.data.clientRequestId);
  },
  [BRIDGE_REQUEST_METHODS.turnSteer]: (id, params) => {
    const parsed = turnSteerParamsSchema.safeParse(params);
    if (!parsed.success) return invalidParams(id, BRIDGE_REQUEST_METHODS.turnSteer, parsed.error.issues);
    // A turn ends in the same batch it opens, so there is never one to steer.
    io.sendError(id, BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN, `No active turn to steer (expected ${parsed.data.expectedTurnId})`);
  },
  [BRIDGE_REQUEST_METHODS.threadStop]: (id, params) => {
    const parsed = threadStopParamsSchema.safeParse(params);
    if (!parsed.success) return invalidParams(id, BRIDGE_REQUEST_METHODS.threadStop, parsed.error.issues);
    sessions.delete(parsed.data.threadId);
    io.sendResult(id, {});
  },
};

export function handleLine(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message !== "object" || message === null || Array.isArray(message)) return;
  const { id, method, params } = message as { id?: unknown; method?: unknown; params?: unknown };
  // The renderer sends no requests of its own, so a response is never expected.
  if (typeof method !== "string") return;
  if (typeof id !== "string" && typeof id !== "number") return;
  const handler = handlers[method];
  if (handler === undefined) {
    io.sendError(id, BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
    return;
  }
  runBridgeRequest({ request: { id, method, params }, sendError: io.sendError, handleRequest: async (request) => handler(request.id, request.params) });
}

export const experimental_providerBridge = experimental_defineProviderBridge({ handleLine });
