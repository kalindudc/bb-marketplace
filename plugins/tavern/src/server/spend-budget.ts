import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { NANOS_PER_CENT, NANOS_PER_DOLLAR, budgetCentsSchema, type SpendView } from "../shared/spend";
import type { BoardQuest } from "../shared/schema";
import { authorize, type UserActReceipt } from "./authority";
import type { Keeper } from "./keeper/service";
import { isOpenQuest } from "./liveness";
import { SpendLedger } from "./spend-ledger";
import { leadAncestors } from "./keeper/leads";
import { projectLeadSpendSubtree } from "./keeper/lead-spend";

const amount = z.number().finite().nonnegative();
const burnReport = z.object({ startedAt: amount, updatedAt: amount, calls: amount, turns: z.array(z.object({ at: amount, calls: amount, cost: amount })) }).nullable();
const burnResponse = z.object({ report: burnReport });
type BurnReport = z.infer<typeof burnReport>;
type BurnRead = { report: BurnReport; readAt: number; stale: boolean };

export function changeSpendBudget(k: Keeper, id: string, cents: number | null, receipt: UserActReceipt, measured: number | null, planVersion?: number) {
  authorize(planVersion === undefined ? "setSpendBudget" : "answerAsk", { level: "user-explicit", receipt: receipt.surface });
  if (cents !== null) budgetCentsSchema.parse(cents);
  return k.store.atomic(() => {
    const q = k.quest(id), before = q.spendBudget;
    if (!isOpenQuest(q) || q.phase === "stopping") throw new Error("Only an open quest can change its spend budget.");
    if ((before?.cents ?? null) === cents) return false;
    if (before?.reached && cents !== null && (cents <= before.cents || cents * NANOS_PER_CENT <= Math.max(before.reached.usdNanos, measured ?? 0))) {
      throw new Error("Raise the budget above the recorded spend and the current cap, or remove it.");
    }
    const next = { ...q };
    if (next.spendProposal) next.spendProposal = null;
    if (cents === null) delete next.spendBudget;
    else next.spendBudget = { cents, reached: null };
    k.store.put("quests", id, next);
    k.store.event(k.now(), q.keeperThreadId, id, before?.reached ? "spend-budget.lifted" : "spend-budget.set",
      cents === null ? "You removed the quest spend budget." : before?.reached ? "You raised the quest spend budget and lifted the hold." : "You set the quest spend budget.",
      { fromCents: before?.cents ?? null, toCents: cents, surface: receipt.surface, ...(planVersion === undefined ? {} : { planVersion }) }, { kind: "user" });
    k.changed(q.keeperThreadId, id);
    return true;
  });
}

export class SpendBudget {
  readonly ledger: SpendLedger;
  private reads = new Map<string, Promise<SpendView>>();
  private burnReads = new Map<string, { attemptedAt: number; value: Promise<BurnRead> }>();

  constructor(private readonly bb: BbPluginApi, private readonly k: Keeper) { this.ledger = new SpendLedger(k.store); }

  private budgetQuests(id: string | null | undefined) {
    const { store } = this.k;
    if (!id) return [];
    return [id, ...leadAncestors(store, id).map(link => link.parentQuestId)]
      .flatMap(id => { const q = store.get("quests", id); return q?.spendBudget ? [q] : []; });
  }

  held(id: string | null | undefined) { return this.budgetQuests(id).some(q => q.spendBudget?.reached); }

  async refreshForThread(threadId: string) {
    const member = this.k.member(threadId);
    if (!member) return;
    const quests = this.k.store.query("quests", "keeperThreadId", threadId, 500).map(q => q.id);
    if (member.boardQuestId) quests.push(member.boardQuestId);
    const budgets = new Map(quests.flatMap(id => this.budgetQuests(id).map(q => [q.id, q] as const)));
    for (const q of budgets.values()) if (!q.spendBudget?.reached && isOpenQuest(q)) await this.refresh(q.id);
  }

  async allows(id: string | null | undefined) {
    if (this.held(id)) return false;
    for (const q of this.budgetQuests(id)) await this.refresh(q.id);
    return !this.held(id);
  }

  async assert(id: string | null | undefined) {
    if (!(await this.allows(id))) throw new Error("The quest reached its spend budget. Only you can raise or remove it on the quest page.");
  }

  view(id: string): Promise<SpendView> { return this.refresh(id, !this.k.quest(id).spendBudget); }

  refresh(id: string, localOnly = false): Promise<SpendView> {
    const key = `${id}:${localOnly ? "local" : "all"}`;
    const inFlight = this.reads.get(key);
    if (inFlight) return inFlight;
    const next = this.measure(this.k.quest(id), localOnly).then(view => this.k.store.atomic(() => {
      const q = this.k.quest(id), budget = q.spendBudget;
      let reachedAt = budget?.reached?.at ?? null;
      if (!localOnly && budget && reachedAt === null && view.usdNanos !== null && view.usdNanos >= budget.cents * NANOS_PER_CENT && isOpenQuest(q) && q.phase !== "stopping") {
        reachedAt = this.k.now();
        const reached = { at: reachedAt, usdNanos: view.usdNanos };
        this.k.store.put("quests", id, { ...q, spendBudget: { ...budget, reached } });
        this.k.store.event(reachedAt, q.keeperThreadId, id, "spend-budget.reached", "The quest reached its measured spend budget. New hires and briefs are held.", { cents: budget.cents, ...reached, missing: view.missing }, { kind: "tavern" });
        this.k.changed(q.keeperThreadId, id);
      }
      return { ...view, budgetCents: budget?.cents ?? null, reachedAt, ...(q.spendProposal ? { proposal: q.spendProposal } : {}) };
    })).finally(() => this.reads.delete(key));
    this.reads.set(key, next);
    return next;
  }

  async set(id: string, cents: number | null, receipt: UserActReceipt) {
    const { usdNanos } = await this.refresh(id);
    changeSpendBudget(this.k, id, cents, receipt, usdNanos);
    await this.refresh(id);
  }

  private burn(threadId: string, signal: AbortSignal) {
    const now = this.k.now();
    const cached = this.burnReads.get(threadId);
    if (cached && now - cached.attemptedAt < 10_000) return cached.value;
    const skipped = signal.aborted;
    const request = skipped ? Promise.resolve(null) : this.bb.sdk.plugins.callRpc({ pluginId: "burn", method: "usage", input: { threadId },
      outputSchema: burnResponse as unknown as Parameters<BbPluginApi["sdk"]["plugins"]["callRpc"]>[0]["outputSchema"], signal,
    }).then(result => burnResponse.parse(result).report, () => null);
    const value = request.catch(error => {
      this.bb.log.warn(`Tavern could not read Burn spend: ${String(error)}`);
      return null;
    }).then(report => {
      const db = this.k.store.db;
      const previous = db.prepare("SELECT read_at, data FROM tavern_spend_burn WHERE thread_id=?").get(threadId) as { read_at: number; data: string } | undefined;
      let prior: BurnReport = null;
      if (previous) {
        try {
          prior = burnReport.parse(JSON.parse(previous.data));
        } catch {
          this.bb.log.warn("Tavern ignored an invalid saved Burn reading.");
        }
      }
      if (report?.turns.length && (!prior || report.calls >= prior.calls && report.updatedAt >= prior.updatedAt)) {
        if (!prior || JSON.stringify(prior) !== JSON.stringify(report)) db.prepare(`INSERT INTO tavern_spend_burn VALUES(?,?,?)
          ON CONFLICT(thread_id) DO UPDATE SET read_at=excluded.read_at,data=excluded.data`).run(threadId, now, JSON.stringify(report));
        return { report, readAt: now, stale: false };
      }
      return { report: prior, readAt: previous?.read_at ?? now, stale: true };
    });
    if (!skipped) {
      this.burnReads.delete(threadId);
      this.burnReads.set(threadId, { value, attemptedAt: now });
      if (this.burnReads.size > 128) this.burnReads.delete(this.burnReads.keys().next().value!);
    }
    return value;
  }

  private async measure(q: BoardQuest, localOnly: boolean): Promise<SpendView> {
    const now = this.k.now(), signal = AbortSignal.timeout(1_000);
    const sources = new Map<string, number>();
    let subtotal = 0, known = false, missing = 0;
    for (const id of projectLeadSpendSubtree(this.k.store, q.id)) {
      const part = await this.measureQuest(id === q.id ? q : this.k.quest(id), localOnly, now, signal);
      if (part.usdNanos !== null) { subtotal += part.usdNanos; known = true; }
      missing += part.missing;
      for (const { name, readAt } of part.sources) sources.set(name, Math.max(sources.get(name) ?? 0, readAt));
    }
    return { budgetCents: q.spendBudget?.cents ?? null, reachedAt: q.spendBudget?.reached?.at ?? null,
      usdNanos: known || missing === 0 ? subtotal : null, missing, sources: [...sources].map(([name, readAt]) => ({ name, readAt })) };
  }

  private async measureQuest(q: BoardQuest, localOnly: boolean, now: number, signal: AbortSignal): Promise<Pick<SpendView, "usdNanos" | "missing" | "sources">> {
    const to = q.endedAt ?? now;
    const leadStarts = new Map(this.k.store.leadLinksBy("parentQuestId", q.id).flatMap(link => {
      if (!link.childQuestId) return [];
      const child = this.k.quest(link.childQuestId);
      return this.k.store.spendIntervals(child.keeperThreadId).map(interval => [interval.threadId, child.createdAt] as const);
    }));
    const members = this.k.store.query("members", "boardQuestId", q.id, 501).filter(member => member.role === "member");
    const others = this.k.store.query("quests", "keeperThreadId", q.keeperThreadId, 500).filter(other => other.id !== q.id && other.createdAt <= to && (other.endedAt === null || other.endedAt >= q.createdAt));
    const targets = [
      ...this.k.store.spendIntervals(q.keeperThreadId).map(interval => ({ threadId: interval.threadId, shared: true,
        from: Math.max(q.createdAt, interval.from ?? q.createdAt), through: interval.until === null ? to : Math.min(to, interval.until - 1),
        closed: interval.until !== null, activityAt: interval.activityAt })),
      ...members.slice(0, 500).map(member => ({ threadId: member.threadId, shared: false,
        from: Math.max(q.createdAt, member.createdAt), through: Math.min(to, (leadStarts.get(member.threadId) ?? Infinity) - 1), closed: false, activityAt: undefined })),
    ].filter(target => target.from <= target.through);
    const sources = new Map<string, number>();
    let subtotal: number | null = null, missing = Number(members.length > 500);
    for (let i = 0; i < targets.length; i += 8) {
      const data = await Promise.all(targets.slice(i, i + 8).map(async ({ threadId, from, through, closed, activityAt }) => {
        const local = this.ledger.read(threadId, from, through);
        const usable = local.rows.filter(row => row.usdNanos !== null);
        const runtime = this.k.store.runtime(threadId);
        const activity = closed ? activityAt : runtime.lastSpendActivityAt ?? runtime.lastReply?.at;
        const activeInWindow = activity !== undefined && activity >= from && activity <= through;
        const uncovered = activeInWindow && (local.rows.at(-1)?.at ?? -1) < activity;
        const complete = !uncovered && !local.partial && usable.length === local.rows.length && usable.length > 0;
        if (complete) return { rows: usable, missing: false, readAt: now };
        const noWork = !activeInWindow && local.rows.length === 0 && (!local.partial || local.absent);
        const localResult = { rows: usable, missing: !noWork, readAt: now };
        if (localOnly) return localResult;
        const { report, readAt, stale } = await this.burn(threadId, signal);
        const turns = report?.turns.filter(turn => turn.at >= from && turn.at <= through) ?? [];
        const observedThrough = Math.min(through, q.endedAt ?? Math.max(from, activity ?? from, local.rows.at(-1)?.at ?? from));
        const covered = !stale && !!report && turns.length > 0 && report.turns.reduce((calls, turn) => calls + turn.calls, 0) >= report.calls && report.updatedAt >= observedThrough;
        const rows = turns.map(turn => ({ ...turn, source: "Burn", usdNanos: Math.round(turn.cost * NANOS_PER_DOLLAR) })).filter(row => Number.isSafeInteger(row.usdNanos));
        if (rows.length > 0 && (!usable.length || covered && rows.length === turns.length)) return { rows, missing: !covered || rows.length !== turns.length, readAt };
        return localResult;
      }));
      for (const [index, read] of data.entries()) {
        if (read.missing) missing++;
        for (const row of read.rows) {
          if (row.usdNanos === null) continue;
          const share = targets[i + index]!.shared ? 1 + others.filter(other => other.createdAt <= row.at && (other.endedAt === null || other.endedAt >= row.at)).length : 1;
          subtotal = (subtotal ?? 0) + Math.floor(row.usdNanos / share);
          sources.set(row.source, Math.max(sources.get(row.source) ?? 0, read.readAt));
        }
      }
    }
    return { usdNanos: subtotal, missing, sources: [...sources].map(([name, readAt]) => ({ name, readAt })) };
  }
}
