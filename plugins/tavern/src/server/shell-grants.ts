import type { Ask } from "../shared/schema";
import { shellCommunication } from "../scope/shell-communication";
import { scopeForClass } from "../scope/presets";
import { shellGrantSchema, type ShellGrant } from "../shared/shell-grant";
import type { KeeperStore } from "./keeper/store";
import { isLiveMember, isOpenQuest } from "./liveness";

type EndState = Exclude<ShellGrant["state"], "issued">;

export function issueShellGrant(store: KeeperStore, ask: Ask, scope: ShellGrant["scope"], by: ShellGrant["by"], at: number) {
  const effect = ask.effect;
  if (effect?.type !== "grant-shell-act" || !ask.boardQuestId) throw new Error("A shell grant needs an active quest and its exact target.");
  const { command, cwd } = effect.target;
  if (effect.target.act === "send" && shellCommunication(scopeForClass("keeper"), { kind: "bash", toolName: "bash", input: { command }, cwd }))
    throw new Error("Sending as you cannot be covered by a shell grant.");
  const member = store.get("members", effect.memberThreadId), quest = store.get("quests", ask.boardQuestId);
  if (!isOpenQuest(quest) || quest.phase === "held" || quest.keeperThreadId !== ask.keeperThreadId || !isLiveMember(store, member) || member.keeperThreadId !== ask.keeperThreadId || member.boardQuestId !== quest.id)
    throw new Error("The member is no longer available for this shell grant.");
  if (effect.heldEventId) {
    const hold = store.get("scopeActObservations", effect.heldEventId);
    if (!hold?.preflight || hold.resolvedAt !== undefined || hold.threadId !== member.threadId || hold.boardQuestId !== quest.id || hold.keeperThreadId !== ask.keeperThreadId)
      throw new Error("The held shell act is no longer open.");
  }
  if (store.get("shellGrants", ask.id)) throw new Error("This ask already issued a shell grant.");
  if (store.issuedShellGrants("memberThreadId", member.threadId).length >= 100) throw new Error("Revoke an open shell grant before granting another.");
  const grant = shellGrantSchema.parse({ id: ask.id, memberThreadId: member.threadId, keeperThreadId: ask.keeperThreadId, boardQuestId: quest.id, target: effect.target, scope, state: "issued", by, issuedAt: at, changedAt: at });
  store.put("shellGrants", grant.id, grant);
  store.event(at, ask.keeperThreadId, quest.id, "grant.issued", `Granted ${grant.target.act} ${scope === "once" ? "once" : "for this quest"}.`, { grantId: grant.id, memberThreadId: member.threadId, act: grant.target.act, scope }, by === "user" ? { kind: "user" } : { kind: "agent", threadId: ask.keeperThreadId });
  return grant;
}

export function settleShellGrant(store: KeeperStore, id: string, to: EndState, at: number, why: string) {
  return store.atomic(() => {
    const grant = store.get("shellGrants", id);
    if (!grant || grant.state !== "issued" || to === "used" && grant.scope !== "once") return;
    store.put("shellGrants", id, { ...grant, state: to, changedAt: at });
    store.event(at, grant.keeperThreadId, grant.boardQuestId, `grant.${to}`, why, { grantId: id, memberThreadId: grant.memberThreadId, act: grant.target.act }, to === "revoked" ? { kind: "user" } : { kind: "tavern" });
  });
}
