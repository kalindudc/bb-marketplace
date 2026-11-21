import { z } from "zod";
import type { Actor, Member } from "./schema";
import { memberName } from "./member-name";

export const IDENTITY_PAGE_SIZE = 50;
export const isThreadId = (id: string) => id.startsWith("thr_");
export const threadIdentitySchema = z.object({
  threadId: z.string(),
  name: z.string(),
  role: z.enum(["keeper", "member", "solo", "thread"]),
  classId: z.string().nullable(),
  className: z.string().nullable(),
  characterId: z.string().nullable(),
  projectId: z.string().optional(),
  keeper: z.object({ threadId: z.string(), name: z.string(), sameParty: z.boolean() }).nullable(),
  relation: z.enum(["self", "child of this thread", "parent of this thread", "this thread's Keeper", "in this Keeper's party", "other"]),
  life: z.enum(["live", "archived", "deleted"]),
  canOpen: z.boolean(),
});
export type ThreadIdentity = z.infer<typeof threadIdentitySchema>;
type IdentityWords = Pick<ThreadIdentity, "name" | "role" | "className" | "keeper"> & Partial<Pick<ThreadIdentity, "life" | "relation">>;
type Names = Parameters<typeof memberName>[1];

export function memberIdentityFacts(member: Member, registry: Names, keeper: ThreadIdentity["keeper"] = null) {
  return { name: memberName(member, registry), role: member.role, className: registry.classes.find(c => c.id === member.classId)?.label ?? member.classId, keeper };
}

export function memberIdentityLabel(member: Member, registry: Names, keeper?: Member) {
  return identityLabel({ kind: "agent", threadId: member.threadId }, memberIdentityFacts(member, registry, keeper && member.role === "member" ? {
    threadId: keeper.threadId, name: memberName(keeper, registry), sameParty: false,
  } : null));
}

export function memberKeeperIds(members: Iterable<Pick<Member, "role" | "keeperThreadId"> | undefined>) {
  const ids = new Set<string>();
  for (const member of members) {
    if (member?.role === "member" && member.keeperThreadId) ids.add(member.keeperThreadId);
  }
  return ids;
}

export function memberRoleLabel(identity: Pick<IdentityWords, "keeper" | "className">) {
  return identity.keeper ? `${identity.keeper.name}'s ${identity.className}` : identity.className;
}

export function identityLabel(
  actor: Actor | string | null,
  identity: IdentityWords | undefined,
  { mid = false, relation = false, short = false }: { mid?: boolean; relation?: boolean; short?: boolean } = {},
): string {
  if (actor === null) return mid ? "nobody" : "Unassigned";
  if (typeof actor !== "string") {
    if (actor.kind === "user") return mid ? "you" : "You";
    if (actor.kind === "tavern") return "Tavern";
    if (actor.kind === "import") return `${mid ? "imported" : "Imported"} from ${actor.from}`;
  }
  if (typeof actor === "string" && !isThreadId(actor)) return actor;
  if (!identity) return mid ? "a thread" : "A thread";
  if (identity.life === "deleted") return mid ? "a deleted thread" : "A deleted thread";

  let label = identity.name === "a thread" && !mid ? "A thread" : identity.name;
  if (identity.relation === "self" && identity.role === "thread") label = mid ? "this thread's agent" : "This thread's agent";
  else if (short && identity.role === "thread") label = label.split(" · ")[0]!.trim() || label;
  else if (!short && identity.keeper && !identity.keeper.sameParty && identity.className) {
    label += `, ${memberRoleLabel(identity)}`;
  }
  if (relation) {
    switch (identity.relation) {
      case "child of this thread":
      case "parent of this thread":
        label += `, a ${identity.relation}`; break;
      case "this thread's Keeper":
      case "in this Keeper's party":
        label += `, ${identity.relation}`; break;
    }
  }
  return identity.life === "archived" ? `${label} (archived)` : label;
}
