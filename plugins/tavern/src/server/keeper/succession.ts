import type { BbPluginApi, MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import type { Actor } from "../../shared/schema";
import { wasReleased } from "../../shared/member-engagement";
import { tags } from "../../shared/contract";
import { commitUserAct, type UserActReceipt } from "../authority";
import { classExecutionFacts } from "../class-execution";
import { inputText, isUser } from "../dispatch";
import { isNotFound } from "../host-errors";
import { loopCall } from "../loop-call";
import type { TavernRuntime } from "../runtime";
import { fenceMessage, followedUp, type KeeperSuccession, type SuccessionMember } from "./succession-store";
import { ownershipSteps } from "./succession-ownership";
import { currentLead } from "./leads";

export const SUCCESSION_METADATA = "keeperSuccession";
const bootstrap = (id: string) => `[Tavern handover ${id}]\nResume this charge from the Tavern ledger and journal. Review the open quests and outstanding commitments. This is not a new user request.`;
type Threads = BbPluginApi["sdk"]["threads"];
type Thread = Awaited<ReturnType<Threads["get"]>>;
type Creation = Pick<Thread, "id" | "projectId" | "providerId" | "createdAt" | "originPluginId" | "originKind" | "visibility" | "status" | "parentThreadId" | "lifecycleOwnerThreadId" | "sourceThreadId" | "environmentId" | "archivedAt" | "deletedAt">;
const explain = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 400);

export class KeeperSuccessionCoordinator {
  private readonly flights = new Map<string, Promise<KeeperSuccession>>();
  private readonly advances = new Map<string, Promise<KeeperSuccession>>();
  private readonly admitted = new Map<string, number>();
  constructor(private readonly runtime: TavernRuntime) {}
  get state() { return this.runtime.keeper.succession; }
  private get k() { return this.runtime.keeper; }


  request(threadId: string, actor: Actor, reason: string) {
    this.runtime.stopAll.assertRunning();
    if (actor.kind !== "user" && (actor.kind !== "agent" || actor.threadId !== threadId)) throw new Error("Only you or the current Keeper can request a refresh.");
    const op = this.state.propose(threadId, actor, reason);
    this.signal(op);
    return op;
  }

  cancel(threadId: string, id: string) {
    const op = this.state.get(id);
    if (op.predecessor !== threadId || this.state.operationFor(threadId)?.id !== id || !["proposed", "recovering"].includes(op.state))
      throw new Error("This Keeper no longer has a refresh you can cancel.");
    this.abandon(op, "You cancelled the refresh. The original Keeper remains in charge.", { kind: "user" });
  }

  async finishHandover(threadId: string, id: string, receipt?: UserActReceipt) {
    this.runtime.stopAll.assertRunning();
    const op = this.state.get(id);
    if (!op.restored || op.state !== "done" || op.candidate !== threadId || this.state.current(threadId) !== threadId)
      throw new Error("Only the current restored Keeper has a handover to finish.");
    const thread = await loopCall(this.runtime.bb.sdk.threads.get({ threadId }), "restored successor identity");
    const member = this.k.member(threadId);
    const hiringKeeper = member && currentLead(this.k.store, member)?.parentKeeperThreadId;
    if (thread.id !== threadId || !member || thread.projectId !== this.k.store.runtime(threadId).projectId ||
        thread.archivedAt !== null || thread.deletedAt !== null || thread.createdAt < op.requestedAt ||
        thread.originPluginId !== this.runtime.bb.pluginId || thread.originKind === "fork" || thread.sourceThreadId !== null ||
        (thread.parentThreadId !== null && thread.parentThreadId !== hiringKeeper) || thread.lifecycleOwnerThreadId !== null || (await this.metadata(threadId))[SUCCESSION_METADATA] !== id)
      throw new Error("bb could not verify the original successor for this backup. Tavern did not change any threads.");
    this.runtime.stopAll.assertRunning();
    this.signal(commitUserAct(this.k.store, () => this.k.now(), receipt, () => this.state.finishRestored(id, threadId)));
    await this.advance(id);
  }

  private get recoveryMs() { return this.runtime.config().keepers.successionRecoverySeconds * 1000; }

  private abandon(op: KeeperSuccession, problem: string, actor: Actor = { kind: "tavern" }) {
    const failed = this.state.fail(op.id, problem, { actor, ...(op.spawnIntent ? { lateScanUntil: this.k.now() + this.recoveryMs } : {}) });
    this.signal(failed);
    void this.runtime.recheckDispatch();
    return failed;
  }

  signal(op: KeeperSuccession) {
    this.runtime.bb.rpc.experimental_invalidate([tags.room(), tags.rows(), tags.thread(op.predecessor), ...(op.candidate ? [tags.thread(op.candidate)] : [])]);
  }

  track(threadId: string) {
    this.admitted.set(threadId, (this.admitted.get(threadId) ?? 0) + 1);
    return () => {
      const count = this.admitted.get(threadId)!;
      if (count === 1) this.admitted.delete(threadId);
      else this.admitted.set(threadId, count - 1);
    };
  }

  prepare(id: string): Promise<KeeperSuccession> {
    const active = this.flights.get(id);
    if (active) return active;
    const flight = this.prepareOnce(id).then(op => { this.signal(op); return op; }).finally(() => this.flights.delete(id));
    this.flights.set(id, flight);
    return flight;
  }

  advance(id: string): Promise<KeeperSuccession> {
    const active = this.advances.get(id);
    if (active) return active;
    const flight = this.cutover(id).finally(() => this.advances.delete(id));
    this.advances.set(id, flight);
    return flight;
  }

  async sweep() {
    for (const id of this.state.work()) {
      if (this.runtime.stopAll.reason()) return;
      try { await this.advance(id); }
      catch (error) { this.runtime.bb.log.warn(`Keeper succession ${id}: ${explain(error)}`); }
    }
  }

  view(threadId: string) {
    const op = this.state.operationFor(threadId);
    return op ? { id: op.id, predecessor: op.predecessor, successor: op.state === "done" ? op.candidate : null,
      current: this.state.current(threadId), state: op.state, requestedAt: op.requestedAt, cutoverAt: op.cutoverAt,
      reason: op.reason, problem: op.problem, followupsPending: op.state === "done" && !followedUp(op),
      finishRequired: op.state === "done" && op.restored === true && !followedUp(op), requestedByKeeper: op.actor.kind === "agent" } : null;
  }

  private async cutover(id: string): Promise<KeeperSuccession> {
    const op = await this.prepare(id);
    if (op.restored || this.runtime.stopAll.reason()) return op;
    if (op.state === "done") return this.followUp(op);
    if (op.state === "failed") return this.archiveUnused(op);
    if (op.state !== "preparing" || !op.candidate) return op;
    const members: SuccessionMember[] = [];
    let next: KeeperSuccession;
    try {
      const party = this.k.store.query("members", "keeperThreadId", op.predecessor, -1).filter(member => !wasReleased(member));
      for (const member of party) {
        const rt = this.k.store.runtime(member.threadId);
        if (rt.archivedAt != null || rt.deletedAt != null) continue;
        const thread = await loopCall(this.runtime.bb.sdk.threads.get({ threadId: member.threadId }), "Keeper succession member inventory");
        if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
        if (thread.id !== member.threadId || thread.parentThreadId !== op.predecessor || !["auto", "off", "stuck"].includes(thread.parentNotifications))
          throw new Error(`The parent or notifications for ${member.threadId} could not be confirmed.`);
        members.push({ threadId: thread.id, notifications: thread.parentNotifications });
      }
      const predecessor = await loopCall(this.runtime.bb.sdk.threads.get({ threadId: op.predecessor }), "Keeper succession cutover check");
      const intent = op.spawnIntent!;
      if (predecessor.id !== op.predecessor || predecessor.environmentId !== intent.environmentId || predecessor.projectId !== intent.projectId || !(await this.quiet(predecessor, true))) throw new Error("The predecessor or its party has work that has not settled. Let it settle before refreshing.");
      await this.runtime.checkSuccessionTick(op.predecessor);
      if (this.runtime.stopAll.reason() || this.admitted.has(op.predecessor)) return op;
      next = this.state.cutover(id, ownershipSteps(this.k), members);
    } catch (error) {
      next = this.state.fail(id, explain(error));
      void this.runtime.recheckDispatch();
    }
    this.signal(next);
    return next.state === "done" ? this.followUp(next) : this.archiveUnused(next);
  }

  private async followUp(op: KeeperSuccession) {
    if (followedUp(op)) return op;
    const successor = op.candidate!;
    const current = () => this.state.current(op.predecessor) === successor && !this.runtime.stopAll.reason() && !this.state.get(op.id).restored;
    try {
      for (const member of op.followups.members) {
        if (member.done || !current()) continue;
        const assignment = this.k.member(member.threadId);
        if (assignment && wasReleased(assignment)) { this.state.complete(op.id, member.threadId); continue; }
        if (assignment?.keeperThreadId !== successor) throw new Error("A party assignment changed before re-parenting it.");
        const threadId = member.threadId;
        const moved = (thread: Thread) => thread.parentThreadId === successor && thread.parentNotifications === member.notifications;
        const before = await loopCall(this.runtime.bb.sdk.threads.get({ threadId }), "Keeper succession parent read");
        if (!current()) return this.state.get(op.id);
        if (before.archivedAt === null && before.deletedAt === null && !moved(before)) {
          if (before.parentThreadId !== op.predecessor || before.parentNotifications !== member.notifications)
            throw new Error(`The parent or notification setting for ${threadId} changed after cutover.`);
          await loopCall(this.runtime.bb.sdk.threads.update({ threadId, parentThreadId: successor, parentNotifications: member.notifications }), "Keeper succession re-parent");
          const after = await loopCall(this.runtime.bb.sdk.threads.get({ threadId }), "Keeper succession parent confirmation");
          if (!moved(after)) throw new Error(`bb has not confirmed the new parent for ${threadId}.`);
        }
        this.signal(this.state.complete(op.id, threadId));
      }
      if (!current()) return this.state.get(op.id);
      if (!this.state.get(op.id).followups.visible) {
        let thread = await loopCall(this.runtime.bb.sdk.threads.get({ threadId: successor }), "Keeper succession visibility read");
        if (!current()) return this.state.get(op.id);
        if (thread.archivedAt !== null || thread.deletedAt !== null) throw new Error("The successor is archived or deleted.");
        const member = this.k.member(successor);
        const hiringKeeper = member && currentLead(this.k.store, member)?.parentKeeperThreadId;
        if (hiringKeeper && thread.parentThreadId !== hiringKeeper) {
          if (thread.parentThreadId !== null) throw new Error("The lead successor has an unexpected parent in bb.");
          const before = await loopCall(this.runtime.bb.sdk.threads.get({ threadId: op.predecessor }), "Lead succession notification preference");
          if (!current()) return this.state.get(op.id);
          if (!before.parentThreadId || this.state.current(before.parentThreadId) !== hiringKeeper || !["auto", "off", "stuck"].includes(before.parentNotifications))
            throw new Error("The hiring Keeper or the predecessor's notification preference could not be confirmed.");
          await loopCall(this.runtime.bb.sdk.threads.update({ threadId: successor, parentThreadId: hiringKeeper, parentNotifications: before.parentNotifications }), "Lead succession attach");
          thread = await loopCall(this.runtime.bb.sdk.threads.get({ threadId: successor }), "Lead succession parent confirmation");
          if (thread.parentThreadId !== hiringKeeper || thread.parentNotifications !== before.parentNotifications)
            throw new Error("bb did not confirm the lead successor's parent and notification preference.");
          if (!current()) return this.state.get(op.id);
        }
        if (thread.visibility !== "visible") {
          await loopCall(this.runtime.bb.sdk.threads.update({ threadId: successor, visibility: "visible" }), "Keeper succession unhide");
          const confirmed = await loopCall(this.runtime.bb.sdk.threads.get({ threadId: successor }), "Keeper succession visibility confirmation");
          if (confirmed.visibility !== "visible") throw new Error("bb has not confirmed successor visibility.");
        }
        this.signal(this.state.complete(op.id, "visible"));
      }
      if (current() && !this.state.get(op.id).followups.bootstrap) {
        const events = await loopCall(this.runtime.bb.sdk.threads.events.list({ threadId: successor, types: ["client/turn/requested"], limit: "100", order: "asc" }), "Keeper succession bootstrap receipt");
        if (current() && events.some(event => event.type === "client/turn/requested" && event.data.originPluginId === this.runtime.bb.pluginId && JSON.stringify(event.data.input).includes(`[Tavern handover ${op.id}]`)))
          this.signal(this.state.complete(op.id, "bootstrap"));
        else if (current() && !this.state.get(op.id).followups.bootstrap) {
          if (op.resumedFromBackup) {
            const queue = await loopCall(this.runtime.bb.sdk.threads.queuedMessages.list({ threadId: successor }), "restored successor queue");
            if (!current()) return this.state.get(op.id);
            if (!queue.some(row => row.originPluginId === this.runtime.bb.pluginId && inputText(row.content) === bootstrap(op.id) && !row.failureReason)) {
              this.signal(this.state.complete(op.id, "bootstrap"));
              return this.state.get(op.id);
            }
          }
          await loopCall(this.runtime.bb.experimental_hooks.recheck("message.dispatch"), "Keeper succession dispatch recheck");
        }
      }
    } catch (error) {
      this.signal(this.state.followupProblem(op.id, explain(error)));
    }
    return this.state.get(op.id);
  }

  private async archiveUnused(op: KeeperSuccession) {
    if (!op.spawnIntent || op.candidateArchived || op.restored) return op;
    if (!op.candidate && op.lateScanUntil !== undefined && this.k.now() < op.lateScanUntil) {
      const found = await this.findCandidate(op);
      if (found) op = this.state.rememberUnused(op.id, found);
    }
    if (!op.candidate) return op;
    const threadId = op.candidate;
    const thread = await loopCall(this.runtime.bb.sdk.threads.get({ threadId }), "unused Keeper succession thread").catch(error => { if (isNotFound(error)) return null; throw error; });
    if (thread && thread.archivedAt === null && thread.deletedAt === null) {
      if (!(await this.attest(op, thread)) || this.runtime.stopAll.reason()) return op;
      const children = await loopCall(this.runtime.bb.sdk.threads.list({ parentThreadId: threadId, includeHidden: true, limit: 1 }), "unused Keeper succession children");
      if (children.length || this.runtime.stopAll.reason()) return op;
      const archive = await loopCall(this.runtime.bb.sdk.threads.archive({ threadId }), "archive unused Keeper successor");
      if (!archive.archivedThreadIds.includes(threadId)) throw new Error("bb did not confirm the unused successor was archived.");
    }
    const closed = this.state.archiveCandidate(op.id);
    this.signal(closed);
    return closed;
  }

  bootstrapDispatched(threadId: string, pluginId: string | null, text: string) {
    const link = this.k.store.get("successionThreads", threadId);
    if (!link?.candidate || pluginId !== this.runtime.bb.pluginId) return;
    const op = this.state.get(link.operationId);
    if (op.state === "done" && !op.restored && op.followups.visible && !op.followups.bootstrap && text === bootstrap(op.id))
      this.signal(this.state.complete(op.id, "bootstrap"));
  }

  private async prepareOnce(id: string): Promise<KeeperSuccession> {
    let op = this.state.get(id);
    if (this.runtime.stopAll.reason() || op.restored || op.state === "done" || op.state === "failed") return op;
    if (op.spawnIntent) return this.recover(op);
    if (op.state !== "proposed") throw new Error("Succession is preparing without a spawn intent.");

    const threadId = op.predecessor;
    const predecessor = await loopCall(this.runtime.bb.sdk.threads.get({ threadId }), "Keeper succession predecessor");
    const projectId = this.k.store.runtime(threadId).projectId;
    if (predecessor.id !== threadId || predecessor.projectId !== projectId || predecessor.archivedAt !== null || predecessor.deletedAt !== null || !predecessor.environmentId)
      return this.state.fail(id, "The predecessor's running project and environment could not be confirmed.");
    if (!(await this.quiet(predecessor))) return op;
    const environmentId = predecessor.environmentId;
    const facts = await loopCall(classExecutionFacts(this.runtime, { classId: "keeper", projectId, providerId: predecessor.providerId, environmentId, mode: "start" }), "Keeper succession execution");
    if (!facts.execution || facts.errors.length) return this.state.fail(id, `The Keeper class cannot start in this environment. ${facts.errors.join(" ")}`.trim());
    const execution = facts.execution;
    const confirmed = await loopCall(this.runtime.bb.sdk.threads.get({ threadId }), "Keeper succession quiescence");
    if (confirmed.environmentId !== environmentId || confirmed.projectId !== projectId || confirmed.providerId !== predecessor.providerId || !(await this.quiet(confirmed))) return op;
    if (this.runtime.stopAll.reason() || this.admitted.has(threadId) || this.state.get(id).state !== "proposed") return this.state.get(id);
    const at = this.k.now();
    op = this.state.prepare(id, [], { projectId, environmentId, providerId: execution.providerId, at, recoverUntil: at + this.recoveryMs });
    this.signal(op);
    try {
      const staged = await loopCall(this.runtime.bb.sdk.threads.spawn({
        projectId,
        origin: "plugin",
        originPluginId: this.runtime.bb.pluginId,
        visibility: "hidden",
        environment: { type: "reuse", environmentId },
        input: [{ type: "text", text: bootstrap(id), mentions: [], visibility: "agent-only" }],
        pluginSubmission: { pluginId: this.runtime.bb.pluginId, data: { [SUCCESSION_METADATA]: id } },
        pluginMetadata: { [SUCCESSION_METADATA]: id },
        ...execution,
      }), "Keeper succession spawn");
      if (!(await this.attest(this.state.get(id), staged))) throw new Error("The host's successor identity did not match its creation intent.");
      return this.state.bindCandidate(id, staged.id);
    } catch (error) {
      if (this.state.get(id).state === "failed") return this.state.get(id);
      const status = error && typeof error === "object" ? Number(Reflect.get(error, "status") ?? Reflect.get(error, "statusCode")) : NaN;
      if ([400, 401, 403, 404, 422].includes(status) && !this.state.get(id).candidate) {
        const failed = this.state.fail(id, `The host refused to create a successor: ${explain(error)}`);
        void this.runtime.recheckDispatch();
        return failed;
      }
      return this.state.recovering(id, `The successor creation outcome is not confirmed: ${explain(error)}`);
    }
  }

  private async quiet(thread: Thread, preparing = false) {
    if (!["idle", "error"].includes(thread.status) || thread.archivedAt !== null || thread.deletedAt !== null || thread.activeBackgroundAgentCount !== 0) return false;
    if (this.admitted.has(thread.id) || this.k.store.all("hires").some(hire => hire.owner.keeperThreadId === thread.id && !hire.memberThreadId)) return false;
    if (this.k.store.query("members", "keeperThreadId", thread.id, -1).some(member => ["releasing", "stopping", "archiving"].includes(member.engagement ?? ""))) return false;
    const [queue, interactions] = await Promise.all([
      loopCall(this.runtime.bb.sdk.threads.queuedMessages.list({ threadId: thread.id }), "Keeper succession user queue"),
      loopCall(this.runtime.bb.sdk.threads.interactions.list({ threadId: thread.id }), "Keeper succession pending interactions"),
    ]);
    const userQueued = queue.some(isUser);
    if (userQueued && preparing) throw new Error("Your message cancelled the refresh; press Refresh again when ready.");
    return !userQueued && !interactions.length;
  }

  private async attest(op: KeeperSuccession, thread: Creation) {
    return this.matches(op, thread) && (await this.metadata(thread.id))[SUCCESSION_METADATA] === op.id;
  }

  private metadata(threadId: string) {
    return loopCall(this.runtime.bb.sdk.threads.getPluginMetadata({ threadId }), "Keeper succession creation metadata");
  }

  private matches(op: KeeperSuccession, thread: Creation) {
    const intent = op.spawnIntent;
    return !!intent && thread.id !== op.predecessor && thread.projectId === intent.projectId && thread.providerId === intent.providerId &&
      thread.createdAt >= intent.at && thread.originPluginId === this.runtime.bb.pluginId && thread.originKind !== "fork" && thread.visibility === "hidden" &&
      thread.status === "pending" && thread.parentThreadId === null && thread.lifecycleOwnerThreadId === null && thread.sourceThreadId === null &&
      (thread.environmentId === null || thread.environmentId === intent.environmentId) && thread.archivedAt === null && thread.deletedAt === null;
  }

  private async recover(op: KeeperSuccession) {
    const intent = op.spawnIntent!;
    const deadline = intent.recoverUntil ?? intent.at + this.recoveryMs;
    const uncertain = op.state === "recovering" || !op.candidate;
    const expired = (live: KeeperSuccession) => this.abandon(live, "bb did not confirm a fresh Keeper before the recovery wait ended. The original Keeper is available again.");
    if (uncertain && this.k.now() >= deadline) return expired(op);
    const candidate = op.candidate;
    const lookup = candidate
      ? loopCall(this.runtime.bb.sdk.threads.get({ threadId: candidate }), "staged Keeper succession thread").then(async thread => await this.attest(op, thread) ? candidate : null)
      : this.findCandidate(op);
    let found: string | null;
    try {
      found = await (uncertain ? loopCall(lookup, "Keeper succession recovery window", Math.max(1, deadline - this.k.now())) : lookup);
    } catch (error) {
      const live = this.state.get(op.id);
      if (live.state === "failed") return live;
      if (this.k.now() >= deadline) return expired(live);
      return this.state.recovering(op.id, `The successor could not be verified: ${explain(error)}`);
    }
    const live = this.state.get(op.id);
    if (live.state === "failed") return found ? this.state.rememberUnused(op.id, found) : live;
    if (found) return this.state.bindCandidate(op.id, found);
    if (this.k.now() >= deadline) return expired(live);
    return this.state.recovering(op.id, "The host has not confirmed exactly one staged successor. Tavern will not create another.");
  }

  private async findCandidate(op: KeeperSuccession): Promise<string | null> {
    const matches = new Set<string>();
    for (let offset = 0; offset < 2000; offset += 200) {
      const threads = await loopCall(this.runtime.bb.sdk.threads.list({ projectId: op.spawnIntent!.projectId, originPluginId: this.runtime.bb.pluginId, limit: 200, offset, includeHidden: true }), "Keeper succession recovery scan");
      for (const thread of threads) if (await this.attest(op, thread)) matches.add(thread.id);
      if (threads.length < 200) return matches.size === 1 ? [...matches][0]! : null;
    }
    return null;
  }

  async dispatch(ctx: MessageDispatchHookContext) {
    const thread = ctx.thread;
    const fence = this.state.fence(thread.id);
    const link = this.k.store.get("successionThreads", thread.id);
    const candidate = link?.candidate ? this.state.get(link.operationId) : null;
    if (!fence && candidate && !candidate.followups.bootstrap) {
      const first = ctx.queuedMessages.length
        ? ctx.queuedMessages.some(row => row.originPluginId === this.runtime.bb.pluginId && inputText(row.content) === bootstrap(candidate.id))
        : ctx.originPluginId === this.runtime.bb.pluginId && ctx.input.text === bootstrap(candidate.id);
      if (!candidate.followups.visible || !first)
        return { action: "wait" as const, reason: "Tavern is finishing the Keeper succession.", sendAt: undefined };
    }
    if (fence?.kind === "retired") return { action: "reject" as const, message: fenceMessage(fence) };
    if (fence?.kind === "preparing" || fence?.kind === "restored") return { action: "wait" as const, reason: fenceMessage(fence), sendAt: undefined };
    if (fence?.kind === "candidate") {
      if (candidate?.state === "failed") return { action: "reject" as const, message: "This unused Keeper succession did not cut over." };
      return { action: "wait" as const, reason: fenceMessage(fence), sendAt: undefined };
    }
    const submission = ctx.experimental_submission;
    const data = submission?.pluginId === this.runtime.bb.pluginId && submission.data;
    const claimed = data && typeof data === "object" && !Array.isArray(data) ? data[SUCCESSION_METADATA] : undefined;
    if (candidate?.state === "done" && claimed === candidate.id) return null;
    if (claimed !== undefined || thread.status === "pending" && thread.visibility === "hidden" && thread.originPluginId === this.runtime.bb.pluginId && !this.k.member(thread.id)) {
      const metadata = await this.metadata(thread.id);
      const id = metadata[SUCCESSION_METADATA];
      if (claimed === undefined && id === undefined) return null;
      if (typeof id !== "string" || claimed !== undefined && claimed !== id)
        return { action: "reject" as const, message: "Tavern could not confirm this Keeper succession submission." };
      const op = this.k.store.get("keeperSuccessions", id);
      if (op?.state === "failed" && !op.restored && this.matches(op, thread) && !op.candidate) {
        this.signal(this.state.rememberUnused(id, thread.id));
        return { action: "reject" as const, message: "This unused Keeper succession did not cut over." };
      }
      if (!op || !["preparing", "recovering"].includes(op.state) || !this.matches(op, thread) || op.candidate && op.candidate !== thread.id)
        return { action: "reject" as const, message: "This thread is not the staged Keeper for that succession." };
      this.state.bindCandidate(id, thread.id);
      return { action: "wait" as const, reason: "The fresh Keeper's first input is held until cutover.", sendAt: undefined };
    }
    return null;
  }
}
