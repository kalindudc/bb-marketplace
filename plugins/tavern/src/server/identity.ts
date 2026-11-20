import type { ThreadIdentity } from "../shared/identity";
import { memberName } from "../shared/member-name";
import type { Member } from "../shared/schema";
import { isNotFound } from "./host-errors";
import type { TavernRuntime } from "./runtime";

export function threadIdentities(runtime: TavernRuntime) {
  const member = (threadId: string) => runtime.keeper.member(threadId);
  const readThread = async (threadId: string) => {
    try { return await runtime.bb.sdk.threads.get({ threadId }); }
    catch (error) { return isNotFound(error) ? null : undefined; }
  };
  type ThreadRecord = Awaited<ReturnType<typeof readThread>>;
  const keeperId = (m: Member | null | undefined) => m?.role === "keeper" ? m.threadId : m?.keeperThreadId ?? null;

  async function identities(ids: readonly string[], viewerThreadId: string): Promise<ThreadIdentity[]> {
    if (!ids.length) return [];
    const pending = new Map<string, ReturnType<typeof readThread>>();
    const thread = (id: string) => {
      let found = pending.get(id);
      if (!found) { found = readThread(id); pending.set(id, found); }
      return found;
    };
    const registries = new Map<string | null, ReturnType<TavernRuntime["snapshot"]>>();
    const registry = (record: ThreadRecord) => {
      const project = record?.projectId ?? null;
      let found = registries.get(project);
      if (!found) { found = runtime.snapshot(project ?? undefined); registries.set(project, found); }
      return found;
    };
    const name = (m: Member | null | undefined, record: ThreadRecord) =>
      (m ? memberName(m, registry(record)) : record?.title?.trim()) || "a thread";
    const viewerKeeper = keeperId(member(viewerThreadId));
    return Promise.all([...new Set(ids)].map(async (threadId): Promise<ThreadIdentity> => {
      const m = member(threadId);
      const [record, viewer] = await Promise.all([thread(threadId), thread(viewerThreadId)]);
      const life = record === null || record?.deletedAt != null ? "deleted" : record?.archivedAt != null ? "archived" : "live";
      const parent = m?.role === "member" ? m.keeperThreadId : null;
      const keeper = parent ? { threadId: parent, name: name(member(parent), await thread(parent)), sameParty: parent === viewerKeeper } : null;
      const relation = record === undefined ? "other" : threadId === viewerThreadId ? "self"
        : threadId === viewerKeeper ? "this thread's Keeper"
        : record?.parentThreadId === viewerThreadId ? "child of this thread"
        : viewer?.parentThreadId === threadId ? "parent of this thread"
        : viewerKeeper && keeperId(m) === viewerKeeper ? "in this Keeper's party"
        : "other";
      return {
        threadId, name: name(m, record), role: m?.role ?? "thread", classId: m?.classId ?? null,
        className: m ? registry(record).classes.find(c => c.id === m.classId)?.label ?? m.classId : null,
        characterId: m?.characterId ?? null, keeper, relation, life, canOpen: life !== "deleted",
        ...(record?.projectId ? { projectId: record.projectId } : {}),
      };
    }));
  }
  async function identity(threadId: string, viewerThreadId: string): Promise<ThreadIdentity> {
    return (await identities([threadId], viewerThreadId))[0]!;
  }
  return { identity, identities };
}
