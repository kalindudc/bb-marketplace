import type { Actor, BoardQuest, Phase, Plan, WaypointState } from "../../shared/schema";
import type { KeeperStore } from "./store";
import { rangerOnlyPlan, settled, waypointCheck } from "../../shared/waypoint";

export const STORED_PHASES = ["scout", "greenlight", "build", "held", "closing", "done", "stopping", "stopped"] as const;
type StoredPhase = typeof STORED_PHASES[number];
type Row = { from: StoredPhase | null; to: StoredPhase; cause: string; actors: Actor["kind"][]; receipt: string; event: string };
const rows = (from: Row["from"][], to: StoredPhase[], cause: string, actors: Actor["kind"][], receipt: string, event: string): Row[] => from.flatMap(f => to.map(t => ({ from: f, to: t, cause, actors, receipt, event })));
export const QUEST_TRANSITIONS: readonly Row[] = [
  ...rows([null], ["scout"], "open", ["agent"], "user-message", "quest.opened"),
  ...rows([null], ["scout"], "open-lead", ["agent"], "hire", "quest.opened"),
  ...rows(["scout", "build"], ["greenlight"], "plan", ["agent"], "plan", "plan.proposed"),
  ...rows(["scout", "greenlight"], ["build"], "ranger-plan", ["agent"], "plan", "plan.proposed"),
  ...rows(["greenlight"], ["build"], "replacement-plan", ["agent"], "ask-answer", "plan.proposed"),
  ...rows(["greenlight"], ["build"], "replacement-plan", ["agent"], "decision", "plan.proposed"),
  ...rows(["greenlight"], ["build"], "approve", ["user"], "ask-answer", "ask.answered"),
  ...rows(["greenlight"], ["build"], "approve-lead", ["agent"], "decision", "lead.plan-approved"),
  ...rows(["greenlight"], ["build"], "approve-lead-user", ["user"], "ask-answer", "lead.plan-approved"),
  ...rows(["greenlight"], ["build"], "auto-approve", ["agent"], "decision", "decision.made"),
  ...rows(["build"], ["greenlight"], "undo", ["user"], "undo", "decision.undone"),
  ...rows(["scout", "greenlight", "build"], ["closing"], "close", ["agent"], "ask", "ask.opened"),
  ...rows(["build"], ["closing"], "conclude-open-at-upgrade", ["tavern"], "ask", "ask.opened"),
  ...rows(["closing"], ["scout", "greenlight", "build"], "conclude-withdrawn", ["tavern"], "ask", "ask.withdrawn"),
  ...rows(["closing"], ["scout", "greenlight", "build"], "keep-open", ["user"], "ask-answer", "quest.kept-open"),
  ...rows(["closing"], ["build"], "extensions", ["user"], "ask-answer", "quest.extended"),
  ...rows(["closing"], ["done"], "conclude", ["user"], "ask-answer", "quest.wrapped"),
  ...rows(["closing"], ["done"], "conclude-lead", ["agent"], "ask-answer", "quest.wrapped"),
  ...rows(["closing"], ["done"], "close-early", ["user"], "ask-answer", "quest.wrapped"),
  ...rows(["scout", "greenlight", "build", "held", "closing"], ["stopping"], "stop", ["user"], "user-act", "quest.stopping"),
  ...rows(["scout", "greenlight", "build", "held", "closing"], ["stopping"], "stop-chain", ["tavern"], "chain-stop", "quest.stopping"),
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
export const isScoutClass = (classId: string) => classId === "ranger" || classId === "wanderer";
export const workingSeats = (plan: Plan) => plan.party.filter(slot => !isScoutClass(slot.classId)).length;

export function partyFits(plan: Plan, approved: Plan) {
  const classes = partyCounts(approved);
  return plan.party.length <= approved.party.length && workingSeats(plan) <= workingSeats(approved) &&
    plan.party.every(({ permanent, leadEnvelope, classId, waypointIds }) =>
      classes.has(classId) && (!permanent || !!permanent.decisionId && approved.party.some(slot => slot.permanent?.decisionId === permanent.decisionId)) &&
      (!leadEnvelope || approved.party.some(previous =>
        previous.classId === classId && previous.waypointIds[0] === waypointIds[0] &&
        previous.leadEnvelope && previous.leadEnvelope.members >= leadEnvelope.members &&
        previous.leadEnvelope.rangers >= leadEnvelope.rangers)));
}
export function checksFit(plan: Plan, approved: Plan, earlier: Plan | null = null, isSettled: (waypointId: string) => boolean = () => false) {
  const strength = { none: 0, keeper: 1, you: 2, warden: 3 };
  const checks = new Map([...(earlier?.waypoints ?? []), ...approved.waypoints].map(w => [w.id, strength[waypointCheck(w)]]));
  if (plan.waypoints.some(w => strength[waypointCheck(w)] < (checks.get(w.id) ?? 0))) return false;
  const kept = new Set(plan.waypoints.map(w => w.id));
  return approved.waypoints.every(w => {
    const check = waypointCheck(w);
    return kept.has(w.id) || check !== "warden" && check !== "keeper" || isSettled(w.id);
  });
}
export function approvedPartyReceipt(store: KeeperStore, quest: BoardQuest): { kind: string; id: string } | null {
  if (quest.greenlitVersion === null) return null;
  const leadPlan = store.get("leadPlans", `${quest.id}:${quest.greenlitVersion}`);
  if (leadPlan) return leadPlan.state === "approved" ? leadPlan.receipt : null;
  const ask = store.query("asks", "boardQuestId", quest.id, 500).find(ask => ask.kind === "greenlight" && (ask.answer?.by === "user" || ask.answer?.by === "preapproval") && ask.answer.optionId === "approve" && ask.effect?.type === "greenlight" && ask.effect.planVersion === quest.greenlitVersion);
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
    if (cause === "open-lead") {
      const member = store.get("members", quest.keeperThreadId);
      const link = member?.leadLinkId ? store.get("leadLinks", member.leadLinkId) : null;
      if (!link || link.state !== "linked" || link.childQuestId !== null || link.hireToken !== receipt.id ||
          link.childKeeperThreadId !== quest.keeperThreadId || actor.kind !== "agent" || actor.threadId !== quest.keeperThreadId)
        throw new Error("Opening a child quest requires its recorded lead hire receipt.");
    }
    if (cause === "approve-lead" || cause === "approve-lead-user") {
      const record = store.get("leadPlans", `${quest.id}:${quest.planVersion}`);
      const link = record && store.get("leadLinks", record.linkId);
      if (!record || record.state !== "approved" || record.receipt?.id !== receipt.id || record.receipt.kind !== receipt.kind ||
          !link || link.childQuestId !== quest.id || link.generation !== record.generation ||
          (actor.kind === "agent" && link.parentKeeperThreadId !== actor.threadId))
        throw new Error("This child needs the current exact lead-plan approval.");
    }
    if (cause === "conclude-lead") {
      const ask = store.get("asks", receipt.id);
      const binding = ask?.effect?.type === "conclude" && ask.effect.draft.lead;
      const link = binding && store.get("leadLinks", binding.linkId);
      const parent = link && store.get("quests", link.parentQuestId);
      if (!binding || !link || !parent || actor.kind !== "agent" || actor.threadId !== parent.keeperThreadId ||
          link.parentKeeperThreadId !== actor.threadId || link.childQuestId !== quest.id ||
          link.childKeeperThreadId !== quest.keeperThreadId || link.state !== "linked" ||
          link.generation !== binding.generation || parent.planVersion !== binding.parentVersion ||
          ask?.boardQuestId !== quest.id || ask.keeperThreadId !== quest.keeperThreadId ||
          ask.answer?.by !== "keeper" || ask.answer.optionId !== "conclude")
        throw new Error("This conclusion requires the current hiring Keeper and exact child request.");
    }
    if (cause === "ranger-plan") {
      const plan = store.get("plans", receipt.id);
      if (!current || actor.kind !== "agent" || actor.threadId !== current.keeperThreadId ||
          !plan || plan.boardQuestId !== current.id || plan.version !== options.patch?.checkPlanVersion ||
          !rangerOnlyPlan(plan) || store.leadLinksBy("childQuestId", current.id).length)
        throw new Error("Proceeding without staffing approval requires this quest's recorded Ranger-only plan.");
    }
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
    if (to === "stopped") result.outcome = "stopped";
    if (cause === "reopen") { delete result.outcome; delete result.waivers; }
    if (to === "done" || to === "stopping" || to === "stopped") result.reviewAllowance = result.reviewAllowance?.filter(grant => grant.usedBy !== null);
    const cursors = { ...store.runtime(quest.keeperThreadId).heldNewsCursors };
    if (to === "held") cursors[quest.id] = { cursor: cursors[quest.id]?.cursor ?? store.eventSequence(quest.keeperThreadId) };
    if (from === "held" && !cursors[quest.id]) {
      const hold = store.questHeldEvent(quest.id, Number.MAX_SAFE_INTEGER);
      cursors[quest.id] = { cursor: hold ? hold.id - 1 : 0 };
    }
    if (to === "done" || to === "stopping" || to === "stopped") {
      for (const field of ["delegations", "preapprovals"] as const) {
        result[field] = result[field]?.map(grant => {
          if (grant.endedAt !== null || grant.revokedAt !== null) return grant;
          store.event(at, quest.keeperThreadId, quest.id, field === "delegations" ? "delegation.ended" : "preapproval.ended", "Quest authority ended with the quest", { id: grant.id }, { kind: "tavern" });
          return { ...grant, endedAt: at };
        }) as never;
      }
      for (const member of store.query("members", "boardQuestId", quest.id, 500)) {
        const details = store.runtime(member.threadId).memberEngagement;
        if (details?.keep || details?.rest?.keep)
          store.patch(member.threadId, { memberEngagement: { ...details, keep: null, ...(details.rest?.keep ? { rest: { ...details.rest, keep: null } } : {}) } });
      }
    }
    authorised.add(result);
    store.put("quests", quest.id, result);
    store.event(at, quest.keeperThreadId, quest.id, row.event, options.text ?? `${quest.title}: ${from ?? "new"} to ${to}`, { ...options.data, ...(to === "stopped" ? { closure: result.outcome } : {}), cause, phase: { from, to }, stripPlanVersion: result.planVersion, receipt }, actor);
    if (from === "held") cursors[quest.id] = { ...cursors[quest.id]!, through: store.eventSequence(quest.keeperThreadId) };
    if (to === "held" || from === "held") store.patch(quest.keeperThreadId, { heldNewsCursors: cursors });
    return result;
  });
}
export function displayStage(phase: Phase, waypoints: { state: WaypointState }[], hasPlan: boolean): Phase {
  const stored = storedPhase(phase);
  if (stored !== "build" || !hasPlan) return stored;
  return waypoints.every(settled) ? "wrap" : waypoints.some(w => w.state === "reported") ? "check" : "build";
}
export function nextNewsBy(phase: Phase, boxes: number[], promises: number[]): number | null {
  const times = [...boxes, ...promises];
  return phase === "scout" && times.length ? Math.min(...times) : null;
}
