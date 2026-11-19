import type { Actor, BoardQuest, Phase, Plan } from "../../shared/schema";
import type { KeeperStore } from "./store";

export const STORED_PHASES = ["scout", "greenlight", "build", "held", "closing", "done", "stopping", "stopped"] as const;
type StoredPhase = typeof STORED_PHASES[number];
type Row = { from: StoredPhase | null; to: StoredPhase; cause: string; actors: Actor["kind"][]; receipt: string; event: string };
const rows = (from: Row["from"][], to: StoredPhase[], cause: string, actors: Actor["kind"][], receipt: string, event: string): Row[] => from.flatMap(f => to.map(t => ({ from: f, to: t, cause, actors, receipt, event })));
export const QUEST_TRANSITIONS: readonly Row[] = [
  ...rows([null], ["scout"], "open", ["agent"], "user-message", "quest.opened"),
  ...rows(["scout", "build"], ["greenlight"], "plan", ["agent"], "plan", "plan.proposed"),
  ...rows(["greenlight"], ["build"], "replacement-plan", ["agent"], "ask-answer", "plan.proposed"),
  ...rows(["greenlight"], ["build"], "replacement-plan", ["agent"], "decision", "plan.proposed"),
  ...rows(["greenlight"], ["build"], "approve", ["user"], "ask-answer", "ask.answered"),
  ...rows(["greenlight"], ["build"], "auto-approve", ["agent"], "decision", "decision.made"),
  ...rows(["build"], ["greenlight"], "undo", ["user"], "undo", "decision.undone"),
  ...rows(["build"], ["closing"], "close", ["agent"], "ask", "ask.opened"),
  ...rows(["build"], ["closing"], "conclude-open-at-upgrade", ["tavern"], "ask", "ask.opened"),
  ...rows(["closing"], ["build"], "conclude-withdrawn", ["tavern"], "ask", "ask.withdrawn"),
  ...rows(["closing"], ["build"], "keep-open", ["user"], "ask-answer", "quest.kept-open"),
  ...rows(["closing"], ["build"], "extensions", ["user"], "ask-answer", "quest.extended"),
  ...rows(["closing"], ["done"], "conclude", ["user"], "ask-answer", "quest.wrapped"),
  ...rows(["scout", "greenlight", "build", "held", "closing"], ["stopping"], "stop", ["user"], "user-act", "quest.stopping"),
  ...rows(["stopping"], ["stopped"], "stopped", ["tavern"], "members-stopped", "quest.stopped"),
  ...rows(["done", "stopped"], ["scout", "build"], "reopen", ["agent"], "user-message", "quest.reopened"),
  ...rows(["scout", "greenlight", "build"], ["held"], "hold", ["user"], "user-act", "quest.held"),
  ...rows(["scout", "greenlight", "build"], ["held"], "hold", ["agent"], "user-message", "quest.held"),
  ...rows(["held"], ["scout", "greenlight", "build"], "resume", ["user"], "user-act", "quest.resumed"),
  ...rows(["held"], ["scout", "greenlight", "build"], "resume", ["agent"], "user-message", "quest.resumed"),
];
export function partyCounts(plan: Plan): Map<string, number> {
  const counts = new Map<string, number>();
  for (const slot of plan.party) counts.set(slot.classId, (counts.get(slot.classId) ?? 0) + 1);
  return counts;
}
export function partyFits(plan: Plan, approved: Plan) {
  const capacity = partyCounts(approved);
  return [...partyCounts(plan)].every(([classId, count]) => count <= (capacity.get(classId) ?? 0));
}
export function approvedPartyReceipt(store: KeeperStore, quest: BoardQuest): { kind: string; id: string } | null {
  if (quest.greenlitVersion === null) return null;
  const ask = store.query("asks", "boardQuestId", quest.id, 500).find(ask => ask.kind === "greenlight" && ask.answer?.by === "user" && ask.answer.optionId === "approve" && ask.effect?.type === "greenlight" && ask.effect.planVersion === quest.greenlitVersion);
  if (ask) return { kind: "ask-answer", id: ask.id };
  const decision = store.query("decisions", "boardQuestId", quest.id, 500).find(decision => {
    const approval = store.get("autoGreenlights", decision.id);
    return approval?.boardQuestId === quest.id && approval.planVersion === quest.greenlitVersion && !decision.undone && decision.reversible;
  });
  return decision && !decision.undone && decision.reversible ? { kind: "decision", id: decision.id } : null;
}
const authorised = new WeakSet<object>();
export const consumesQuestWrite = (record: object) => authorised.delete(record);
export const storedPhase = (phase: Phase): StoredPhase => phase === "check" || phase === "wrap" ? "build" : phase;
export function assertQuestTransition(store: KeeperStore, quest: BoardQuest, to: Phase, cause: string, actor: Actor, receipt: { kind: string; id: string; text?: string }, options: { patch?: Partial<Omit<BoardQuest, "phase">> } = {}) {
    const current = store.get("quests", quest.id);
    const from = current ? storedPhase(current.phase) : null;
    const row = QUEST_TRANSITIONS.find(r => r.from === from && r.to === to && r.cause === cause && r.actors.includes(actor.kind) && r.receipt === receipt.kind);
    if (!row || !receipt.id.trim()) throw new Error(`Quest lifecycle refuses ${from} to ${to} for ${cause}`);
    if (cause === "replacement-plan") {
      const approval = current && approvedPartyReceipt(store, current);
      const plan = store.get("plans", `${quest.id}:${options.patch?.planVersion}`);
      const approved = current && store.get("plans", `${quest.id}:${current.greenlitVersion}`);
      if (!approval || approval.kind !== receipt.kind || approval.id !== receipt.id || !plan || !approved || !partyFits(plan, approved)) throw new Error("Replacement plan requires this quest's earlier party approval");
    }
    if (cause === "resume" && current?.held?.from !== to) throw new Error("Resume must return to the held quest's previous state");
    if (cause === "reopen" && to !== (current?.greenlitVersion == null ? "scout" : "build")) throw new Error("Reopen must follow the greenlit plan");
    return { current, from, row };
}
export function transitionQuest(store: KeeperStore, quest: BoardQuest, to: Phase, cause: string, actor: Actor, receipt: { kind: string; id: string; text?: string; surface?: string; at?: number }, at: number, options: { patch?: Partial<Omit<BoardQuest, "phase">>; text?: string; data?: Record<string, unknown> } = {}): BoardQuest {
  return store.atomic(() => {
    const { current, from, row } = assertQuestTransition(store, quest, to, cause, actor, receipt, options);
    const result: BoardQuest = { ...(current ?? quest), ...options.patch, phase: to, updatedAt: at, ...(to === "held" ? { held: { from: from as "scout" | "greenlight" | "build", since: at } } : {}) };
    if (to !== "held") delete result.held;
    if (to === "done" || to === "stopping" || to === "stopped") result.reviewAllowance = result.reviewAllowance?.filter(grant => grant.usedBy !== null);
    const cursors = { ...store.runtime(quest.keeperThreadId).heldNewsCursors };
    if (to === "held") cursors[quest.id] = { cursor: cursors[quest.id]?.cursor ?? store.eventSequence(quest.keeperThreadId) };
    if (from === "held" && !cursors[quest.id]) {
      const hold = store.questHeldEvent(quest.id, Number.MAX_SAFE_INTEGER);
      cursors[quest.id] = { cursor: hold ? hold.id - 1 : 0 };
    }
    authorised.add(result);
    store.put("quests", quest.id, result);
    store.event(at, quest.keeperThreadId, quest.id, row.event, options.text ?? `${quest.title}: ${from ?? "new"} to ${to}`, { ...options.data, cause, phase: { from, to }, receipt }, actor);
    if (from === "held") cursors[quest.id] = { ...cursors[quest.id]!, through: store.eventSequence(quest.keeperThreadId) };
    if (to === "held" || from === "held") store.patch(quest.keeperThreadId, { heldNewsCursors: cursors });
    return result;
  });
}
export function displayStage(phase: Phase, waypoints: { state: string }[], hasPlan: boolean): Phase {
  const stored = storedPhase(phase);
  if (stored !== "build" || !hasPlan) return stored;
  return waypoints.every(w => ["verified", "skipped"].includes(w.state)) ? "wrap" : waypoints.some(w => w.state === "reported") ? "check" : "build";
}
export function nextNewsBy(phase: Phase, boxes: number[], promises: number[]): number | null {
  const times = [...boxes, ...promises];
  return phase === "scout" && times.length ? Math.min(...times) : null;
}
