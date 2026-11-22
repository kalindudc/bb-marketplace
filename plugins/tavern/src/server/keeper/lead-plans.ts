import { isDeepStrictEqual } from "node:util";
import { leadPlanRecordSchema, type BoardQuest, type Decision, type LeadLink, type LeadPlanRecord, type LeadPlanReview, type Plan } from "../../shared/schema";
import { waypointCheck } from "../../shared/waypoint";
import { readUndoLanes } from "../undo-record";
import { assertChainPlan, assertLeadPathOpen, leadAncestors, subtreeSeats } from "./leads";
import { approvedPartyReceipt, transitionQuest } from "./quest-lifecycle";
import type { Keeper } from "./service";
import { planDiff } from "./plan-diff";

const checkRank = { none: 0, keeper: 1, warden: 2, you: 3 } as const;
const planId = (questId: string, version: number) => `${questId}:${version}`;
const sameAct = (a: LeadPlanReview["approved"]["acts"][number], b: typeof a) => isDeepStrictEqual(a, b);
const requirements = (link: LeadLink) => link.amendedRequirements ?? { check: link.parentPlan.check, acts: link.parentPlan.acts ?? [] };
const pathBasis = (path: LeadLink[]) => path.map(link => ({ linkId: link.id, generation: link.generation, amendedBy: link.amendedBy ?? null }));

function review(k: Keeper, child: BoardQuest, plan: Plan, path: LeadLink[], why: string): LeadPlanReview {
  const primary = path[0]!;
  const work = plan.waypoints.filter(w => w.actor === "agent");
  const check = work.map(waypointCheck).reduce((weakest, next) => checkRank[next] < checkRank[weakest] ? next : weakest, requirements(primary).check);
  const acts = work.flatMap(w => w.acts ?? []).filter((act, i, all) => all.findIndex(previous => sameAct(previous, act)) === i);
  const depth = Math.max(path.length, ...plan.party.flatMap(slot => slot.leadEnvelope ? [slot.leadEnvelope.depth] : []));
  const comparisons = path.map(link => {
    const parent = k.quest(link.parentQuestId);
    const limits = requirements(link);
    const actual = subtreeSeats(k.store, link.childQuestId!, plan);
    const approved = { ...link.envelope, ...limits };
    const requested = { ...actual, depth, check: checkRank[check] < checkRank[limits.check] ? check : limits.check, acts };
    const addedActs = acts.filter(act => !limits.acts.some(previous => sameAct(previous, act)));
    const wider = actual.members > approved.members || actual.rangers > approved.rangers || depth > approved.depth || requested.check !== approved.check || addedActs.length > 0;
    const amended = { members: Math.max(approved.members, actual.members), rangers: Math.max(approved.rangers, actual.rangers),
      depth: Math.max(approved.depth, depth), check: requested.check, acts: [...approved.acts, ...addedActs] };
    return { parent, wide: wider ? { linkId: link.id, questTitle: parent.title, approved, requested: amended } : null, approved, requested };
  });
  const first = comparisons[0]!;
  const previous = k.store.get("plans", planId(child.id, plan.version - 1));
  const diff = previous && planDiff(previous, plan);
  const changed = diff && new Set(diff.waypoints.changed.map(w => w.id));
  return { childQuestId: child.id, version: plan.version, parentQuestId: first.parent.id, parentWaypointId: primary.parentWaypointId,
    parentTitle: first.parent.title, approved: first.approved, requested: first.requested, changes: comparisons.flatMap(item => item.wide ? [item.wide] : []), why,
    ...(previous && diff && changed ? { planChanges: { fromVersion: previous.version, fields: Object.keys(diff.fields),
      addedWaypoints: diff.waypoints.added.map(w => w.title), removedWaypoints: diff.waypoints.removed.map(w => w.title),
      changedWaypoints: plan.waypoints.filter(w => changed.has(w.id)).map(w => w.title), orderChanged: !!diff.waypoints.order } } : {}) };
}

function requiresUser(plan: Plan) {
  return !plan.reversible || plan.questions.length > 0 || plan.waypoints.some(w => w.actor !== "agent") || plan.alwaysAskKinds.length > 0;
}

export function proposeLeadPlan(k: Keeper, child: BoardQuest, plan: Plan, path: LeadLink[]) {
  const link = path[0]!;
  assertLeadPathOpen(k.store, link);
  const parent = k.quest(link.parentQuestId);
  const approval = approvedPartyReceipt(k.store, parent);
  if (!approval) throw new Error("The parent waypoint has no current party approval.");
  const before = k.store.get("leadPlans", planId(child.id, child.planVersion));
  if (before?.state === "pending") k.store.put("leadPlans", planId(child.id, child.planVersion), { ...before, state: "superseded" });
  const request = review(k, child, plan, path, "");
  const why = request.changes.length ? "The lead is asking to change the parent-approved limits."
    : requiresUser(plan) ? "This plan has a question, a user decision or work that is not reversible."
    : readUndoLanes(k.store, parent.keeperThreadId).some(lane => lane.kind === "lead-plan") ? "You took these decisions back after undoing earlier lead-plan calls." : "";
  const record = leadPlanRecordSchema.parse({ request: { ...request, why }, linkId: link.id, generation: link.generation,
    parentVersion: parent.planVersion, parentApproval: approval, basis: pathBasis(path), lane: why ? "user" : "keeper", state: "pending", receipt: null });
  k.store.put("leadPlans", planId(child.id, plan.version), record);
  k.store.event(k.now(), parent.keeperThreadId, parent.id, "lead.plan-proposed", `${child.title}, plan v${plan.version}: ${why ? "waiting for you" : "hiring Keeper decides"}.`, {
    childQuestId: child.id, planVersion: plan.version, leadLinkId: link.id,
  }, { kind: "agent", threadId: child.keeperThreadId });
  if (why) askForLeadPlan(k, child, record);
}

function askForLeadPlan(k: Keeper, child: BoardQuest, record: LeadPlanRecord) {
  const effect = { type: "lead-plan" as const, request: record.request };
  const existing = k.store.openAsks(child.keeperThreadId, child.id).find(ask => isDeepStrictEqual(ask.effect, effect));
  if (existing) return existing;
  const amend = record.request.changes.length > 0;
  return k.ask(child.keeperThreadId, { boardQuestId: child.id, kind: "greenlight", effect,
    question: `Approve ${child.title.slice(0, 75)}, plan v${record.request.version}?`, why: record.request.why.slice(0, 200),
    options: [{ id: "approve", label: amend ? "Change limits and approve this plan" : "Approve this plan", recommended: false,
      detail: amend ? "Record these changes to the lead’s limits and approve only this plan version." : "Approve only this plan version." },
      { id: "revise", label: "Ask for a revision", recommended: false, detail: "Keep the current limits. Do not start staffing." }],
    holds: [], meanwhile: "The lead can prepare but cannot staff this plan." }, {}, true);
}

function pending(k: Keeper, childQuestId: string, version: number) {
  const child = k.quest(childQuestId);
  const record = k.store.get("leadPlans", planId(childQuestId, version));
  if (!record || record.state !== "pending" || child.planVersion !== version || child.phase !== "greenlight")
    throw new Error("This lead plan version is no longer pending or has been superseded.");
  const path = leadAncestors(k.store, childQuestId);
  const link = path[0];
  if (!link || link.id !== record.linkId || link.childKeeperThreadId !== child.keeperThreadId || !isDeepStrictEqual(pathBasis(path), record.basis))
    throw new Error("The lead link changed. Ask for a fresh child plan.");
  assertLeadPathOpen(k.store, link);
  const parent = k.quest(link.parentQuestId);
  if (parent.planVersion !== record.parentVersion || !isDeepStrictEqual(approvedPartyReceipt(k.store, parent), record.parentApproval))
    throw new Error("The parent approval changed. Ask for a fresh child plan.");
  const plan = k.store.get("plans", planId(childQuestId, version));
  if (!plan) throw new Error("The exact child plan is missing.");
  assertChainPlan(k, child, plan);
  if (!isDeepStrictEqual(review(k, child, plan, path, record.request.why), record.request))
    throw new Error("The approved limits or the requested party changed. Ask for a fresh child plan.");
  return { child, parent, plan, record, path };
}

function settle(k: Keeper, child: BoardQuest, record: LeadPlanRecord, receipt: NonNullable<LeadPlanRecord["receipt"]>, approve: boolean, actor: { kind: "user" } | { kind: "agent"; threadId: string }) {
  k.store.put("leadPlans", planId(child.id, record.request.version), { ...record, state: approve ? "approved" : "refused", receipt });
  if (approve) transitionQuest(k.store, child, "build", receipt.kind === "decision" ? "approve-lead" : "approve-lead-user", actor, receipt, k.now(), {
    patch: { greenlitVersion: record.request.version, checkPlanVersion: record.request.version }, text: `Approved child plan v${record.request.version}.`,
    data: { leadLinkId: record.linkId, ...(receipt.kind === "decision" ? { decisionId: receipt.id } : { askId: receipt.id }) },
  });
  else k.store.event(k.now(), child.keeperThreadId, child.id, "lead.plan-refused", `Revise child plan v${record.request.version}.`, { receipt }, actor);
}

export function decideLeadPlan(k: Keeper, threadId: string, input: Parameters<Keeper["decideOrAsk"]>[1]) {
  const target = input.leadPlan!;
  const result = k.store.atomic(() => {
    const { child, parent, record } = pending(k, target.childQuestId, target.version);
    if (parent.keeperThreadId !== threadId || input.boardQuestId !== parent.id) throw new Error("Only the current hiring Keeper can decide this plan from the parent quest.");
    if (record.lane !== "keeper" || record.request.changes.length) throw new Error("This lead plan already needs the user's answer.");
    if (input.source !== "keeper" || !input.reversible || input.askId || input.kind || input.exceeds)
      throw new Error("A lead plan needs its own reversible Keeper decision.");
    if (input.unsure === true || readUndoLanes(k.store, threadId).some(lane => lane.kind === "lead-plan")) {
      const routed: LeadPlanRecord = { ...record, lane: "user", request: { ...record.request, why: input.unsure ? "The hiring Keeper asks you to decide." : "You took these decisions back after undoing earlier lead-plan calls." } };
      k.store.put("leadPlans", planId(child.id, target.version), routed);
      return askForLeadPlan(k, child, routed);
    }
    if (input.coveredBy?.kind !== "plan" || input.coveredBy.waypointId !== record.request.parentWaypointId || new Set(input.options).size < 2)
      throw new Error("Cite the exact approved parent waypoint, and list both real options before deciding.");
    const decision = k.decide(threadId, input, undefined, { leadPlan: target });
    settle(k, child, record, { kind: "decision", id: decision.id }, target.action === "approve", { kind: "agent", threadId });
    k.store.event(k.now(), child.keeperThreadId, child.id, "lead.plan-decision", decision.why, { decisionId: decision.id, version: target.version, action: target.action }, { kind: "agent", threadId });
    return decision;
  });
  k.changed(k.quest(target.childQuestId).keeperThreadId, target.childQuestId);
  return result;
}

export function answerLeadPlan(k: Keeper, request: LeadPlanReview, askId: string, optionId: string) {
  const { record, child, path } = pending(k, request.childQuestId, request.version);
  const ask = k.store.get("asks", askId);
  if (record.lane !== "user" || !isDeepStrictEqual(record.request, request) || ask?.boardQuestId !== child.id || ask.keeperThreadId !== child.keeperThreadId)
    throw new Error("This answer does not match the exact lead plan and amendment.");
  if (optionId === "approve") for (const change of request.changes) {
    const link = path.find(item => item.id === change.linkId)!;
    const { members, rangers, depth, check, acts } = change.requested;
    k.store.put("leadLinks", link.id, { ...link, envelope: { members, rangers, depth }, amendedRequirements: { check, acts }, amendedBy: askId });
    k.store.event(k.now(), link.parentKeeperThreadId, link.parentQuestId, "lead.envelope-amended", "You approved new limits for the lead.", { ...change, askId }, { kind: "user" });
  }
  settle(k, child, record, { kind: "ask-answer", id: askId }, optionId === "approve", { kind: "user" });
}

export function undoLeadPlan(k: Keeper, decision: Decision) {
  const target = decision.leadPlan;
  if (!target) return false;
  const id = planId(target.childQuestId, target.version);
  const child = k.quest(target.childQuestId), record = k.store.get("leadPlans", id);
  if (record?.receipt?.kind !== "decision" || record.receipt.id !== decision.id) return false;
  if (["held", "closing", "done", "stopping", "stopped"].includes(child.phase)) throw new Error("Resume the child quest before undoing its lead plan.");
  if (child.planVersion !== target.version) return false;
  const routed: LeadPlanRecord = { ...record, lane: "user", state: "pending", receipt: null, request: { ...record.request, why: "You undid the hiring Keeper’s decision. Review this exact plan before staffing continues." } };
  k.store.put("leadPlans", id, routed);
  if (record.state === "approved") transitionQuest(k.store, child, "greenlight", "undo", { kind: "user" }, { kind: "undo", id: decision.id }, k.now(), {
    patch: { greenlitVersion: null, checkPlanVersion: undefined }, text: "You undid the lead plan’s approval. New staffing waits for your answer.",
  });
  askForLeadPlan(k, child, routed);
  k.changed(child.keeperThreadId, child.id);
  return true;
}
