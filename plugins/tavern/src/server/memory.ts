import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import { createHostPort, type HostPort } from "../host/client";
import { memoryConfigInput, memoryCurateInput, memoryExternalCurate, memoryNote, type MemoryDraft, type MemoryFindQuery, type MemoryListInput, type MemoryManageInput, type MemoryNote, type MemoryProfile, type MemoryToolInput } from "../shared/memory";
import { memberIdentityFacts } from "../shared/identity";
import type { Actor, Member } from "../shared/schema";
import { isKeeperIdentity, isLiveKeeper, isLiveMember } from "./liveness";
import { memberHost } from "./member-engagement";
import { MemoryStore } from "./memory-store";
import { PlacementStore } from "./placement/store";
import type { TavernRuntime } from "./runtime";

const TAG = "tavern:memory";
const configTag = "tavern:memory-config";
const storeKey = (p: MemoryProfile | null) => p === null ? "builtin" : createHash("sha256").update(JSON.stringify([p.id, p.hostId, p.save, p.find, p.curate])).digest("hex");
const fields = ["save", "find", "curate"] as const;
const actorFor = (thread: string): Actor => ({ kind: "agent", threadId: thread });
const externalLimit = 20;

export class TavernMemory {
  readonly store: MemoryStore;
  private readonly flights = new Map<AbortController, boolean>();
  private readonly curations = new Set<string>();
  private readonly host: () => HostPort;
  constructor(private readonly runtime: TavernRuntime, connect = () => createHostPort(runtime.bb)) {
    this.store = new MemoryStore(runtime.keeper.store.db);
    this.host = connect;
  }
  cancel(writesOnly = false) {
    for (const [controller, writes] of this.flights) if (!writesOnly || writes) controller.abort();
  }
  private get k() { return this.runtime.keeper; }
  private active() {
    const { revision, config } = this.store.config();
    const profile = config.active === "builtin" ? null : config.profiles.find(p => p.id === config.active)!;
    return { revision, profile, key: storeKey(profile), id: config.active };
  }
  commandPaths() {
    const profile = this.active().profile;
    return profile ? fields.map(key => profile[key]) : [];
  }
  private assertAgentOpen(write: boolean) {
    this.runtime.stopAll.assertRunning();
    if (this.runtime.config().tavern.paused) throw new Error("Tavern is paused; memory commands are held.");
    if (write && this.runtime.away.cleanupHeld()) throw new Error("Tavern is closed; memory writes wait until you return.");
  }
  private caller(threadId: string, project: string, write: boolean, questId?: string) {
    this.assertAgentOpen(write);
    const member = this.k.member(threadId);
    const state = this.k.store.runtime(threadId);
    if (!member || state.projectId !== project) throw new Error("Memory needs your Tavern class and its bound project.");
    this.k.succession.assertMutable(threadId);
    const keeper = isKeeperIdentity(this.k.store, member);
    const host = memberHost(this.k.store, member);
    if (host.archivedAt != null || host.deletedAt != null || state.manualStopAt != null)
      throw new Error("This Tavern thread is not active.");
    if (keeper) this.k.require(threadId, "keeper");
    if (keeper ? !isLiveKeeper(this.k.store, member) : !isLiveMember(this.k.store, member))
      throw new Error("Only live Tavern classes can use memory.");
    if (member.role === "member") {
      const placement = new PlacementStore(this.k.store.db).byMember(threadId);
      if (placement && !["ready", "running"].includes(placement.phase)) throw new Error("Finish placement before using memory.");
      if (this.runtime.away.blocked(threadId) || this.runtime.scopes?.pending(threadId)) throw new Error("This member's work is held.");
    }
    if (!keeper && questId !== undefined && questId !== member.boardQuestId) throw new Error("A member can use memory only for its own assignment.");
    const quest = questId ?? member.boardQuestId;
    if (quest) {
      const owned = this.k.quest(quest);
      if (keeper && questId !== undefined && owned.keeperThreadId !== threadId) throw new Error("This quest belongs to another Keeper.");
      if (write && (owned.phase === "held" || owned.phase === "stopping" || owned.deletedAt != null)) throw new Error("This quest cannot change memory while held, stopping or deleted.");
    }
    return { member, keeper, quest };
  }
  private makeNote(note: MemoryDraft, member: Member, keeper: boolean, project: string, quest: string | null, supersedes: string | null = null, at = this.k.now()): MemoryNote {
    return memoryNote.parse({ ...note, id: randomUUID(), project, quest, author: { thread: member.threadId, classId: member.classId },
      curator: keeper ? member.threadId : member.keeperThreadId, status: "accepted", supersedes, memory: "included", exclusionReason: null,
      reviewedBy: keeper ? member.threadId : null, reviewedAt: keeper ? at : null, createdAt: at, updatedAt: at });
  }
  private event(actor: Actor, keeper: string | null, quest: string | null, action: string, data: Record<string, unknown>) {
    this.k.store.event(this.k.now(), keeper, quest, `memory.${action}`, `Memory ${action.replaceAll("-", " ")}.`,
      actor.kind === "user" ? { ...data, surface: "client (unattested)" } : data, actor);
  }
  private invalidate() { this.runtime.bb.rpc.experimental_invalidate([TAG]); }
  private async roots(hostId: string, signal: AbortSignal) {
    const { sdk } = this.runtime.bb;
    const [host, projects] = await Promise.all([sdk.hosts.get({ hostId, signal }), sdk.projects.list({ includePersonal: true, signal })]);
    const roots = new Set(projects.flatMap(project => project.sources.filter(source => source.hostId === hostId).map(source => source.path)));
    if (host.threadStorageRootPath) roots.add(host.threadStorageRootPath);
    for (let offset = 0; ; offset += 100) {
      const batch = await sdk.environments.list({ hostId, limit: 100, offset, signal });
      for (const env of batch) if (env.path) roots.add(env.path);
      if (batch.length < 100) break;
    }
    return [...roots];
  }
  private async flight<T>(write: boolean, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    const bound = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    bound.throwIfAborted();
    this.flights.set(controller, write);
    try { return await work(bound); }
    finally { this.flights.delete(controller); }
  }
  async configure(revision: number, input: z.infer<typeof memoryConfigInput>, signal?: AbortSignal) {
    input = memoryConfigInput.parse(input);
    const current = this.store.config();
    if (current.revision !== revision) throw new Error("Memory settings changed. Reload them before saving.");
    const old = new Map(current.config.profiles.map(p => [p.id, p]));
    const changed = input.profiles.filter(p => {
      const previous = old.get(p.id);
      return !previous || previous.timeoutSeconds !== p.timeoutSeconds || fields.some(key => previous[key] !== p[key]);
    });
    const checked = new Map<string, MemoryProfile>();
    if (changed.length || input.active !== "builtin") {
      await this.flight(false, signal, async bound => {
        const hostId = (await this.runtime.bb.sdk.system.config({ signal: bound })).primaryHostId;
        if (!hostId) throw new Error("bb has no primary host for memory commands.");
        const active = old.get(input.active);
        const reapprove = active && (active.hostId !== hostId || input.active !== current.config.active);
        const checks = reapprove && !changed.some(p => p.id === active.id)
          ? [...changed, input.profiles.find(p => p.id === active.id)!] : changed;
        if (!checks.length) return;
        this.runtime.stopAll.assertRunning();
        const blockedRoots = await this.roots(hostId, bound);
        for (const p of checks) {
          bound.throwIfAborted();
          this.runtime.stopAll.assertRunning();
          const { save, find, curate, timeoutSeconds } = p;
          const paths = await this.host().call(hostId, "memoryPreflight", { save, find, curate, timeoutSeconds, blockedRoots }, { signal: bound });
          checked.set(p.id, { ...p, ...paths, hostId });
        }
        bound.throwIfAborted();
      });
    }
    signal?.throwIfAborted();
    if (checked.size || input.active !== "builtin" && input.active !== current.config.active) this.runtime.stopAll.assertRunning();
    const profiles = input.profiles.map(p => checked.get(p.id) ?? { ...old.get(p.id)!, name: p.name });
    this.k.store.atomic(() => {
      this.store.configure(revision, { active: input.active, profiles });
      this.event({ kind: "user" }, null, null, "settings-changed", { store: input.active, profiles: profiles.map(p => p.id), revision: revision + 1 });
    });
    this.cancel();
    this.runtime.scopes?.refreshMemoryGuards();
    this.runtime.bb.rpc.experimental_invalidate([TAG, configTag]);
    return this.store.settingsView();
  }
  private async external<T>(active: ReturnType<TavernMemory["active"]>, operation: "save" | "find" | "curate", input: unknown, actor: Actor,
    project: string, keeper: string | null, quest: string | null, signal: AbortSignal | undefined, assertCurrent: () => unknown, decode: (output: string) => T, noteId?: string) {
    const p = active.profile!, call = randomUUID(), write = operation !== "find";
    const data = { call, operation, noteId, store: active.id, project, host: p.hostId, revision: active.revision };
    return this.flight(write && actor.kind === "agent", signal, async bound => {
      let code = "unavailable", launched = false;
      this.event(actor, keeper, quest, "started", data);
      try {
        const config = await this.runtime.bb.sdk.system.config({ signal: bound });
        if (config.primaryHostId !== p.hostId) throw new Error("The primary host changed. Recheck the memory profile in Settings.");
        const blockedRoots = await this.roots(p.hostId, bound);
        bound.throwIfAborted();
        this.runtime.stopAll.assertRunning();
        assertCurrent();
        if (this.store.config().revision !== active.revision) throw new Error("Memory settings changed before the command started.");
        launched = true;
        const result = await this.host().call(p.hostId, "memoryRun", { path: p[operation], blockedRoots, timeoutSeconds: p.timeoutSeconds, op: operation, content: JSON.stringify(input) }, { signal: bound });
        bound.throwIfAborted();
        if (result.outcome === "failed") { code = result.code; throw new Error(result.message); }
        code = "contract";
        const value = decode(result.output);
        this.event(actor, keeper, quest, "finished", { ...data, outcome: "ok", ...(write ? { reference: result.output } : {}) });
        return value;
      } catch (error) {
        this.event(actor, keeper, quest, "finished", { ...data, outcome: bound.aborted ? "cancelled" : code });
        const message = bound.aborted ? "Memory call cancelled." : error instanceof Error ? error.message : "The memory call failed.";
        throw new Error(`${message} Call ${call}.${write && launched ? " Check the external store before retrying; it may already have changed." : ""}`);
      }
    });
  }
  private findExternal(active: ReturnType<TavernMemory["active"]>, query: MemoryFindQuery, actor: Actor, keeper: string | null, signal?: AbortSignal, guard = () => {}) {
    return this.external(active, "find", query, actor, query.project, keeper, null, signal, guard, output => {
      if (!output) return [];
      const lines = output.split(/\r?\n/);
      if (lines.length > query.limit) throw new Error("The memory profile exceeded the requested result limit.");
      const ids = new Set<string>();
      return lines.map(line => {
        let note: MemoryNote;
        try { note = memoryNote.parse(JSON.parse(line)); }
        catch { throw new Error("The memory profile returned a malformed note. Each line must contain one complete note."); }
        if (note.project !== query.project || query.kind !== null && note.kind !== query.kind || note.status !== "accepted" || note.memory !== "included" || ids.has(note.id))
          throw new Error("The memory profile returned a duplicate, excluded or unrelated note.");
        ids.add(note.id);
        return note;
      });
    });
  }
  private saveLocal(active: ReturnType<TavernMemory["active"]>, note: MemoryNote, reference: string | null, actor: Actor) {
    this.k.store.atomic(() => {
      this.store.save(active.key, note, reference);
      this.event(actor, note.curator, note.quest, "saved", { noteId: note.id, store: active.id, project: note.project, reference });
    });
    this.invalidate();
    return { note, reference };
  }
  unreviewedFor(threadId: string, offset = 0, limit = 6) {
    const project = this.k.store.runtime(threadId).projectId;
    return project ? this.store.unreviewed(this.active().key, project, offset, limit, threadId) : [];
  }
  async tool(input: MemoryToolInput, thread: string, project: string, signal: AbortSignal) {
    const write = input.op === "save" || input.op === "curate";
    const guard = () => this.caller(thread, project, write, input.op === "save" ? input.boardQuestId : undefined);
    signal.throwIfAborted();
    const { member, keeper, quest } = guard();
    const active = this.active(), actor = actorFor(thread);
    if (input.op === "find") {
      const query = { project, kind: input.kind ?? null, text: input.text ?? "", limit: input.limit ?? 5 };
      const offset = input.offset ?? 0;
      if (active.profile && offset) throw new Error("External memory does not support paging. Use a narrower search.");
      const { notes, more: matchesBeyondPage } = active.profile
        ? { notes: await this.findExternal(active, query, actor, keeper ? thread : member.keeperThreadId, signal, guard), more: false }
        : this.store.list(active.key, { ...query, status: "accepted", memory: "included", offset });
      const visible: MemoryNote[] = [];
      for (const note of notes) {
        if (JSON.stringify([...visible, note]).length > 17_000) break;
        visible.push(note);
      }
      const more = matchesBeyondPage || visible.length < notes.length;
      return { notes: visible, more, ...(more && !active.profile && visible.length ? { nextOffset: offset + visible.length } : {}) };
    }
    if (input.op === "save") {
      const note = this.makeNote(input.note, member, keeper, project, quest);
      const reference = active.profile ? await this.external(active, "save", note, actor, project, note.curator, quest, signal, guard, output => output, note.id) : null;
      return this.saveLocal(active, note, reference, actor);
    }
    if (!keeper) throw new Error("Only a Keeper can curate memory.");
    if (input.op === "unreviewed") return { notes: this.unreviewedFor(thread, input.offset) };
    if (input.op === "read") {
      const current = this.store.get(active.key, input.id);
      if (!current || current.note.project !== project && current.note.curator !== thread) throw new Error("No matching note in your project or assignments.");
      return { note: current.note };
    }
    const { op: _, ...request } = input;
    return { note: await this.curate(memoryCurateInput.parse(request), actor, member, project, signal, guard) };
  }
  private async curate(input: MemoryManageInput, actor: Actor, member: Member | null, project: string | null, signal?: AbortSignal, guard = () => {}) {
    const active = this.active(), current = this.store.get(active.key, input.id);
    if (!current || project !== null && current.note.project !== project && current.note.curator !== member?.threadId)
      throw new Error("No matching note in your project or assignments for this store.");
    const old = current.note;
    if (old.updatedAt !== input.expectedUpdatedAt || old.status !== "accepted") throw new Error("The note changed or is no longer current. Reload it before curating.");
    if (member && old.quest && this.k.store.get("quests", old.quest)?.phase === "held") throw new Error("This quest is held; memory writes wait until it resumes.");
    if (this.curations.has(old.id)) throw new Error("This note is already being curated.");
    if (!member && active.profile && input.action !== "include" && input.action !== "exclude")
      throw new Error("Edit, supersede or retire external notes in their configured tool.");
    if (active.profile && (input.action === "retire" || input.action === "edit" || !current.reference)) throw new Error("This action needs the built-in store or a reference recorded by Tavern.");
    const at = Math.max(this.k.now(), old.updatedAt + 1);
    const reviewer = member?.threadId ?? null;
    const updated: MemoryNote = {
      ...(input.action === "edit" ? { ...old, ...input.note } : old), updatedAt: at,
      reviewedBy: reviewer ?? old.reviewedBy, reviewedAt: reviewer ? at : old.reviewedAt,
      status: input.action === "supersede" ? "superseded" : input.action === "retire" ? "retired" : old.status,
      ...(input.action === "exclude" ? { memory: "excluded", exclusionReason: input.reason } : input.action === "include" ? { memory: "included", exclusionReason: null } : {}),
    };
    const replacement = input.action === "supersede"
      ? member ? this.makeNote(input.note, member, true, old.project, old.quest, old.id, at)
        : memoryNote.parse({ ...old, ...input.note, id: randomUUID(), status: "accepted", supersedes: old.id, memory: "included", exclusionReason: null, reviewedAt: null, reviewedBy: null, createdAt: at, updatedAt: at })
      : null;
    this.curations.add(old.id);
    try {
      let reference: string | null = null;
      if (active.profile) {
        const request = memoryExternalCurate.parse({ action: input.action, note: updated, reference: current.reference, replacement });
        reference = await this.external(active, "curate", request, actor, old.project, old.curator, old.quest, signal, guard, output => {
          if (input.action !== "supersede" && output !== current.reference) throw new Error("Curation returned a different note reference.");
          return output;
        }, old.id);
      }
      this.k.store.atomic(() => {
        this.store.update(active.key, updated, old.updatedAt);
        if (replacement) this.store.save(active.key, replacement, reference);
        this.event(actor, old.curator, old.quest, "curated", { action: input.action, store: active.id, project: old.project, noteId: old.id,
          replacementId: replacement?.id, ...(input.action === "exclude" ? { reason: input.reason } : {}) });
      });
    } finally { this.curations.delete(old.id); }
    this.invalidate();
    return replacement ?? updated;
  }
  async list(input: MemoryListInput, signal?: AbortSignal) {
    const active = this.active(), base = { store: active.profile?.name ?? "Built-in", external: active.profile !== null, unreviewed: this.store.unreviewed(active.key, input.project) };
    const { project, text, kind, limit } = input;
    const decorate = (result: { notes: MemoryNote[]; more: boolean; recorded?: boolean }) => {
      const actors = new Set(result.notes.flatMap(note => [note.author.thread, note.reviewedBy]).concat(base.unreviewed.map(row => row.author)));
      const registries = new Map<string, ReturnType<TavernRuntime["snapshot"]>>();
      const people = Object.fromEntries([...actors].flatMap(thread => {
        const member = thread && this.k.member(thread);
        if (!member) return [];
        const memberProject = this.k.store.runtime(member.threadId).projectId ?? project;
        let registry = registries.get(memberProject);
        if (!registry) { registry = this.runtime.snapshot(memberProject); registries.set(memberProject, registry); }
        const { name, className } = memberIdentityFacts(member, registry);
        return [[member.threadId, name === className ? name : `${name} (${className})`]];
      }));
      const previousTitles = this.store.titles(active.key, project, result.notes.flatMap(note => note.supersedes ? [note.supersedes] : []));
      return { ...base, ...result, people, previousTitles };
    };
    if (!active.profile) return decorate(this.store.list(active.key, input));
    if (input.status && input.status !== "accepted" || input.memory === "excluded")
      return decorate({ ...this.store.list(active.key, input), recorded: true });
    this.runtime.stopAll.assertRunning();
    const notes = await this.findExternal(active, { project, text, kind, limit: Math.min(externalLimit, limit) }, { kind: "user" }, null, signal);
    return decorate({ notes, more: false });
  }
  previous(project: string, id: string) {
    const note = this.store.get(this.active().key, id)?.note;
    return note?.project === project ? note : null;
  }
  manage(input: MemoryManageInput, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.runtime.stopAll.assertRunning();
    return this.curate(input, { kind: "user" }, null, null, signal);
  }
}
