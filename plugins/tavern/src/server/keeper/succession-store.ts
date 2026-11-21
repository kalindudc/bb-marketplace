import { isKeeperIdentity } from "../liveness";
import type { Actor } from "../../shared/schema";
import type { KeeperStore } from "./store";

export type SuccessionMember = { threadId: string; notifications: "auto" | "off" | "stuck" };
export type SuccessionSpawnIntent = { projectId: string; environmentId: string; providerId: string; at: number; recoverUntil?: number };
export type KeeperSuccession = {
  id: string;
  chargeId: string;
  generation: number;
  predecessor: string;
  candidate: string | null;
  state: "proposed" | "preparing" | "recovering" | "done" | "failed";
  requestedAt: number;
  cutoverAt: number | null;
  actor: Actor;
  reason: string;
  problem: string | null;
  spawnIntent?: SuccessionSpawnIntent;
  restored?: boolean;
  resumedFromBackup?: boolean;
  lateScanUntil?: number;
  candidateArchived?: boolean;
  followups: { members: (SuccessionMember & { done: boolean })[]; visible: boolean; bootstrap: boolean };
};
export type KeeperCharge = { current: string; generation: number; operationId: string };
export type SuccessionThread = { chargeId: string; operationId: string; candidate: boolean };
export type Cutover = { chargeId: string; expectedGeneration: number; predecessor: string; successor: string; at: number };
export type RebindStep = (cutover: Cutover) => void;
export type KeeperFence = { kind: "preparing" | "candidate" | "restored" } | { kind: "retired"; current: string };

export function fenceMessage(fence: KeeperFence): string {
  if (fence.kind === "retired") return `This Keeper is retired in Tavern. Continue in ${fence.current}.`;
  if (fence.kind === "restored") return "Choose Finish handover on the Keeper card to verify this restored Keeper in bb.";
  if (fence.kind === "candidate") return "This Keeper is staged for succession and does not own the charge yet.";
  return "Keeper succession is preparing. The predecessor still owns the charge, but no new turn or tool call can start.";
}

const pending = (op: KeeperSuccession) => !["done", "failed"].includes(op.state);
export const followedUp = (op: KeeperSuccession) => op.followups.visible && op.followups.bootstrap && op.followups.members.every(m => m.done);

export function portableSuccession(op: KeeperSuccession): KeeperSuccession {
  const { spawnIntent: _intent, lateScanUntil: _lateScan, resumedFromBackup: _resumed, ...portable } = op;
  if (pending(op)) return { ...portable, state: "failed", restored: true, problem: "Keeper succession did not resume from a backup without proof of its host operations." };
  if (op.state === "done" && !followedUp(op)) return { ...portable, restored: true, problem: "Choose Finish handover on the Keeper card. Tavern will verify the successor in bb before it resumes the remaining steps." };
  return portable;
}

export class KeeperSuccessionStore {
  constructor(private readonly store: KeeperStore, private readonly now: () => number) {}

  get(id: string): KeeperSuccession {
    const op = this.store.get("keeperSuccessions", id);
    if (!op) throw new Error("Unknown Keeper succession");
    return op;
  }

  private charge(threadId: string) {
    const chargeId = this.store.get("successionThreads", threadId)?.chargeId ?? threadId;
    return { chargeId, head: this.store.get("keeperCharges", chargeId) };
  }

  current(threadId: string): string { return this.charge(threadId).head?.current ?? threadId; }

  operationFor(threadId: string): KeeperSuccession | null {
    const { head } = this.charge(threadId);
    if (!head) return null;
    if (head.current === threadId) return this.get(head.operationId);
    const row = this.store.db.prepare(`SELECT id FROM tavern_records WHERE kind='keeperSuccessions'
      AND json_extract(data,'$.predecessor')=? AND json_extract(data,'$.state')='done' ORDER BY rowid DESC LIMIT 1`).get(threadId) as { id: string } | undefined;
    return row ? this.get(row.id) : null;
  }

  work(): string[] {
    const rows = this.store.db.prepare(`SELECT id FROM tavern_records WHERE kind='keeperSuccessions'
      AND coalesce(json_extract(data,'$.restored'),0)=0 AND (
        json_extract(data,'$.state') IN ('proposed','preparing','recovering') OR
        (json_extract(data,'$.state')='done' AND json_extract(data,'$.followups.bootstrap')=0) OR
        (json_extract(data,'$.state')='failed' AND (json_extract(data,'$.candidate') IS NOT NULL OR json_extract(data,'$.lateScanUntil')>?)
          AND json_extract(data,'$.spawnIntent') IS NOT NULL AND coalesce(json_extract(data,'$.candidateArchived'),0)=0))`).all(this.now()) as { id: string }[];
    return rows.map(row => row.id);
  }

  fence(threadId: string): KeeperFence | null {
    const link = this.store.get("successionThreads", threadId);
    if (!link) return null;
    const { head } = this.charge(threadId);
    if (!head) throw new Error("Keeper charge is missing its current owner");
    if (link.candidate && this.get(link.operationId).state !== "done") return { kind: "candidate" };
    if (head.current !== threadId) return { kind: "retired", current: head.current };
    const op = this.get(head.operationId);
    if (op.state === "done" && op.restored && !followedUp(op)) return { kind: "restored" };
    return op.state === "preparing" || op.state === "recovering" ? { kind: "preparing" } : null;
  }

  assertMutable(threadId: string) {
    const fence = this.fence(threadId);
    if (fence) throw new Error(fenceMessage(fence));
  }

  propose(threadId: string, actor: Actor, reason: string): KeeperSuccession {
    if (!reason.trim()) throw new Error("Keeper succession requires a reason");
    return this.store.atomic(() => {
      const { chargeId, head } = this.charge(threadId);
      if ((head?.current ?? chargeId) !== threadId || !isKeeperIdentity(this.store, this.store.get("members", threadId))) throw new Error("Only the current Keeper can be refreshed");
      const previous = head && this.get(head.operationId);
      if (previous && pending(previous)) return previous;
      if (previous?.state === "done" && !followedUp(previous)) throw new Error("Keeper succession follow-ups must finish before refreshing again");
      const op: KeeperSuccession = {
        id: this.store.id("succession"), chargeId, generation: (head?.generation ?? 0) + 1, predecessor: threadId,
        candidate: null, state: "proposed", requestedAt: this.now(), cutoverAt: null, actor, reason, problem: null,
        followups: { members: [], visible: false, bootstrap: false },
      };
      this.store.put("keeperCharges", chargeId, { current: threadId, generation: op.generation - 1, operationId: op.id });
      if (!this.store.get("successionThreads", threadId)) this.store.put("successionThreads", threadId, { chargeId, operationId: op.id, candidate: false });
      return this.save(op, "Keeper succession was requested.", actor);
    });
  }

  prepare(id: string, members: SuccessionMember[], spawnIntent?: SuccessionSpawnIntent): KeeperSuccession {
    return this.store.atomic(() => {
      const op = this.get(id);
      this.assertBeforeCutover(op);
      if (op.state !== "proposed" || op.restored) throw new Error("Keeper succession was already prepared or restored from a backup");
      return this.save({ ...op, state: "preparing", ...(spawnIntent ? { spawnIntent } : {}), followups: { ...op.followups, members: this.followupMembers(members) } }, "The predecessor is settling before Keeper succession.");
    });
  }

  bindCandidate(id: string, candidate: string): KeeperSuccession {
    return this.store.atomic(() => {
      const op = this.get(id);
      this.assertBeforeCutover(op);
      if (!["preparing", "recovering"].includes(op.state)) throw new Error("Keeper succession is not preparing a candidate");
      if (op.candidate === candidate) return op.state === "preparing" ? op : this.save({ ...op, state: "preparing", problem: null }, "The staged successor was confirmed.", { kind: "tavern" }, "candidate-confirmed");
      const existing = this.store.get("successionThreads", candidate);
      if (op.candidate || existing || this.store.get("members", candidate)) throw new Error("A Keeper succession candidate can only be bound once");
      this.store.put("successionThreads", candidate, { chargeId: op.chargeId, operationId: id, candidate: true });
      return this.save({ ...op, state: "preparing", candidate, problem: null }, "The successor is staged and cannot run yet.", { kind: "tavern" }, "candidate-bound");
    });
  }

  recovering(id: string, problem: string): KeeperSuccession {
    return this.store.atomic(() => {
      const op = this.get(id);
      this.assertBeforeCutover(op);
      if (op.state !== "preparing" && op.state !== "recovering") throw new Error("Keeper succession is not preparing");
      if (op.state === "recovering" && op.problem === problem) return op;
      return this.save({ ...op, state: "recovering", problem }, "Keeper succession is checking an uncertain host result.");
    });
  }

  cutover(id: string, steps: readonly RebindStep[], members?: SuccessionMember[]): KeeperSuccession {
    return this.store.atomic(() => {
      const op = this.get(id);
      this.assertBeforeCutover(op);
      if (op.state !== "preparing" || !op.candidate || op.restored) throw new Error("Keeper succession needs a confirmed candidate");
      const at = this.now();
      this.rebindOwnership({ chargeId: op.chargeId, expectedGeneration: op.generation - 1, predecessor: op.predecessor, successor: op.candidate, at }, steps);
      if (!isKeeperIdentity(this.store, this.store.get("members", op.candidate))) throw new Error("A succession must bind the successor as Keeper before cutover");
      this.store.put("keeperCharges", op.chargeId, { current: op.candidate, generation: op.generation, operationId: id });
      const followups = members ? { ...op.followups, members: this.followupMembers(members) } : op.followups;
      return this.save({ ...op, state: "done", cutoverAt: at, followups }, "The successor now owns the Keeper charge. Wake-ups set by other plugins on the old Keeper do not move.");
    });
  }

  fail(id: string, problem: string, options: { lateScanUntil?: number; actor?: Actor } = {}): KeeperSuccession {
    return this.store.atomic(() => {
      const op = this.get(id);
      this.assertBeforeCutover(op);
      return this.save({ ...op, state: "failed", problem, ...(options.lateScanUntil === undefined ? {} : { lateScanUntil: options.lateScanUntil }) },
        "Keeper succession did not cut over. The predecessor remains in charge.", options.actor);
    });
  }

  rememberUnused(id: string, candidate: string): KeeperSuccession {
    return this.store.atomic(() => {
      const op = this.get(id);
      if (op.state !== "failed" || !op.spawnIntent || op.restored) throw new Error("This operation cannot claim an unused successor.");
      if (op.candidate === candidate) return op;
      if (op.candidate || this.store.get("successionThreads", candidate) || this.store.get("members", candidate)) throw new Error("This unused successor cannot be confirmed.");
      this.store.put("successionThreads", candidate, { chargeId: op.chargeId, operationId: id, candidate: true });
      return this.save({ ...op, candidate }, "Tavern confirmed a late, unused successor.", { kind: "tavern" }, "candidate-found-after-failure");
    });
  }

  finishRestored(id: string, threadId: string): KeeperSuccession {
    return this.store.atomic(() => {
      const op = this.get(id);
      if (op.state !== "done" || !op.restored || op.candidate !== threadId || this.operationFor(threadId)?.id !== id || this.current(threadId) !== threadId)
        throw new Error("Only the current restored Keeper has a handover to finish.");
      return this.save({ ...op, restored: false, resumedFromBackup: true, problem: null, followups: { ...op.followups, visible: false, bootstrap: false } }, "You asked Tavern to finish the verified handover.", { kind: "user" }, "restore-verified");
    });
  }

  complete(id: string, step: string): KeeperSuccession {
    return this.store.atomic(() => {
      const op = this.get(id);
      if (op.state !== "done" || op.restored) throw new Error("Keeper succession follow-ups require a committed transfer with verified host state");
      const followups = { ...op.followups };
      if (step === "visible" || step === "bootstrap") {
        if (followups[step]) return op;
        followups[step] = true;
      } else {
        const member = followups.members.find(m => m.threadId === step);
        if (!member) throw new Error("Unknown Keeper succession follow-up");
        if (member.done) return op;
        followups.members = followups.members.map(m => m.threadId === step ? { ...m, done: true } : m);
      }
      const next = { ...op, followups };
      return this.save({ ...next, problem: followedUp(next) ? null : next.problem }, "A Keeper succession follow-up finished.", { kind: "tavern" }, "followed-up", { step });
    });
  }

  followupProblem(id: string, problem: string): KeeperSuccession {
    return this.store.atomic(() => {
      const op = this.get(id);
      if (op.state !== "done" || op.restored || op.problem === problem) return op;
      return this.save({ ...op, problem }, "A Keeper succession follow-up is still waiting.", { kind: "tavern" }, "followup-waiting");
    });
  }

  archiveCandidate(id: string): KeeperSuccession {
    return this.store.atomic(() => {
      const op = this.get(id);
      if (op.state !== "failed" || !op.candidate || op.restored) throw new Error("Only a confirmed unused successor can be archived.");
      if (op.candidateArchived) return op;
      return this.save({ ...op, candidateArchived: true }, "The unused successor was archived.", { kind: "tavern" }, "candidate-archived");
    });
  }

  private rebindOwnership(transition: Cutover, steps: readonly RebindStep[]) {
    for (const step of steps) if ((step(transition) as unknown) instanceof Promise) throw new Error("Keeper ownership changes must commit synchronously");
  }

  private followupMembers(members: readonly SuccessionMember[]) {
    if (new Set(members.map(m => m.threadId)).size !== members.length) throw new Error("Keeper succession cannot re-parent a member twice");
    return members.map(m => ({ ...m, done: false }));
  }

  private assertBeforeCutover(op: KeeperSuccession) {
    if (op.state === "done") throw new Error("Keeper succession already committed");
    const head = this.store.get("keeperCharges", op.chargeId);
    if (!pending(op) || head?.operationId !== op.id || head.current !== op.predecessor || head.generation !== op.generation - 1) throw new Error("Keeper succession generation changed");
  }

  private save(op: KeeperSuccession, text: string, actor: Actor = { kind: "tavern" }, event = op.state as string, data: Record<string, unknown> = {}) {
    this.store.put("keeperSuccessions", op.id, op);
    this.store.event(this.now(), op.state === "done" ? op.candidate : op.predecessor, null, `keeper-succession.${event}`, text,
      { successionId: op.id, chargeId: op.chargeId, generation: op.generation, predecessor: op.predecessor, successor: op.candidate, ...(op.problem ? { problem: op.problem } : {}), ...data }, actor);
    return op;
  }
}
