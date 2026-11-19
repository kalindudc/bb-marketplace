import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, type HostOutput } from "../host-contract";
import { BLOCK_MARKER, blocked, evaluate, type Decision, type ScopeCall } from "./engine";
import { scopeObservationBindingSchema, ScopeStore, type ScopeObservationBinding, type ScopeObservationHold, type ScopeRecord, type Violation } from "./store";
import type { ScopeHostBinding } from "./schema";
import { prepareCall } from "./prepare";
import { bindChecks } from "./checker";
import { bindWorktree, checkedWorktreeRoot, gitWorktreeRoot, needsWorktree, readerFallback } from "./worktree";

export type RemoteScopeObservation = { kind: "unavailable"; reason: string } | { kind: "open"; reason: string } | {
  kind: "ready"; hostId: string; cwd: string; binding: ScopeHostBinding;
  prepare(call: ScopeCall): Promise<HostOutput<"prepareCall">>;
};
export interface WatchDeps {
  onViolation(violation: Violation, binding?: ScopeObservationBinding): void | Promise<void>;
  cwdForThread?(threadId: string): string | undefined;
  remoteForThread?(threadId: string): RemoteScopeObservation | undefined;
  onObservationHold?(hold: ScopeObservationHold): void | Promise<void>;
}
type Item = Record<string, unknown>;
const emergency = new Set(["tavern_report", "journal", "quest", "tavern_ready"]);
const identity = (value: Extract<RemoteScopeObservation, { kind: "ready" }>): ScopeObservationBinding => scopeObservationBindingSchema.parse({ ...value.binding, hostId: value.hostId, cwd: value.cwd });
const sameBinding = (a: ScopeObservationBinding, b: ScopeObservationBinding) => a.placementId === b.placementId && a.generation === b.generation && a.endpointId === b.endpointId && a.revision === b.revision && a.scopeDigest === b.scopeDigest && a.hostId === b.hostId && a.cwd === b.cwd;
export function callsFromItem(item: Item, fallbackCwd: string): ScopeCall[] {
  const cwd = typeof item.cwd === "string" ? item.cwd : fallbackCwd;
  if (item.type === "commandExecution") return [{ kind: "bash", toolName: "bash", input: { command: item.command }, cwd }];
  if (item.type === "fileRead") return [{ kind: "read", toolName: "read", input: { path: item.path }, cwd }];
  if (item.type === "fileChange") return Array.isArray(item.changes) ? item.changes.flatMap(change => {
    const value = change as Record<string, unknown>;
    return [value.path, value.movePath].filter(path => typeof path === "string").map(path => ({ kind: "write" as const, toolName: "write", input: { path }, cwd }));
  }) : [{ kind: "write", toolName: "write", input: {}, cwd }];
  if (item.type === "toolCall") {
    const bare = String(item.tool);
    const server = typeof item.server === "string" ? item.server : undefined;
    const native = ["bb", "workspace", "bb_workspace", "bb-workspace", "bb_tools"].includes(server ?? "");
    const toolName = server && !native && !bare.startsWith("mcp__") ? "mcp__" + server + "__" + bare : bare;
    return [{ kind: "tool", toolName, input: item.arguments && typeof item.arguments === "object" ? item.arguments as Record<string, unknown> : {}, cwd }];
  }
  if (item.type === "webFetch" || item.type === "webSearch") return [{ kind: "tool", toolName: item.type === "webFetch" ? "web_fetch" : "web_search", input: item, cwd }];
  if (item.type === "delegation") return [{ kind: "tool", toolName: "spawn", input: item, cwd }];
  return [];
}
function guardBlocked(item: Item): boolean {
  const results = [item.result, item.resultText, item.aggregatedOutput, item.error];
  if (results.some(value => value !== undefined && JSON.stringify(value).includes(BLOCK_MARKER))) return true;
  if (item.status !== "failed") return false;
  const texts = results.flatMap(value => {
    if (typeof value === "string") return [value];
    if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content)) return [];
    return value.content.flatMap(block => block && typeof block === "object" && "text" in block && typeof block.text === "string" ? [block.text] : []);
  });
  return texts.some(text => text === "Blocked by user" || text === "Tool execution was blocked" || /^\[(?:CRITICAL|HIGH)\] Command blocked (?:automatically|in non-interactive mode)(?:\r?\n|$)/.test(text));
}
export function registerWatcher(bb: BbPluginApi, store: ScopeStore, deps: WatchDeps): void {
  const pending = new Map<string, Promise<void>>();
  const stopped = new Map<string, { record: ScopeRecord; binding?: ScopeObservationBinding }>();
  const starts = new Map<string, Map<string, number>>();
  const worktrees = new Map<string, { root: string; record: ScopeRecord }>();
  let disposed = false;
  const modeFor = (threadId: string) => store.records.get(threadId)?.mode ?? store.records.get(threadId)?.scope?.mode ?? "enforce";
  const lookup = (threadId: string): RemoteScopeObservation | undefined => {
    try {
      const value = deps.remoteForThread?.(threadId);
      if (value === undefined) {
        const record = store.records.get(threadId);
        if (record?.binding?.placementId === null && record.scope?.preset === "open" && !record.error)
          return { kind: "open", reason: "Remote open scope; tool observation is not available" };
        return record?.binding ? { kind: "unavailable", reason: "Host-bound scope observation is not configured; reconcile the host binding without controller-local probes" } : undefined;
      }
      if (value.kind === "unavailable") return value;
      if (value.kind === "open") {
        const record = store.records.get(threadId);
        if (!record?.binding || record.binding.placementId !== null || record.scope?.preset !== "open" || record.error)
          throw new Error("Only an unplaced remote open scope can skip host observation");
        return value;
      }
      if (value.kind !== "ready" || typeof value.prepare !== "function") throw new Error("Invalid remote scope descriptor");
      identity(value);
      return value;
    } catch { return { kind: "unavailable", reason: "The remote scope lookup is unavailable; ask the Keeper to reconcile placement before inspecting this pending event." }; }
  };
  const hold = async (threadId: string, providerId: string, eventId: string, seq: number, reason: string, binding?: ScopeObservationBinding) => {
    if (disposed || !store.records.has(threadId) || modeFor(threadId) === "off") return;
    let previous: ScopeObservationHold | null = null;
    try { previous = store.observationHold(threadId); }
    catch (error) { bb.log.warn("Tavern observation hold was unreadable; replacing the diagnostic: " + String(error)); }
    const boundedReason = reason.slice(0, 16384);
    if (previous?.eventId === eventId && previous.seq === seq && previous.reason === boundedReason && (previous.binding === undefined && binding === undefined || previous.binding && binding && sameBinding(previous.binding, binding))) return;
    const value: ScopeObservationHold = { threadId, providerId, eventId, seq, at: Date.now(), reason: boundedReason, ...(binding ? { binding } : {}) };
    store.saveObservationHold(value);
    if (modeFor(threadId) === "enforce") {
      try { await deps.onObservationHold?.(value); }
      catch (error) { bb.log.warn("Tavern scope observation notification failed: " + String(error)); }
    }
  };
  const contain = async (threadId: string, providerId: string, eventId: string, seq: number, createdAt: number, decision: Decision, call?: ScopeCall, binding?: ScopeObservationBinding): Promise<Violation | undefined> => {
    if (decision.allow) return;
    const record = store.records.get(threadId), mode = modeFor(threadId);
    if (!record || mode === "off") return;
    let stopError: string | undefined;
    if (mode === "enforce") {
      try { await bb.sdk.threads.stop({ threadId }); stopped.set(threadId, { record, ...(binding ? { binding } : {}) }); }
      catch (error) { stopError = String(error); }
    }
    if (store.records.has(threadId)) store.saveProgress(threadId, seq, !!stopError, binding);
    const at = Date.now();
    const violation: Violation = { threadId, providerId, at, eventId, seq, ruleId: decision.ruleId, reason: decision.reason, call, mode, stopped: mode === "enforce" && !stopError, stopError, latencyMs: Math.max(0, at - createdAt) };
    store.record(violation);
    if (mode === "enforce") {
      try { await deps.onViolation(violation, binding); }
      catch (error) { bb.log.warn("Tavern scope notification failed: " + String(error)); }
    }
    return violation;
  };
  const check = async (threadId: string, providerId: string, sequence: number) => {
    if (disposed || !store.records.has(threadId) || modeFor(threadId) === "off") return;
    if (lookup(threadId)?.kind === "open") {
      stopped.delete(threadId);
      store.saveProgress(threadId, sequence, false);
      store.clearObservationHold(threadId);
      return;
    }
    const stoppedAt = stopped.get(threadId);
    if (stoppedAt?.record !== store.records.get(threadId)) stopped.delete(threadId);
    else if (stoppedAt) {
      if (!stoppedAt.binding) return;
      const remote = lookup(threadId);
      if (remote?.kind === "unavailable") { await hold(threadId, providerId, "stopped:" + sequence, sequence, remote.reason, stoppedAt.binding); return; }
      if (remote?.kind === "ready" && sameBinding(identity(remote), stoppedAt.binding)) return;
      stopped.delete(threadId);
    }
    let progress;
    try { progress = store.progress(threadId); }
    catch (error) {
      const remote = lookup(threadId);
      if (remote !== undefined) await hold(threadId, providerId, "cursor:" + sequence, sequence, "The event cursor is unreadable; ask the Keeper to reconcile it without guessing which remote events ran.", remote.kind === "ready" ? identity(remote) : undefined);
      else await contain(threadId, providerId, "cursor:" + sequence, sequence, Date.now(), blocked("scope cursor", "cursor-invalid", "the persisted event cursor is invalid: " + String(error)));
      return;
    }
    if (progress.pendingStop && modeFor(threadId) === "enforce") {
      const remote = lookup(threadId);
      if (remote?.kind === "unavailable") { await hold(threadId, providerId, "stop:" + progress.cursor, progress.cursor, remote.reason, progress.pendingBinding); return; }
      if (progress.pendingBinding && (remote?.kind !== "ready" || !sameBinding(identity(remote), progress.pendingBinding))) store.saveProgress(threadId, progress.cursor, false);
      else if (remote?.kind === "ready" && !progress.pendingBinding) {
        await hold(threadId, providerId, "stop:" + progress.cursor, progress.cursor, "The previous stop has no checked remote assignment; ask the Keeper to reconcile it rather than stopping a replacement.", identity(remote)); return;
      } else {
        try {
          await bb.sdk.threads.stop({ threadId }); store.saveProgress(threadId, progress.cursor, false);
          const record = store.records.get(threadId); if (record) stopped.set(threadId, { record, ...(progress.pendingBinding ? { binding: progress.pendingBinding } : {}) });
          store.clearObservationHold(threadId); return;
        } catch (error) {
          bb.log.warn("Tavern scope stop retry failed: " + String(error));
          if (remote?.kind === "ready") { await hold(threadId, providerId, "stop:" + progress.cursor, progress.cursor, "The known remote violation could not be stopped; ask the Keeper to reconcile the pending stop.", identity(remote)); return; }
        }
      }
    }
    let cursor = progress.cursor;
    if (sequence <= cursor) return;
    for (let page = 0; page < 3; page++) {
      const rows = await bb.sdk.threads.events.list({ threadId, afterSeq: String(cursor), types: ["item/started", "item/completed"], order: "asc", limit: "100" }).catch(async error => {
        const remote = lookup(threadId);
        if (remote === undefined) throw error;
        await hold(threadId, providerId, "events:" + sequence, sequence, "The thread event stream is unavailable; reconnect it before inspecting pending remote calls.", remote.kind === "ready" ? identity(remote) : undefined);
        return null;
      });
      if (rows === null || disposed || !store.records.has(threadId)) return;
      const record = store.records.get(threadId)!;
      for (const row of rows) {
        if (row.seq <= cursor) continue;
        const item = (row.data as unknown as { item?: Item }).item;
        const advance = (persist = true) => {
          cursor = row.seq;
          if (persist) store.saveProgress(threadId, cursor);
          if (row.type === "item/completed" && typeof item?.id === "string") starts.get(threadId)?.delete(item.id);
          const held = store.observationHold(threadId); if (held && held.seq <= cursor) store.clearObservationHold(threadId);
        };
        if (record.scope && row.createdAt < record.scope.issuedAt || !item || item.approvalStatus === "denied" || item.status === "denied" || item.status === "blocked") { advance(); continue; }
        let beganAt = row.createdAt;
        if (typeof item.id === "string") {
          const times = starts.get(threadId) ?? new Map<string, number>(); starts.set(threadId, times);
          if (row.type === "item/started") times.set(item.id, row.createdAt); else beganAt = times.get(item.id) ?? row.createdAt;
        }
        if (record.scope?.enforceFrom !== undefined && beganAt < record.scope.enforceFrom) { advance(); continue; }
        const rawCalls = callsFromItem(item, "");
        if (!rawCalls.length || rawCalls.every(call => emergency.has(call.toolName)) || providerId === "pi" && row.type === "item/completed" && guardBlocked(item)) { advance(); continue; }
        const remote = lookup(threadId);
        if (remote?.kind === "unavailable") { await hold(threadId, providerId, row.id, row.seq, remote.reason); return; }
        if (remote?.kind === "open") { advance(); continue; }
        if (remote?.kind === "ready") {
          if (providerId === "pi" ? row.type !== "item/completed" : row.type !== "item/started") { advance(); continue; }
          const expected = identity(remote);
          let violation: Violation | undefined;
          for (const rawCall of rawCalls) {
            const before = lookup(threadId);
            if (before?.kind !== "ready" || !sameBinding(identity(before), expected)) { await hold(threadId, providerId, row.id, row.seq, "The remote assignment changed before inspection; keep the event pending until the Keeper reconciles its current binding.", expected); return; }
            let reply: HostOutput<"prepareCall">;
            try { reply = hostContract.prepareCall.output.parse(await before.prepare({ ...rawCall, cwd: rawCall.cwd || before.cwd })); }
            catch { await hold(threadId, providerId, row.id, row.seq, "Remote scope inspection is unavailable or returned an invalid reply; reconnect or update the host worker before retrying this event.", expected); return; }
            const after = lookup(threadId);
            if (disposed || store.records.get(threadId) !== record || after?.kind !== "ready" || !sameBinding(identity(after), expected) || reply.scopeRevision !== expected.revision || reply.scopeDigest !== expected.scopeDigest) {
              await hold(threadId, providerId, row.id, row.seq, "The remote scope or assignment changed during inspection; keep this event pending and ask the Keeper to reconcile its current binding.", expected); return;
            }
            if (reply.decision.allow) for (const act of reply.decision.acts ?? []) store.recordAct({ threadId, providerId, at: Date.now(), eventId: row.id, seq: row.seq, kind: act.kind, call: reply.call, mode: modeFor(threadId) === "watch" ? "watch" : "enforce" });
            if (!reply.decision.allow) { violation = await contain(threadId, providerId, row.id, row.seq, row.createdAt, reply.decision, reply.call, expected); break; }
          }
          if (violation) { advance(false); if (violation.mode === "enforce") return; }
          else advance();
          continue;
        }
        advance();
        const calls = callsFromItem(item, deps.cwdForThread?.(threadId) ?? process.cwd());
        if (providerId === "pi") {
          if (modeFor(threadId) === "enforce" && !store.isArmed(threadId)) {
            await contain(threadId, providerId, row.id, row.seq, row.createdAt, blocked("tool call", "guard-not-loaded", "guard not loaded; restart pi after repairing Tavern's guard"));
            if (stopped.has(threadId)) break;
            continue;
          }
          if (row.type !== "item/completed") continue;
        } else if (row.type !== "item/started") continue;
        let scope = record.error ? null : record.scope;
        if (!scope) { await contain(threadId, providerId, row.id, row.seq, row.createdAt, blocked("tool call", "scope-invalid", "the scope file is invalid")); continue; }
        if (needsWorktree(scope) || scope.writes.mode === "worktree") {
          try {
            const cached = worktrees.get(threadId); let root = cached?.record === record ? cached.root : undefined;
            if (!root) {
              const thread = await bb.sdk.threads.get({ threadId }); if (!thread.environmentId) throw new Error("The thread has no provisioned environment");
              const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
              if (!environment.path || !environment.isWorktree && scope.workspaceKind !== "dedicated-machine") throw new Error("A linked worktree environment is required");
              root = checkedWorktreeRoot(environment.path);
              if (gitWorktreeRoot(root, scope.workspaceKind) !== root) throw new Error("The environment path is not its linked worktree root");
              if (disposed || store.records.get(threadId) !== record) return;
              worktrees.set(threadId, { root, record });
            }
            scope = bindWorktree(scope, root);
            for (const call of calls) if (typeof item.cwd !== "string") call.cwd = root;
          } catch (error) {
            if (needsWorktree(scope) && !record.binding) scope = readerFallback(scope);
            else {
              await contain(threadId, providerId, row.id, row.seq, row.createdAt, blocked("tool call", "worktree-unresolved", "the provisioned worktree could not be resolved: " + String(error)));
              if (stopped.has(threadId)) break;
              continue;
            }
          }
        }
        for (const call of calls) {
          let decision: Decision;
          try {
            scope = bindChecks(scope);
            const local = { ...call, containment: providerId === "pi" && process.platform === "darwin" && scope.sandbox ? "sandbox" as const : undefined };
            decision = evaluate(scope, prepareCall(local, { scope }));
          }
          catch (error) { decision = blocked(call.toolName, "path-unresolved", "the call paths could not be resolved: " + String(error)); }
          if (!decision.allow) { await contain(threadId, providerId, row.id, row.seq, row.createdAt, decision, call); break; }
          for (const act of decision.acts ?? []) store.recordAct({ threadId, providerId, at: Date.now(), eventId: row.id, seq: row.seq, kind: act.kind, call, mode: modeFor(threadId) === "watch" ? "watch" : "enforce" });
        }
        if (stopped.has(threadId)) break;
      }
      if (stopped.has(threadId) || rows.length < 100 || cursor >= sequence) return;
    }
  };
  bb.events.on("experimental_thread.events", ({ thread, sequence }) => {
    if (disposed || !store.records.has(thread.id) || modeFor(thread.id) === "off") return;
    if (modeFor(thread.id) !== "enforce") stopped.delete(thread.id);
    const previous = pending.get(thread.id) ?? Promise.resolve();
    const work = previous.then(() => check(thread.id, thread.providerId, sequence)).catch(error => { bb.log.warn(`Tavern scope watcher failed for ${thread.id}: ${String(error)}`); });
    pending.set(thread.id, work);
    return work.finally(() => { if (pending.get(thread.id) === work) pending.delete(thread.id); });
  });
  bb.events.on("thread.active", ({ thread }) => { stopped.delete(thread.id); });
  bb.events.on("thread.archived", ({ thread }) => { stopped.delete(thread.id); worktrees.delete(thread.id); });
  bb.events.on("thread.deleted", ({ thread }) => {
    stopped.delete(thread.id); worktrees.delete(thread.id); starts.delete(thread.id);
    if (store.records.has(thread.id)) store.clear(thread.id);
  });
  bb.onDispose(() => { disposed = true; stopped.clear(); worktrees.clear(); starts.clear(); });
}
