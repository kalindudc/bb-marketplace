import type { BbPluginApi, MessageDispatchHookContext, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { leadLine } from "./blocks";
import type { Companions } from "./companion";
import { FEED_LIMIT, threadTag, type BannerDto, type FeedDto, type FlareDto, type RunDto } from "./contract";
import { KIND_LABELS } from "./kinds";
import { normalizeFlare, type FlareFields } from "./normalize";
import { FORWARD_PREFIX, NUDGE_PREFIX, forwardText, nudgeText } from "./notes";
import { PROVIDER_ID } from "./provider";
import type { FlareSettings } from "./settings";
import type { FlareRow, FlareSource, FlareStore, RunRow } from "./store";

export type Thread = PluginThreadEventPayloads["thread.active"]["thread"];

/** A repeat of the same flare inside this window is an agent retrying a call, not news. */
export const DUPLICATE_WINDOW_MS = 2 * 60_000;
/** Past this many flares in one turn, flares are still kept but no longer notify or reach the parent. */
export const LOUD_FLARES_PER_TURN = 20;
export const MAX_NUDGES_PER_TURN = 3;
const PUSH_PLUGIN = "push-notifications";
const PROMPT_MAX = 200;

export type SendResult =
  | { status: "sent"; flare: FlareRow; notes: string[] }
  | { status: "duplicate"; flare: FlareRow }
  | { status: "refused"; reason: string }
  | { status: "failed"; reason: string };

export interface SendInput {
  threadId: string;
  projectId: string | null;
  fields: FlareFields;
  source: FlareSource;
}

const pushResult = z.object({ ok: z.literal(true), channels: z.array(z.string()) });
const threadLevels = z.object({ threads: z.record(z.string(), z.unknown()) });

export const threadName = (thread: Pick<Thread, "title" | "titleFallback">): string =>
  thread.title?.trim() || thread.titleFallback?.trim() || "Untitled thread";

const cut = (value: string, max: number): string => (value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`);
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function shouldPush(mode: FlareSettings["notify"], flare: Pick<FlareRow, "kind" | "urgent">): boolean {
  if (mode === "off") return false;
  return mode === "all" || flare.kind === "blocker" || flare.urgent;
}

export const shouldForward = shouldPush;

/** Since when a running turn has had neither a flare nor a reminder. */
export const quietSince = (run: RunRow, lastFlareAt: number | null): number => Math.max(run.startedAt, lastFlareAt ?? 0, run.lastNudgeAt ?? 0);

/** Whether a running turn has been quiet long enough for a reminder. */
export function dueForNudge(run: RunRow, lastFlareAt: number | null, settings: FlareSettings, now: number): boolean {
  if (settings.nudgeMinutes <= 0 || run.endedAt !== null || run.nudges >= MAX_NUDGES_PER_TURN) return false;
  if (run.isChild && !settings.nudgeChildThreads) return false;
  return now - quietSince(run, lastFlareAt) >= settings.nudgeMinutes * 60_000;
}

export const isFlareNote = (text: string): boolean => text.startsWith(FORWARD_PREFIX) || text.startsWith(NUDGE_PREFIX);

type DispatchContext = Pick<MessageDispatchHookContext, "attempt" | "input" | "queuedMessages" | "initiator" | "originPluginId">;
interface Author {
  initiator: string;
  originPluginId: string | null;
}

// Flare marks its sends with its plugin id; where bb does not carry that through, anything but a person's own
// message with Flare's prefix is taken as Flare's, so a user who pastes a note back is never refused.
const flareAuthored = (text: string, author: Author, pluginId: string): boolean =>
  isFlareNote(text.trimStart()) && (author.originPluginId === pluginId || author.initiator !== "user");

/**
 * Whether a dispatch would start a turn with nothing but Flare's own notes. A note queued behind the user's message
 * rides along with the turn that message starts; only a turn the notes alone would start is refused.
 */
export function startsTurnWithOnlyFlareNotes(ctx: DispatchContext, pluginId: string): boolean {
  if (ctx.attempt !== "start-turn") return false;
  if (ctx.queuedMessages.length === 0) {
    return flareAuthored(ctx.input.text, { initiator: ctx.initiator, originPluginId: ctx.originPluginId === "mixed" ? null : ctx.originPluginId }, pluginId);
  }
  return ctx.queuedMessages.every((row) =>
    flareAuthored(row.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"), row, pluginId),
  );
}

export function runDto(run: RunRow): RunDto {
  return { id: run.id, startedAt: run.startedAt, endedAt: run.endedAt, outcome: run.outcome, error: run.error, prompt: run.prompt };
}

export function flareDto(row: FlareRow, viewer: string, drawn = false): FlareDto {
  return {
    id: row.id,
    threadId: row.threadId,
    kind: row.kind,
    title: row.title,
    body: row.body,
    urgent: row.urgent,
    source: row.source,
    createdAt: row.createdAt,
    runId: row.runId,
    fromChild: row.threadId === viewer ? null : { threadId: row.threadId, title: row.threadTitle },
    pushed: row.pushedAt !== null,
    forwarded: row.forwardedAt !== null,
    drawn,
  };
}

/**
 * Everything Flare does. `send` is synchronous and only writes one row, so the agent's tool call returns at once;
 * notifications, the parent's copy and every other read of bb happen afterwards, in the background.
 */
export class FlareService {
  private readonly pending = new Set<Promise<void>>();
  /** The order in which each thread last started or stopped working, as Flare heard it. */
  private readonly lifecycle = new Map<string, number>();
  private events = 0;

  constructor(
    private readonly bb: BbPluginApi,
    private readonly store: FlareStore,
    private readonly settings: () => Promise<FlareSettings>,
    private readonly now: () => number = Date.now,
    private readonly companions: Companions | null = null,
  ) {}

  /** Flare's own companion threads run on its renderer; they are never turns, viewers or senders. */
  private isCompanion(thread: Pick<Thread, "id" | "providerId">): boolean {
    return thread.providerId === PROVIDER_ID || this.store.isCompanion(thread.id);
  }

  send(input: SendInput): SendResult {
    const normalized = normalizeFlare(input.fields);
    if (!normalized.ok) return { status: "refused", reason: normalized.reason };
    const { draft, notes } = normalized;
    const now = this.now();
    let row: FlareRow;
    try {
      const repeat = this.store.findDuplicate(input.threadId, draft, now - DUPLICATE_WINDOW_MS);
      if (repeat !== null) return { status: "duplicate", flare: repeat };
      row = this.store.insertFlare({ threadId: input.threadId, projectId: input.projectId, draft, source: input.source, now });
    } catch (error) {
      this.bb.log.warn(`Could not save a flare for ${input.threadId}: ${message(error)}`);
      return { status: "failed", reason: message(error) };
    }
    // The row is saved, so nothing from here on may turn the result into a failure the agent would retry.
    try {
      const loud = row.runId === null || this.store.countInRun(row.runId) <= LOUD_FLARES_PER_TURN;
      if (!loud) notes.push("That is a lot of flares for one turn, so this one did not notify anyone. Send only what the user needs to see now.");
      this.invalidate([row.threadId]);
      this.defer(() => this.fanOut(row, loud));
    } catch (error) {
      this.bb.log.warn(`A flare for ${input.threadId} was saved, but its notifications were not started: ${message(error)}`);
    }
    return { status: "sent", flare: row, notes };
  }

  private async fanOut(row: FlareRow, loud: boolean): Promise<void> {
    const sdk = this.bb.sdk;
    const [thread, ancestors] = await Promise.all([
      this.thread(row.threadId),
      sdk.threads.experimental_listAncestors({ threadIds: [row.threadId] }).then(
        (result) => result.threads.find((entry) => entry.threadId === row.threadId)?.ancestorIds ?? [],
        (error) => {
          this.bb.log.warn(`Could not read the threads above ${row.threadId}: ${message(error)}`);
          return [] as string[];
        },
      ),
    ]);
    const title = thread === null ? null : threadName(thread);
    if (title !== null) this.store.setThreadTitle(row.id, title);
    // Without the full chain, the parent still hears about its child's flare.
    if (ancestors.length === 0 && thread?.parentThreadId) ancestors.push(thread.parentThreadId);
    if (ancestors.length > 0) this.store.addAudience(row.id, ancestors);
    this.invalidate([row.threadId, ...ancestors]);

    const settings = await this.settings();
    const work: Promise<void>[] = [];
    // Shown in the companions whatever the per-turn limit says: the tab lists every flare.
    if (settings.tab === "rendered" && this.companions !== null) work.push(this.companions.show([row.threadId, ...ancestors]));
    if (!loud) {
      await Promise.all(work);
      return;
    }
    if (shouldPush(settings.notify, row)) work.push(this.push(row, title, ancestors));
    const parent = ancestors[0];
    if (parent !== undefined && shouldForward(settings.forwardToParent, row)) work.push(this.forward(row, parent, title));
    await Promise.all(work);
  }

  private async push(row: FlareRow, threadTitle: string | null, ancestors: readonly string[]): Promise<void> {
    if (await this.muted([row.threadId, ...ancestors])) return;
    const lead = `${KIND_LABELS[row.kind]}${threadTitle === null ? "" : ` in ${threadTitle}`}`;
    const detail = leadLine(row.body) ?? undefined;
    const channels = await this.notify({ title: row.title, body: detail === undefined ? lead : `${lead}: ${detail}`, threadId: row.threadId });
    if (channels > 0) {
      this.store.markPushed(row.id, this.now());
      this.invalidate([row.threadId]);
    }
  }

  private async forward(row: FlareRow, parent: string, childTitle: string | null): Promise<void> {
    if (!(await this.working(parent))) return;
    try {
      await this.bb.sdk.threads.send({
        threadId: parent,
        mode: "steer",
        originPluginId: this.bb.pluginId,
        senderThreadId: row.threadId,
        input: [{ type: "text", text: forwardText(row, childTitle), mentions: [], visibility: "agent-only" }],
      });
      this.store.markForwarded(row.id, this.now());
      this.invalidate([row.threadId, parent]);
    } catch (error) {
      this.bb.log.warn(`Could not pass a flare from ${row.threadId} to ${parent}: ${message(error)}`);
    }
  }

  /** Push through bb's push notifications plugin; 0 channels when it is missing, off or reached nobody. */
  private async notify(input: { title: string; body: string; threadId: string }): Promise<number> {
    try {
      const result = await this.bb.sdk.plugins.callRpc({
        pluginId: PUSH_PLUGIN,
        method: "notifications.send",
        input: { title: cut(input.title, 80), body: cut(input.body, 180), threadId: input.threadId },
        outputSchema: pushResult,
      });
      return result.channels.length;
    } catch (error) {
      this.bb.log.info(`No push notification for ${input.threadId}: ${message(error)}`);
      return 0;
    }
  }

  /**
   * Whether the user muted the thread, or a thread above it, in push notifications: a muted parent caps its children
   * there. Unknown counts as not muted.
   */
  private async muted(threadIds: readonly string[]): Promise<boolean> {
    try {
      const { threads } = await this.bb.sdk.plugins.callRpc({
        pluginId: PUSH_PLUGIN,
        method: "threadNotifications.list",
        input: { threadIds: [...threadIds] },
        outputSchema: threadLevels,
      });
      // Each entry is `{ own, ancestorCap }`: the thread's own level and the strictest level set above it.
      return threadIds.some((id) => {
        const entry = threads[id];
        if (typeof entry === "string") return entry === "muted";
        const levels = entry as { own?: unknown; ancestorCap?: unknown; level?: unknown } | undefined;
        return levels?.own === "muted" || levels?.ancestorCap === "muted" || levels?.level === "muted";
      });
    } catch {
      return false;
    }
  }

  /** A thread whose turn is running and not waiting on the user: the only kind Flare ever adds a note to. */
  private async working(threadId: string): Promise<boolean> {
    const thread = await this.thread(threadId);
    if (thread === null || thread.status !== "active" || thread.runtime.displayStatus !== "active") return false;
    try {
      const interactions = await this.bb.sdk.threads.interactions.list({ threadId });
      return !interactions.some((item) => item.status === "pending");
    } catch {
      return false;
    }
  }

  private async thread(threadId: string): Promise<Thread | null> {
    try {
      return (await this.bb.sdk.threads.get({ threadId })) as Thread;
    } catch (error) {
      this.bb.log.warn(`Could not read thread ${threadId}: ${message(error)}`);
      return null;
    }
  }

  onActive(thread: Thread): void {
    if (this.isCompanion(thread)) return;
    this.lifecycle.set(thread.id, ++this.events);
    const { run, started } = this.store.startRun(thread.id, this.now(), thread.parentThreadId !== null);
    if (!started) return;
    this.invalidate([thread.id]);
    this.defer(() => this.labelRun(run));
  }

  onIdle(thread: Thread): void {
    if (this.isCompanion(thread)) {
      // A companion turn that ended has drawn a flare; its viewer's tab can now put a divider over it.
      const viewer = this.store.viewerOf(thread.id);
      if (viewer !== null) this.invalidate([viewer]);
      return;
    }
    this.lifecycle.set(thread.id, ++this.events);
    if (this.store.endRun(thread.id, this.now(), "done") !== null) this.invalidate([thread.id]);
  }

  onFailed(thread: Thread, error: string | null): void {
    if (this.isCompanion(thread)) return;
    this.lifecycle.set(thread.id, ++this.events);
    const ended = this.store.endRun(thread.id, this.now(), "failed", error === null ? null : cut(error, 500));
    if (ended === null) return;
    this.invalidate([thread.id]);
    this.defer(async () => {
      if (!(await this.settings()).notifyOnFailure) return;
      const last = this.store.latestInRun(ended.id);
      if (last === null || (await this.muted([thread.id]))) return;
      await this.notify({ title: `Turn failed in ${threadName(thread)}`, body: `Last flare: ${last.title}`, threadId: thread.id });
    });
  }

  onDeleted(thread: Thread): void {
    this.lifecycle.delete(thread.id);
    // A deleted viewer takes its companion with it. A companion deleted by hand is replaced: its viewer's flares are
    // all drawn again in a new one, which is also how a companion from an older build gets its dividers. A thread above
    // a deleted child whose companion drew the child's flares is rebuilt without them, as pruning does.
    const companion = this.store.companionOf(thread.id);
    const viewer = this.store.viewerOf(thread.id);
    const above = this.store.viewersShowingThread(thread.id).flatMap((id) => {
      const stale = this.store.companionOf(id);
      return stale === null ? [] : [{ viewer: id, companion: stale }];
    });
    const companions = this.companions;
    if (companion !== null && companions !== null) this.defer(() => companions.discard(thread.id, companion));
    if (viewer !== null) this.store.forgetCompanion(viewer);
    this.store.deleteThread(thread.id);
    const redraw = [...(viewer === null ? [] : [viewer]), ...above.map((stale) => stale.viewer)];
    this.invalidate([thread.id, ...redraw]);
    if (redraw.length > 0 && companions !== null) {
      this.defer(async () => {
        for (const stale of above) await companions.discard(stale.viewer, stale.companion);
        if ((await this.settings()).tab === "rendered") await companions.show(redraw);
      });
    }
  }

  /** The message that started a thread's latest turn: when it was sent and its text. */
  private async lastRequest(threadId: string): Promise<{ at: number; text: string } | null> {
    const [event] = await this.bb.sdk.threads.events.list({ threadId, types: ["client/turn/requested"], order: "desc", limit: "1" });
    if (event === undefined || event.type !== "client/turn/requested") return null;
    const input = (event.data as { input?: { type: string; text?: string }[] }).input ?? [];
    const text = input
      .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return { at: event.createdAt, text: cut(text, PROMPT_MAX) };
  }

  /** Labels a run with the message that started it, so the Flares tab can say what each turn was about. */
  private async labelRun(run: RunRow): Promise<void> {
    const request = await this.lastRequest(run.threadId);
    if (request === null || request.text === "") return;
    this.store.setRunPrompt(run.id, request.text);
    this.invalidate([run.threadId]);
  }

  /** Matches open runs to the threads that are really running, after a restart or a reload missed their events. */
  async reconcile(): Promise<void> {
    const before = this.events;
    // A thread event that arrives while this runs is newer than anything read here, so it wins.
    const moved = (threadId: string): boolean => (this.lifecycle.get(threadId) ?? 0) > before;
    const running = new Set((await this.bb.sdk.threads.listRunning()).map((entry) => entry.id));
    const now = this.now();
    const changed: string[] = [];
    for (const run of this.store.openRuns()) {
      if (running.has(run.threadId) || moved(run.threadId)) continue;
      this.store.endRun(run.threadId, now, "unknown");
      changed.push(run.threadId);
    }
    for (const threadId of running) {
      if (moved(threadId) || this.store.openRun(threadId) !== null) continue;
      const thread = await this.thread(threadId);
      if (thread === null || this.isCompanion(thread)) continue;
      // The turn began before Flare saw it, so its start and label come from the message that started it.
      const request = await this.lastRequest(threadId).catch(() => null);
      if (moved(threadId) || this.store.openRun(threadId) !== null) continue;
      const { run } = this.store.startRun(threadId, Math.min(request?.at ?? now, now), thread.parentThreadId !== null);
      if (request !== null && request.text !== "") this.store.setRunPrompt(run.id, request.text);
      changed.push(threadId);
    }
    this.invalidate(changed);
  }

  /** Reminds each running turn that has gone quiet for the configured time. */
  async nudge(): Promise<void> {
    const settings = await this.settings();
    if (settings.nudgeMinutes <= 0) return;
    for (const run of this.store.openRuns()) {
      const now = this.now();
      const lastFlareAt = this.store.lastFlareAt(run.threadId);
      if (!dueForNudge(run, lastFlareAt, settings, now)) continue;
      const quietMinutes = Math.round((now - quietSince(run, lastFlareAt)) / 60_000);
      const thread = await this.thread(run.threadId);
      if (thread === null || (thread.visibility === "hidden" && !settings.nudgeChildThreads)) continue;
      if (!(await this.working(run.threadId))) continue;
      // Counted before sending, so a slow send is never repeated by the next tick.
      this.store.recordNudge(run.id, now);
      try {
        await this.bb.sdk.threads.send({
          threadId: run.threadId,
          mode: "steer",
          originPluginId: this.bb.pluginId,
          input: [{ type: "text", text: nudgeText(quietMinutes, quietSince(run, lastFlareAt) > run.startedAt), mentions: [], visibility: "agent-only" }],
        });
      } catch (error) {
        this.bb.log.warn(`Could not remind ${run.threadId}: ${message(error)}`);
      }
    }
  }

  /** Deletes old flares; a companion that showed one is rebuilt from the flares that are left. */
  async prune(keepDays: number): Promise<number> {
    const before = this.now() - keepDays * 86_400_000;
    const stale = this.store.viewersShowingBefore(before).flatMap((viewer) => {
      const companion = this.store.companionOf(viewer);
      return companion === null ? [] : [{ viewer, companion }];
    });
    const removed = this.store.prune(before);
    if (this.companions !== null && stale.length > 0) {
      for (const { viewer, companion } of stale) await this.companions.discard(viewer, companion);
      if ((await this.settings()).tab === "rendered") await this.companions.show(stale.map(({ viewer }) => viewer));
    }
    return removed;
  }

  banner(threadId: string): BannerDto {
    const run = this.store.openRun(threadId) ?? this.store.latestRun(threadId);
    const since = run?.startedAt ?? this.now() - 86_400_000;
    const dismissed = this.store.dismissedThrough(threadId) ?? -1;
    const flares = this.store.flaresFor(threadId, { since, limit: 200, children: true }).filter((row) => row.createdAt > dismissed);
    const top = flares[0];
    return {
      flare: top === undefined ? null : flareDto(top, threadId),
      count: flares.length,
      childCount: flares.filter((row) => row.threadId !== threadId).length,
      run: run === null ? null : runDto(run),
    };
  }

  feed(threadId: string, children: boolean): FeedDto {
    const rows = this.store.flaresFor(threadId, { limit: FEED_LIMIT + 1, children });
    const flares = rows.slice(0, FEED_LIMIT);
    // The thread's own runs that these flares span, so a busy thread's older flares still sit under their turn.
    const oldest = flares.at(-1)?.createdAt ?? this.now();
    const companion = this.store.companionOf(threadId);
    const drawn = companion === null ? new Set<string>() : this.store.shownAmong(threadId, flares.map((row) => row.id));
    return {
      flares: flares.map((row) => flareDto(row, threadId, drawn.has(row.id))),
      runs: this.store.runsSince(threadId, oldest).map(runDto),
      truncated: rows.length > FEED_LIMIT,
      companionThreadId: companion,
    };
  }

  /** The flares an agent reads back, newest first, as plain text. */
  list(threadId: string, options: { limit: number; children: boolean }): FlareRow[] {
    return this.store.flaresFor(threadId, { limit: options.limit, children: options.children });
  }

  dismiss(threadId: string, through: number): void {
    this.store.dismiss(threadId, through);
    this.invalidate([threadId]);
  }

  private invalidate(threadIds: readonly string[]): void {
    if (threadIds.length === 0) return;
    this.bb.rpc.experimental_invalidate([...new Set(threadIds)].map(threadTag));
  }

  private defer(work: () => Promise<void>): void {
    const task: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
      .then(work)
      .catch((error: unknown) => this.bb.log.warn(`Flare background work failed: ${message(error)}`))
      .finally(() => this.pending.delete(task));
    this.pending.add(task);
  }

  /** Resolves once every piece of background work has finished; for tests and disposal. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
    await this.companions?.settled();
  }
}
