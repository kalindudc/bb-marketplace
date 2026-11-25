import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { StudyEvents } from "./study-events";
import type { Keeper } from "./keeper/service";

export type NativeEvents = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>;
type Request = Extract<NativeEvents[number], { type: "client/turn/requested" }>["data"];
type TurnKind = "tick" | "user-message" | "member-report" | "memory-checkpoint" | "other";
export function turnKind(request: Pick<Request, "initiator" | "input" | "originPluginId" | "senderThreadId" | "systemMessageKind" | "systemMessageSubject">, pluginId: string, isMember: (id: string) => boolean): TurnKind {
  if (request.initiator === "user" && !request.originPluginId && !request.senderThreadId) return "user-message";
  const first = request.input.find(block => block.type === "text");
  if (request.originPluginId === pluginId && first?.text.startsWith("[Tavern tick]")) return "tick";
  if (first?.text.startsWith("Memory checkpoint") && (request.initiator === "system" || request.originPluginId)) return "memory-checkpoint";
  const subject = request.systemMessageSubject;
  if (request.initiator === "system" && request.systemMessageKind?.startsWith("child-")) {
    if (subject?.kind === "thread" && isMember(subject.threadId) || subject?.kind === "thread-batch" && subject.outcomes?.some(outcome => isMember(outcome.threadId))) return "member-report";
  }
  return "other";
}

type Tokens = { input: number; cached: number; output: number };
type Usage = Extract<NativeEvents[number], { type: "thread/tokenUsage/updated" }>["data"]["tokenUsage"];
const tokens = ({ inputTokens, cachedInputTokens, outputTokens }: Usage["last"]): Tokens =>
  ({ input: inputTokens, cached: cachedInputTokens, output: outputTokens });
function addUsage(turn: Turn, usage: Usage) {
  const last = tokens(usage.last), total = tokens(usage.total), before = turn.total;
  // `last` can be one model call, not a full turn; later snapshots can include calls BB did not emit individually.
  const delta = before && total.input >= before.input && total.cached >= before.cached && total.output >= before.output
    ? { input: total.input - before.input, cached: total.cached - before.cached, output: total.output - before.output } : last;
  const prior = turn.tokens;
  turn.tokens = prior ? { input: prior.input + delta.input, cached: prior.cached + delta.cached, output: prior.output + delta.output } : delta;
  turn.total = total;
}
type Turn = { id: string; kind?: TurnKind; tokens?: Tokens; total?: Tokens };
type State = { seq: number; requests: [string, TurnKind][]; turn?: Turn };
const eventTypes = ["client/turn/requested", "client/turn/rejected", "turn/started", "turn/input/accepted", "thread/tokenUsage/updated", "turn/completed"] as const;
// BB's thread events API caps pages at 100 rows. This does not cap the study's history.
const sdkPageSize = "100";

export class StudyTurns {
  private readonly observing = new Map<string, { through: number; done: Promise<void> }>();
  private disposed = false;
  constructor(private readonly bb: BbPluginApi, private readonly keeper: Keeper, private readonly study: StudyEvents) {}
  dispose() { this.disposed = true; }
  observe(threadId: string, through: number) {
    if (this.disposed || !this.keeper.member(threadId)) return;
    const pending = this.observing.get(threadId);
    if (pending) { pending.through = Math.max(through, pending.through); return pending.done; }
    const work: { through: number; done: Promise<void> } = { through, done: Promise.resolve() };
    work.done = this.read(threadId, work).finally(() => this.observing.delete(threadId));
    this.observing.set(threadId, work);
    return work.done;
  }
  private async read(threadId: string, work: { through: number }) {
    const { store } = this.keeper;
    const state = this.study.state<State>(threadId, "turns") ?? { seq: store.runtime(threadId).eventSequence, requests: [] };
    const requests = new Map(state.requests);
    while (!this.disposed && state.seq < work.through) {
      const through = work.through;
      const rows = await this.bb.sdk.threads.events.list({ threadId, afterSeq: String(state.seq), types: [...eventTypes], limit: sdkPageSize, order: "asc" });
      if (this.disposed) return;
      const member = this.keeper.member(threadId);
      if (!member) return;
      store.atomic(() => {
        for (const row of rows) {
          if (row.seq <= state.seq) continue;
          state.seq = row.seq;
          const id = row.scope?.kind === "turn" ? row.scope.turnId : null;
          if (row.type === "client/turn/requested") requests.set(row.data.requestId,
            turnKind(row.data, this.bb.pluginId, child => this.keeper.member(child)?.keeperThreadId === threadId));
          if (row.type === "client/turn/rejected") requests.delete(row.data.requestId);
          if (row.type === "turn/started" && id && !row.data.parentToolCallId) state.turn = { id };
          if (row.type === "turn/input/accepted") {
            const kind = requests.get(row.data.clientRequestId);
            requests.delete(row.data.clientRequestId);
            if (state.turn && id === state.turn.id) state.turn.kind ??= kind ?? "other";
          }
          if (!state.turn || state.turn.id !== id) continue;
          if (row.type === "thread/tokenUsage/updated") addUsage(state.turn, row.data.tokenUsage);
          if (row.type === "turn/completed") {
            const { kind, tokens } = state.turn;
            const counts = tokens ?? { input: null, cached: null, output: null };
            this.study.record("turn.usage", threadId, member.boardQuestId, {
              turnId: id, turnKind: kind ?? "other", status: row.data.status, ...counts,
            }, row.createdAt, JSON.stringify(["turn", threadId, id]));
            delete state.turn;
          }
        }
        if (rows.length < Number(sdkPageSize)) state.seq = Math.max(state.seq, through);
        state.requests = [...requests];
        this.study.setState(threadId, "turns", state);
      });
    }
  }
}
