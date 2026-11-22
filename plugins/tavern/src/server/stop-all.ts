import { cancelMemberBrief, memberHost } from "./member-engagement";
import { wasReleased } from "../shared/member-engagement";
import { randomUUID } from "node:crypto";
import type { Actor } from "../shared/schema";
import { QUEUED_STOP_NOTICE, RESUME_ATTESTATION_NOTICE, stopBy, stopAllStateSchema, type StopAllState, type StopReceipt } from "../shared/stop-all";
import { isUser } from "./dispatch";
import { LoopTimeout, loopCall } from "./loop-call";
import type { MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import type { TavernRuntime } from "./runtime";
import type { KeeperStore } from "./keeper/store";
import { commitUserAct, type UserActReceipt } from "./authority";
import { isLiveKeeper, isOpenQuest } from "./liveness";
import type { CellarStopReceipt } from "../shared/stop-all";

type StopSource = { surface: string; pluginId?: string };
const busy = (status: string) => ["active", "starting", "pending", "stopping"].includes(status);
export function stopAllReason(store: Pick<KeeperStore, "get">): string | null {
  const state = store.get("stopAll", "tavern");
  return state?.state === "stopped" ? `Tavern is stopped by ${stopBy(state)} since ${new Date(state.since!).toISOString()}; resume on the common room. ${QUEUED_STOP_NOTICE}` : null;
}
export function assertTavernRunning(store: Pick<KeeperStore, "get">) {
  const reason = stopAllReason(store);
  if (reason) throw new Error(reason);
}

export async function stopKeeperGoneQuests(runtime: TavernRuntime, ids: string[], authority: UserActReceipt): Promise<CellarStopReceipt> {
  const k = runtime.keeper;
  const at = k.now(), id = k.store.id("cellar-stop");
  const quests = commitUserAct(k.store, () => k.now(), authority, () => {
    const targets = [...new Set(ids)].map(questId => k.store.get("quests", questId));
    if (!targets.length || targets.length !== ids.length || targets.some(q => {
      if (!q || q.deletedAt != null || q.archivedAt != null || q.cellarOnStop) return true;
      const member = k.member(q.keeperThreadId);
      return member?.role !== "keeper" || isLiveKeeper(k.store, member, "present") || !(q.phase === "stopping" || isOpenQuest(q));
    })) throw new Error("The “Needs a Keeper” list changed. Review the quests and confirm again.");
    const entries = targets.map(target => {
      const q = k.recordStop(target!.id, "Sent to the cellar because the Keeper is gone", authority.act);
      k.store.put("quests", q.id, { ...q, cellarOnStop: id });
      return q;
    });
    k.store.event(at, null, null, "tavern.cellar-stop-receipt", "Stop and cellar requested.", {
      id, surface: authority.surface, entries: entries.map(q => ({ questId: q.id, title: q.title })),
    }, { kind: "user" });
    return entries;
  });
  for (const q of quests) k.changed(q.keeperThreadId, q.id);
  for (const q of quests) {
    try { await runtime.retryStops(q.keeperThreadId, q.id, true); }
    catch (error) { runtime.bb.log.warn(`Tavern stop and cellar ${q.id}: ${String(error)}`); }
  }
  return { id, at, surface: authority.surface, entries: quests.map(q => ({
    questId: q.id, title: q.title, state: k.quest(q.id).archivedAt != null ? "cellared" : "stopping",
  })) };
}

export class StopAll {
  private flight: Promise<StopAllState> | null = null;
  constructor(private readonly runtime: TavernRuntime) {}
  snapshot(): StopAllState {
    const saved = this.runtime.keeper.store.get("stopAll", "tavern");
    return saved ? stopAllStateSchema.parse(saved) : { state: "running", since: null, by: null, receipt: null };
  }
  reason(): string | null { return stopAllReason(this.runtime.keeper.store); }
  assertRunning() { assertTavernRunning(this.runtime.keeper.store); }
  dispatch(ctx: MessageDispatchHookContext) {
    const reason = this.reason();
    if (!reason) return null;
    const member = this.runtime.keeper.member(ctx.thread.id);
    const submission = ctx.experimental_submission;
    const belongs = member?.role === "keeper" || member?.role === "member" ||
      ctx.originPluginId === this.runtime.bb.pluginId || submission?.pluginId === this.runtime.bb.pluginId;
    if (!belongs) return null;
    const human = ctx.queuedMessages.length ? ctx.queuedMessages.every(isUser) : isUser(ctx);
    // A hire's initial input is not a person's message, even when bb attributes the spawn to them.
    const hire = submission?.pluginId === this.runtime.bb.pluginId && typeof submission.data === "object" &&
      submission.data !== null && "hireToken" in submission.data;
    return human && !hire ? null : { action: "wait" as const, reason, sendAt: undefined };
  }
  ownsInterruption(threadId: string, at: number): boolean {
    const state = this.snapshot(), receipt = state.receipt;
    if (!receipt || at < receipt.startedAt) return false;
    const through = Math.max(receipt.completedAt ?? 0, receipt.startedAt + receipt.elapsedMs,
      state.state === "running" ? state.since! : this.runtime.keeper.now());
    return at <= through && receipt.entries.some(entry => entry.threadId === threadId && entry.status !== "already-idle");
  }
  private save(state: StopAllState) {
    this.runtime.keeper.store.put("stopAll", "tavern", state);
    this.runtime.bb.rpc.experimental_invalidate(["tavern:stop-all", "tavern:room"]);
  }
  private recount(receipt: StopReceipt) {
    receipt.stopped = receipt.entries.filter(e => e.status === "stopped").length;
    receipt.keepersStopped = receipt.entries.filter(e => e.status === "stopped" && e.role === "keeper").length;
    receipt.membersStopped = receipt.stopped - receipt.keepersStopped;
    receipt.failed = receipt.entries.filter(e => e.status === "failed").length;
    receipt.alreadyIdle = receipt.entries.filter(e => e.status === "already-idle").length;
    receipt.stillStopping = receipt.entries.filter(e => e.status === "still-stopping").length;
    receipt.elapsedMs = receipt.entries.reduce((last, e) => e.status === "stopped" ? Math.max(last, e.confirmedAt! - receipt.startedAt) : last, 0);
  }
  private receiptEvent(state: StopAllState) {
    this.runtime.keeper.store.event(this.runtime.keeper.now(), null, null, "tavern.stop-receipt", "Stop all receipt.", { receipt: state.receipt }, state.by!);
  }
  stop(by: Actor, source: StopSource = { surface: "internal" }): Promise<StopAllState> {
    if (this.flight) return this.flight;
    const previous = this.snapshot(), k = this.runtime.keeper, startedAt = k.now();
    const entries: StopReceipt["entries"] = k.store.all("members").filter(member => {
      const host = memberHost(k.store, member);
      return (member.role === "keeper" || member.role === "member") &&
        host.archivedAt == null && host.deletedAt == null && !wasReleased(member);
    }).map(member => ({ threadId: member.threadId, role: member.role as "keeper" | "member",
      status: "still-stopping", error: null, confirmedAt: null }));
    const receipt: StopReceipt = { id: randomUUID(), surface: source.surface, pluginId: source.pluginId,
      startedAt, completedAt: null, elapsedMs: 0, stopped: 0, keepersStopped: 0, membersStopped: 0,
      stillStopping: entries.length, failed: 0, alreadyIdle: 0, entries };
    const caller = by.kind === "agent" ? k.member(by.threadId) : null;
    const byLabel = source.pluginId ? `plugin ${source.pluginId}` : caller ? `${caller.role === "keeper" ? "Keeper" : "member"} ${k.name(caller)}` : undefined;
    const state: StopAllState = previous.state === "stopped" ? { ...previous, receipt }
      : { state: "stopped", since: startedAt, by, byLabel, receipt };
    k.store.atomic(() => {
      this.save(state);
      for (const entry of entries) {
        if (entry.role === "member") cancelMemberBrief(k.store, k.member(entry.threadId)!, startedAt, { stopAllReceiptId: receipt.id });
      }
      if (previous.state !== "stopped") k.store.event(startedAt, null, null, "tavern.stopped", "Tavern stopped; new work is held until Resume.", { receipt, surface: source.surface, pluginId: source.pluginId ?? null }, by);
    });
    for (const keeperId of new Set(entries.flatMap(entry => entry.role === "keeper" ? [entry.threadId] : []))) k.changed(keeperId);
    this.runtime.memory.cancel();
    this.flight = this.run(state).finally(() => { this.flight = null; });
    return this.flight;
  }
  private async run(state: StopAllState) {
    const receipt = state.receipt!, k = this.runtime.keeper;
    await Promise.all(receipt.entries.map(async entry => {
      let result: Partial<typeof entry>;
      let expired = false;
      const stopAndConfirm = async (): Promise<Partial<typeof entry>> => {
        await this.runtime.bb.sdk.threads.stop({ threadId: entry.threadId });
        if (expired) return { status: "still-stopping", error: "Stop sent; no confirmation within 5 s." };
        try {
          const thread = await this.runtime.bb.sdk.threads.get({ threadId: entry.threadId });
          return busy(thread.status) ? { status: "still-stopping", error: "Stop sent; bb has not confirmed it." }
            : { status: "stopped", error: null, confirmedAt: k.now() };
        } catch (error) { return { status: "still-stopping", error: `Stop sent; confirmation unavailable: ${String(error)}` }; }
      };
      try { result = await loopCall(stopAndConfirm(), "Stop all", 5000); }
      catch (error) {
        expired = error instanceof LoopTimeout;
        result = error instanceof LoopTimeout
          ? { status: "still-stopping", error: "Stop sent; no confirmation within 5 s." }
          : { status: "failed", error: error instanceof Error ? error.message : String(error) };
      }
      const current = this.snapshot();
      if (!current.receipt || current.receipt.id !== receipt.id) return;
      const saved = current.receipt.entries.find(e => e.threadId === entry.threadId)!;
      if (saved.status === "still-stopping") Object.assign(saved, result);
      this.recount(current.receipt);
      this.save(current);
    }));
    const current = this.snapshot();
    if (current.receipt && current.receipt.id === receipt.id) {
      current.receipt.completedAt = k.now();
      this.save(current);
      this.receiptEvent(current);
    }
    return this.snapshot();
  }
  observeThread(thread: { id: string; status: string }) {
    const state = this.snapshot(), receipt = state.receipt;
    const entry = receipt?.entries.find(e => e.threadId === thread.id && e.status === "still-stopping");
    if (!receipt || !entry || busy(thread.status)) return;
    Object.assign(entry, { status: "stopped", error: null, confirmedAt: this.runtime.keeper.now() });
    this.recount(receipt);
    this.save(state);
    if (receipt.completedAt !== null) this.receiptEvent(state);
  }
  recoverReceipt() {
    const state = this.snapshot(), receipt = state.receipt;
    if (!receipt || receipt.completedAt !== null || this.flight) return;
    receipt.completedAt = this.runtime.keeper.now();
    for (const entry of receipt.entries) if (entry.status === "still-stopping") entry.error = "Receipt collection interrupted by restart; awaiting a thread observation.";
    this.recount(receipt);
    this.save(state);
    this.receiptEvent(state);
  }
  resume(surface = "client RPC (unattested)") {
    if (this.flight) throw new Error("Stop all is still collecting its receipt; wait before resuming.");
    const state = this.snapshot();
    if (state.state === "running") return state;
    const k = this.runtime.keeper;
    const resumeReceipt = { at: k.now(), surface, notice: RESUME_ATTESTATION_NOTICE, personProven: false as const };
    const next: StopAllState = { ...state, state: "running", since: k.now(), by: { kind: "tavern" }, byLabel: undefined, resumeReceipt };
    k.store.atomic(() => {
      this.save(next);
      k.store.event(next.since!, null, null, "tavern.resumed", `Resume requested through ${surface}; ${RESUME_ATTESTATION_NOTICE}.`, { receipt: state.receipt, ...resumeReceipt }, { kind: "tavern" });
      const keepers = new Map<string, string[]>();
      for (const entry of state.receipt?.entries ?? []) {
        if (entry.role !== "member" || entry.status === "already-idle") continue;
        const member = k.member(entry.threadId);
        if (member?.keeperThreadId) keepers.set(member.keeperThreadId, [...(keepers.get(member.keeperThreadId) ?? []), entry.threadId]);
      }
      for (const [keeperId, memberThreadIds] of keepers) k.store.event(k.now(), keeperId, null, "tavern.members-interrupted",
        `Stop all sent stops to these members: ${memberThreadIds.join(", ")}. Check their reports and send fresh briefs as needed.`, { memberThreadIds, receiptId: state.receipt?.id ?? null }, { kind: "tavern" });
    });
    void this.runtime.resumeDeferredStartup().then(() => this.runtime.recheckDispatch()).catch(error => {
      this.runtime.bb.log.warn(`Tavern Resume reconciliation: ${String(error)}`);
    });
    return this.snapshot();
  }
}
