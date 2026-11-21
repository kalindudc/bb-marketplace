import type { PullRequest } from "../../shared/pull-request";
import type { Actor, LeadLink, Member } from "../../shared/schema";
import { isLiveKeeper } from "../liveness";
import { memberHost, outstandingArchivedPlacement } from "../member-engagement";
import { PlacementStore } from "../placement/store";
import { currentLead, holdsLeadSeat, leadAncestors } from "./leads";
import type { Keeper } from "./service";

function change(k: Keeper, link: LeadLink, event: string, text: string, actor: Actor) {
  k.store.put("leadLinks", link.id, link);
  const data = { leadLinkId: link.id, generation: link.generation, childQuestId: link.childQuestId,
    memberThreadId: link.childKeeperThreadId, retirement: link.retirement, forcedStop: link.forcedStop };
  k.store.event(k.now(), link.parentKeeperThreadId, link.parentQuestId, event, text, data, actor);
  k.changed(link.parentKeeperThreadId, link.parentQuestId);
  if (link.childKeeperThreadId) k.changed(link.childKeeperThreadId, link.childQuestId);
  return link;
}

export function requestLeadRetirement(k: Keeper, threadId: string, member: Member, reason: string) {
  return k.store.atomic(() => {
    k.require(threadId, "keeper");
    const link = currentLead(k.store, member);
    if (!link || !isLiveKeeper(k.store, k.member(threadId), "present") || link.parentKeeperThreadId !== threadId || k.quest(link.parentQuestId).keeperThreadId !== threadId)
      throw new Error("Only the current hiring Keeper may request this lead's retirement.");
    const parent = k.quest(link.parentQuestId);
    if (!["done", "stopped"].includes(parent.phase)) { k.assertQuestNotHeld(parent.id); k.guard(threadId, parent.id); }
    if (link.state === "retirement-requested" || link.state === "retired") return link;
    if (link.state !== "linked") throw new Error("This lead seat is not available for planned retirement.");
    if (link.childQuestId && !["done", "stopped"].includes(k.quest(link.childQuestId).phase))
      throw new Error("Finish or stop the child quest before requesting retirement.");
    const updated = change(k, { ...link, state: "retirement-requested", retirement: { requestedBy: threadId, reason } },
      "lead.retirement-requested", `Requested ${k.name(member)}'s retirement: ${reason}`, { kind: "agent", threadId });
    k.store.event(k.now(), member.threadId, link.childQuestId, "lead.retirement-requested",
      "Your hiring Keeper requested retirement. When your party is released and your pull requests have owners, call tavern_release with confirmRetirement: true and end your turn.",
      { leadLinkId: link.id }, { kind: "agent", threadId });
    return updated;
  });
}

function canOwnPullRequest(k: Keeper, owner: string) {
  if (owner === "user") return true;
  const member = k.member(owner);
  if (!member || currentLead(k.store, member)?.state === "retiring" || ["releasing", "released", "stopping", "stopped", "archiving", "archived"].includes(member.engagement ?? "")) return false;
  const host = memberHost(k.store, member);
  return host.archivedAt === null && host.deletedAt === null;
}

function leadPullRequests(k: Keeper, link: LeadLink) {
  const prs = new Map((link.childQuestId ? k.store.openPullRequests(link.childQuestId) : []).map(pr => [pr.id, pr]));
  if (link.childKeeperThreadId) {
    for (const pr of k.store.query("pullRequests", "owner", link.childKeeperThreadId, 500))
      if (pr.state === "draft" || pr.state === "ready") prs.set(pr.id, pr);
  }
  return [...prs.values()].filter(pr => pr.owner === link.childKeeperThreadId || !canOwnPullRequest(k, pr.owner));
}

export function assertLeadRetirementReady(k: Keeper, link: LeadLink) {
  const childId = link.childQuestId;
  if (childId && (!["done", "stopped"].includes(k.quest(childId).phase) || k.pendingQuestHires(childId) || k.store.leadLinksBy("parentQuestId", childId).some(holdsLeadSeat)))
    throw new Error("The child quest or its party cleanup is still open.");
  const placements = new PlacementStore(k.store.db);
  if (link.childKeeperThreadId && k.store.query("members", "keeperThreadId", link.childKeeperThreadId, 500).some(member =>
    !["released", "stopped", "archived"].includes(member.engagement ?? "") || outstandingArchivedPlacement(placements, member)))
    throw new Error("Release the lead's whole party before retiring.");
}

function transferLeadPullRequest(k: Keeper, pr: PullRequest, destination: LeadLink | undefined, actor: Actor, reason: string, receipt: string) {
  if (!destination) return k.store.changePullRequest({ ...pr, owner: "user" }, k.now(), undefined, { actor, action: "transfer", reason, receipt });
  const { verdict: _verdict, readyDecisionId: _decision, ...open } = pr;
  const owner = destination.parentKeeperThreadId;
  k.store.changePullRequest({ ...open, owner, keeperThreadId: owner, boardQuestId: destination.parentQuestId, verifiedCommit: null },
    k.now(), undefined, { actor, action: "transfer", reason, receipt });
  k.store.event(k.now(), pr.keeperThreadId, pr.boardQuestId, "pull-request.transferred", reason,
    { pullRequestId: pr.id, url: pr.url, toQuestId: destination.parentQuestId, owner, receipt }, actor);
}

export function confirmLeadRetirement(k: Keeper, threadId: string) {
  return k.store.atomic(() => {
    const member = k.member(threadId), link = member && currentLead(k.store, member);
    if (!link || !member || memberHost(k.store, member).archivedAt !== null || memberHost(k.store, member).deletedAt !== null)
      throw new Error("Only the present lead can confirm its retirement.");
    if (link.state === "retiring" && !link.forcedStop && link.retirement?.confirmedBy === threadId) return link;
    if (link.state !== "retirement-requested" || !link.retirement) throw new Error("This lead has no planned retirement to confirm.");
    const parent = k.quest(link.parentQuestId);
    if (parent.phase === "stopping" || parent.keeperThreadId !== link.parentKeeperThreadId)
      throw new Error("The parent stop or Keeper changed before the lead could confirm retirement.");
    assertLeadRetirementReady(k, link);
    const prs = leadPullRequests(k, link);
    if (prs.some(pr => pr.owner !== threadId) || prs.length && !canOwnPullRequest(k, link.parentKeeperThreadId))
      throw new Error("Every open pull request needs a recorded owner who will remain after the lead retires.");
    const actor = { kind: "agent", threadId } as const;
    for (const pr of prs) transferLeadPullRequest(k, pr, link, actor, "The retiring lead handed ownership to its hiring Keeper.", link.id);
    return change(k, { ...link, state: "retiring", retirement: { ...link.retirement, confirmedBy: threadId } },
      "lead.retirement-confirmed", `${k.name(member)} confirmed its retirement.`, actor);
  });
}

export function requestForcedLeadStop(k: Keeper, link: LeadLink, receipt: string, reason: string) {
  if (!holdsLeadSeat(link) || !link.childKeeperThreadId || link.forcedStop) return link;
  return change(k, { ...link, state: "retiring", forcedStop: { receipt, reason }, cleanupError: undefined },
    "lead.stop-requested", `Lead stop requested: ${reason}`, { kind: "tavern" });
}

export function recordForcedLeadPullRequestOwners(k: Keeper, link: LeadLink) {
  const destination = [link, ...leadAncestors(k.store, link.parentQuestId)].find(seat =>
    k.quest(seat.parentQuestId).keeperThreadId === seat.parentKeeperThreadId && canOwnPullRequest(k, seat.parentKeeperThreadId));
  for (const pr of leadPullRequests(k, link)) transferLeadPullRequest(k, pr, destination, { kind: "tavern" },
    "The prior owner is no longer available after Stop.", link.forcedStop!.receipt);
}

export function finishLeadRetirement(k: Keeper, link: LeadLink) {
  const forced = !!link.forcedStop;
  change(k, { ...link, state: forced ? "stopped" : "retired", cleanupError: undefined },
    forced ? "lead.stopped" : "lead.retired", forced ? "Lead stop confirmed." : "Lead retirement confirmed and the seat is free.", { kind: "tavern" });
}
