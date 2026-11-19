// @vitest-environment node
import { expect, it } from "vitest";
import { setup } from "./runtime-fixture";
import { seedQuest, planInput } from "./support";
import { QuestAuthority } from "../../src/server/quest-authority";
import { requireUserAct } from "../../src/server/authority";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights/index";
const client = { experimental_caller: { kind: "client" } } as never;
const receipt = () => requireUserAct(client, "delegateQuest");
const request = (q: string, kind: "merge" | "credential" = "credential") => ({ boardQuestId: q, kind, effect: { type: "decision" } as const, question: "Allow this act?", why: "Your authority", options: [{ id: "approve", label: "Approve", detail: "", recommended: false }, { id: "deny", label: "Deny", detail: "", recommended: false }], meanwhile: "Other work continues", holds: [] });
async function fixture() { const f = setup(); const q = await seedQuest(f.k, "lead", "Quest", "Quest"); const a = new QuestAuthority(f.k); return { ...f, q, a }; }
it("offers a third answer and routes later asks on this quest only", async () => {
  const f = await fixture(); const ask = f.k.ask("lead", request(f.q.id));
  expect(ask.options).toHaveLength(3);
  f.k.answerAsk(ask.id, "delegate", null, "page", "user", "client (unattested)", {}, receipt());
  expect(f.a.lane(f.k.store.get("asks", ask.id)!)).toBe("keeper");
  expect(f.a.lane(f.k.ask("lead", request(f.q.id)))).toBe("keeper");
  const other = await seedQuest(f.k, "lead", "Other", "Other");
  expect(f.a.lane(f.k.ask("lead", request(other.id)))).toBe("user");
});
it("revokes immediately and ends grants when a quest stops", async () => {
  const f = await fixture(); const grant = f.a.delegate(f.q.id, "credential", receipt());
  const ask = f.k.ask("lead", request(f.q.id));
  f.a.revoke(f.q.id, grant.id, requireUserAct(client, "revokeQuestAuthority"));
  expect(f.a.lane(ask)).toBe("user");
  f.a.delegate(f.q.id, "credential", receipt()); await f.runtime.stop(f.q.id);
  expect(f.k.quest(f.q.id).delegations?.every(g => g.endedAt !== null || g.revokedAt !== null)).toBe(true);
  expect(f.k.store.events().some(e => e.type === "delegation.ended")).toBe(true);
});
it("refuses a delegated merge without a Warden verdict and compares exact commits or clean patch identity", async () => {
  const f = await fixture(); f.a.delegate(f.q.id, "merge", receipt());
  const ask = f.k.ask("lead", { ...request(f.q.id, "merge"), target: { commit: "a".repeat(40) } });
  expect(() => f.a.assertVerdict(ask)).toThrow(/Warden/);
  expect(QuestAuthority.sameTarget({ commit: "a" }, { commit: "a" })).toBe(true);
  expect(QuestAuthority.sameTarget({ commit: "b", patchId: "p", cleanRebase: true }, { commit: "a", patchId: "p" })).toBe(true);
  expect(QuestAuthority.sameTarget({ commit: "b", patchId: "p" }, { commit: "a", patchId: "p" })).toBe(false);
  expect(QuestAuthority.sameTarget({ command: "deploy a" }, { command: "deploy b" })).toBe(false);
});
it("routes an unlisted merge without delegation but still requires the assigned Warden's exact verdict", async () => {
  const f = await fixture();
  const settings = new SettingsStore(f.k.store.db, f.time);
  f.runtime.enableSettings(settings, new InsightsReader(f.k.store.db, settings, f.time));
  settings.update({ revision: 0, patch: { keepers: { alwaysAsk: ["production", "credential", "sends-as-you", "destructive"] } }, why: "Keeper decides merge" });
  const input = { ...request(f.q.id, "merge"), target: { commit: "a".repeat(40) } };
  const ask = f.k.ask("lead", input);
  expect(ask.lane).toBe("keeper");
  expect(f.k.quest(f.q.id).delegations ?? []).toEqual([]);
  expect(() => f.k.decide("lead", { boardQuestId: f.q.id, askId: ask.id, optionId: "approve", source: "keeper", text: "Merge", why: "Safe", reversible: true })).toThrow(/Warden/);
  expect(f.k.ask("lead", { ...input, unsure: true }).lane).toBe("user");
  const decision = f.k.decide("lead", { boardQuestId: f.q.id, askId: ask.id, optionId: "deny", source: "keeper", text: "Do not merge", why: "Needs work", reversible: true });
  expect(f.k.store.get("asks", ask.id)?.answer).toMatchObject({ keeperAuthority: "keepers.alwaysAsk" });
  for (const type of ["ask.answered", "decision.made"]) {
    const event = f.k.store.events().find(e => e.type === type && e.data.askId === ask.id);
    expect(event?.data).toMatchObject({ keeperAuthority: "keepers.alwaysAsk" });
    expect(event?.data.delegation).toBeUndefined();
  }
  expect(decision.undone).toBe(false);
});
it("matches only fitting greenlights and records the pre-approval provenance", async () => {
  const f = await fixture(); f.a.preapprove(f.q.id, { greenlight: { maxMembers: 1, classes: ["smith"] }, placement: false, conclude: false, endsAt: null }, requireUserAct(client, "preapproveQuest"));
  f.k.plan("lead", { ...planInput(f.q.id), waypoints: planInput(f.q.id).waypoints.map(w => ({ ...w, acts: [{ kind: "workspace-write", path: "result.md" }] })), reversible: true, party: [{ classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] }] });
  const ask = f.k.store.query("asks", "boardQuestId", f.q.id)[0]!;
  expect(f.k.quest(f.q.id).greenlitVersion).toBe(1);
  expect(ask.answer).toMatchObject({ by: "preapproval", preapproval: { surface: "client (unattested)" } });
  const other = await seedQuest(f.k, "lead", "Other", "Other");
  f.a.preapprove(other.id, { greenlight: { maxMembers: 0, classes: ["smith"] }, placement: false, conclude: false, endsAt: null }, requireUserAct(client, "preapproveQuest"));
  f.k.plan("lead", { ...planInput(other.id), reversible: true, party: [{ classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] }] });
  expect(f.k.quest(other.id).greenlitVersion).toBeNull();
});
it("retries a typed placement blocker once, then stops; untyped blockers stay with the user", async () => {
  const f = await fixture(); f.a.preapprove(f.q.id, { greenlight: null, placement: true, conclude: true, endsAt: null }, requireUserAct(client, "preapproveQuest"));
  const ask = f.k.ask("lead", { ...request(f.q.id), kind: "blocker", effect: { type: "placement-blocker" } }, {}, true);
  expect(f.a.match(ask)?.optionId).toBe("retry");
  f.a.consume(f.a.match(ask)!); expect(f.a.match(ask)?.optionId).toBe("stop");
  expect(f.a.match({ ...ask, effect: { type: "answer-blocker" } })).toBeNull();
  expect(f.a.match({ ...ask, kind: "conclude", effect: { type: "conclude", draft: { outcome: "Done", left: "" } } })).toBeNull();
});
it("rejects non-client callers and missing receipts", async () => {
  const f = await fixture();
  expect(() => requireUserAct({ experimental_caller: { kind: "plugin" } } as never, "delegateQuest")).toThrow(/client/);
  expect(() => f.a.delegate(f.q.id, "merge", undefined as never)).toThrow(/client/);
  expect(() => f.a.preapprove(f.q.id, { greenlight: null, placement: true, conclude: true, endsAt: null }, undefined as never)).toThrow(/client/);
});
