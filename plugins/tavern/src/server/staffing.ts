import { memberDetails } from "./member-engagement";
import type { BoardQuest } from "../shared/schema";

import type { Keeper } from "./keeper/service";
import type { Staffing, StaffingReservation } from "./keeper/store";

import { isLiveMember } from "./liveness";

function occupied(k: Keeper, threadOrToken: string | null): boolean {
  if (!threadOrToken) return false;
  const member = k.member(threadOrToken);
  if (member) return isLiveMember(k.store, member, "occupy");
  const reservation = k.store.get("hires", threadOrToken);
  if (!reservation || reservation.cancelledAt != null) return false;
  if (!reservation.memberThreadId) return true;
  const child = k.member(reservation.memberThreadId);
  return child !== null && occupied(k, child.threadId);
}

export function reserveStaffing(
  k: Keeper,
  quest: BoardQuest,
  classId: string,
  capacity: number,
  token: string,
  replacesThreadId?: string,
): StaffingReservation {
  const id = `${quest.id}:${quest.planVersion}:${classId}`;
  let allocation = k.store.get("staffing", id);
  if (!allocation) {
    const existing = k.store
      .query("members", "boardQuestId", quest.id, 500)
      .filter((member) => member.classId === classId)
      .sort(
        (a, b) =>
          Number(!occupied(k, a.threadId)) - Number(!occupied(k, b.threadId)) ||
          b.createdAt - a.createdAt,
      );
    allocation = {
      boardQuestId: quest.id,
      version: quest.planVersion,
      classId,
      slots: Array.from({ length: capacity }, (_, index) => ({
        memberThreadId: existing[index]?.threadId ?? null,
        uses: existing[index] ? 1 : 0,
      })),
    };
  }
  const slots = [...allocation.slots];
  while (slots.length < capacity)
    slots.push({ memberThreadId: null, uses: 0 });
  const replacements = k.settings(quest.id).keepers.replacementsPerSlot;
  const originalSlot = replacesThreadId ? slots.findIndex(slot => slot.memberThreadId === replacesThreadId) : -1;
  const slot = slots.slice(0, capacity).findIndex((candidate, index) =>
    (originalSlot < 0 || index === originalSlot) && candidate.uses < 1 + replacements && !occupied(k, candidate.memberThreadId));
  if (
    slot < 0 &&
    slots
      .slice(0, capacity)
      .some(
        (candidate) =>
          candidate.memberThreadId &&
          memberDetails(k.store, candidate.memberThreadId).delivery &&
          occupied(k, candidate.memberThreadId),
      )
  )
    throw new Error(
      `An initial ${classId} brief is still pending for this party slot. Retry or release that member before hiring a replacement.`,
    );
  if (slot < 0)
    throw new Error(
      `Only ${replacements === 2 ? "two" : replacements} ${replacements === 1 ? "replacement is" : "replacements are"} allowed per party slot per plan version. Re-plan before another ${classId} attempt.`,
    );
  const previous = slots[slot]!;
  const reservation = { id, slot, replacement: previous.uses, previous };
  slots[slot] = { memberThreadId: token, uses: previous.uses + 1 };
  k.store.put("staffing", id, { ...allocation, slots });
  return reservation;
}

export function settleStaffing(
  k: Keeper,
  reservation: StaffingReservation | undefined,
  token: string,
  memberThreadId: string | null,
) {
  if (!reservation) return;
  const allocation = k.store.get("staffing", reservation.id);
  if (
    !allocation ||
    allocation.slots[reservation.slot]?.memberThreadId !== token
  )
    return;
  const slots = [...allocation.slots];
  slots[reservation.slot] = memberThreadId
    ? { ...slots[reservation.slot]!, memberThreadId }
    : reservation.previous;
  k.store.atomic(() => {
    k.store.put("staffing", reservation.id, { ...allocation, slots } satisfies Staffing);
    if (memberThreadId && reservation.replacement) {
      const quest = k.quest(allocation.boardQuestId);
      k.decide(quest.keeperThreadId, {
        boardQuestId: quest.id,
        text: `Start replacement ${reservation.replacement} of 2 for ${allocation.classId} party slot ${reservation.slot + 1} in plan v${allocation.version}`,
        why: "The previous member is no longer active. This reuses an approved class allocation without expanding the party.",
        reversible: true,
        source: "keeper",
      });
    }
  });
}
