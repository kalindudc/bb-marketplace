// @vitest-environment node
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { seedQuest, planInput } from "./support";
import { QuestAuthority } from "../../src/server/quest-authority";
import { QUEST_LANES, requireUserAct } from "../../src/server/authority";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights/index";
import { recordCommunication } from "../../src/server/communication";
import { randomUUID } from "node:crypto";
const client = { experimental_caller: { kind: "client" } } as never;
const receipt = () => requireUserAct(client, "delegateQuest");
const request = (q: string, kind: "merge" | "credential" = "credential") => ({ boardQuestId: q, kind, effect: { type: "decision" } as const, question: "Allow this act?", why: "Your authority", options: [{ id: "approve", label: "Approve", detail: "", recommended: false }, { id: "deny", label: "Deny", detail: "", recommended: false }], meanwhile: "Other work continues", holds: [] });
async function fixture() { const f = setup(); const q = await seedQuest(f.k, "lead", "Quest", "Quest"); const a = new QuestAuthority(f.k); return { ...f, q, a }; }
it("never delegates sending and routes a draft only for a named target", async () => {
  const f = await fixture();
  expect(() => f.a.delegate(f.q.id, "sends-as-you", receipt())).toThrow(/cannot be delegated/i);
  expect(() => f.a.delegate(f.q.id, "drafts-as-you", receipt())).toThrow();
  const grant = f.a.delegate(f.q.id, "drafts-as-you", receipt(), ["room-1"]);
  expect(grant).toMatchObject({ kind: "drafts-as-you", targets: ["room-1"] });
  const lane = (sendTarget?: string) => f.a.lane({ kind: "drafts-as-you", boardQuestId: f.q.id, sendTarget });
  expect(lane("room-1")).toBe("keeper");
  expect(lane("room-2")).toBe("user");
  expect(lane()).toBe("user");
  f.a.revoke(f.q.id, grant.id, requireUserAct(client, "revokeQuestAuthority"));
  expect(lane("room-1")).toBe("user");
});
it("records one send handoff, even when the target is unknown, with no executable answer", async () => {
  const f = await fixture();
  const hold = { id: randomUUID(), act: "send" as const, threadId: "lead", tool: "fixture_send", target: null, body: "First\n\nLast", callDigest: "1".repeat(64), rulesDigest: "2".repeat(64), scopeIssuedAt: 1, at: f.time() };
  recordCommunication(f.k, hold);
  recordCommunication(f.k, { ...hold, id: randomUUID() });
  const asks = f.k.store.openAsks("lead").filter(ask => ask.kind === "sends-as-you");
  expect(asks).toHaveLength(1);
  const [ask] = asks;
  expect(ask).toMatchObject({ lane: "user", proceedAt: null, effect: { hold: { body: hold.body, target: null } } });
  expect(ask.options.map(option => option.id)).toEqual(["acknowledge", "deny"]);
  expect(() => f.k.answerAsk(ask.id, "approve", null, "page", "user")).toThrow();
  f.k.answerAsk(ask.id, "acknowledge", null, "page", "user", "client (unattested)", {}, requireUserAct(client, "answerAsk"));
  expect(f.k.store.get("asks", ask.id)?.answer?.optionId).toBe("acknowledge");
  expect(f.k.store.all("shellGrants")).toEqual([]);
  expect(f.k.store.all("decisions")).toEqual([]);
});
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
it.each(["kubectl --context demo apply -f sample.yaml --namespace=tools", "terraform apply", "helm upgrade release ./chart"])("keeps %s in a new user ask even with production delegation and pre-approval", async command => {
  const f = await fixture();
  f.a.delegate(f.q.id, "production", receipt());
  f.a.preapprove(f.q.id, { greenlight: { maxMembers: 1, classes: ["smith"] }, placement: true, conclude: true, endsAt: null }, requireUserAct(client, "preapproveQuest"));
  expect(QUEST_LANES["cluster-write"]).toMatchObject({ lane: "user", delegatable: false });
  expect(() => f.a.delegate(f.q.id, "cluster-write" as never, receipt())).toThrow(/cannot be delegated/);
  const input = { ...request(f.q.id), kind: "cluster-write" as const, question: "Apply the sample change?", target: { command }, change: "Update the fixture.", undo: "Restore the previous version." };
  const ask = f.k.ask("lead", input);
  expect(ask).toMatchObject({ lane: "user", state: "open", target: { command }, undo: input.undo });
  if (command.startsWith("kubectl")) expect(ask.clusterTargets).toEqual([{ context: "demo", namespace: "tools" }]);
  expect(ask.options.map(o => o.id)).toEqual(["approve", "deny"]);
  expect(f.a.match(ask)).toBeNull();
  expect(() => f.k.answerAsk(ask.id, "approve", null, "timer", "preapproval")).toThrow(/No matching/);
  expect(() => f.k.answerAsk(ask.id, "approve", null, "chat", "keeper")).toThrow(/belongs to the user/);
  expect(() => f.k.ask("lead", { ...input, target: undefined })).toThrow(/exact command/);
  expect(() => f.k.ask("lead", { ...input, kind: "production" })).toThrow(/cluster-write/);
  f.k.answerAsk(ask.id, "approve", null, "page", "user", "client (unattested)", {}, requireUserAct(client, "answerAsk"));
  const changed = f.k.ask("lead", { ...input, target: { command: command + " --different" } });
  const repeat = f.k.ask("lead", input);
  for (const next of [changed, repeat]) {
    expect(next.id).not.toBe(ask.id);
    expect(next).toMatchObject({ state: "open", lane: "user", answer: null });
  }
});
it("keeps the full compound command and each distinct target on a cluster write ask", async () => {
  const f = await fixture();
  const command = "kustomize build . | kubectl --context demo apply -f - -n tools && helm --kube-context other --namespace apps upgrade release ./chart";
  const input = { ...request(f.q.id), kind: "cluster-write" as const, target: { command }, change: "Apply the overlay and upgrade the sample release." };
  const ask = f.k.ask("lead", input);
  expect(ask.target?.command).toBe(command);
  expect(ask.clusterTargets).toEqual([{ context: "demo", namespace: "tools" }, { context: "other", namespace: "apps" }]);
  expect(() => f.k.ask("lead", { ...input, kind: "production" })).toThrow(/Use kind cluster-write/);
  const remote = "ssh fixture 'kubectl --context demo apply -f sample.yaml'";
  expect(f.k.ask("lead", { ...input, target: { command: remote } })).toMatchObject({ target: { command: remote }, clusterTargets: [{ context: "demo" }] });
  expect(() => f.k.ask("lead", { ...input, target: { command: "kubectl apply 'unterminated" } })).toThrow(/unterminated single quote.*send the literal command/i);
});
it("records approval separately from the confirmation that permits one run", async () => {
  const f = await fixture();
  const command = "kubectl --context demo apply -f sample.yaml";
  const ask = f.k.ask("lead", { ...request(f.q.id), kind: "cluster-write", target: { command }, change: "Update the fixture." });
  const answer = requireUserAct(client, "answerAsk");
  expect(ask.runThreadId).toBe("lead");
  expect(() => f.k.answerAsk(ask.id, "confirm-run", null, "page", "user", "page (client, unattested)", {}, answer)).toThrow(/Approve/);
  f.k.answerAsk(ask.id, "approve", null, "page", "user", "page (client, unattested)", {}, answer);
  expect(f.k.store.get("asks", ask.id)).toMatchObject({ state: "open", clusterApproval: { via: "page", surface: "page (client, unattested)" }, answer: null });
  f.k.answerAsk(ask.id, "confirm-run", null, "banner", "user", "banner (client, unattested)", {}, answer);
  expect(f.k.store.get("asks", ask.id)).toMatchObject({ state: "answered", answer: { optionId: "confirm-run", via: "banner", surface: "banner (client, unattested)" } });
});
it("issues a single grant after confirmation, wakes the Keeper and refuses a detection-only thread", async () => {
  const f = await fixture();
  const ask = f.k.ask("lead", { ...request(f.q.id), kind: "cluster-write", target: { command: "kubectl apply -f sample.yaml" }, change: "Update the fixture." });
  const receipt = requireUserAct(client, "answerAsk");
  const answer = (option: string) => f.runtime.answerAsk(ask.id, option, null, "page", true, "client (unattested)", receipt);
  await expect(answer("approve")).rejects.toThrow(/cannot be guarded/);
  const issue = vi.fn(async () => {});
  f.runtime.scopes = { clusterGuardArmed: async () => true, issueClusterGrant: issue } as never;
  const wake = vi.spyOn(f.runtime, "wakeKeeper").mockResolvedValue();
  await answer("approve");
  expect(issue).not.toHaveBeenCalled(); expect(wake).not.toHaveBeenCalled();
  await Promise.all([answer("confirm-run"), answer("confirm-run")]);
  expect(issue).toHaveBeenCalledTimes(1);
  expect(wake).toHaveBeenCalledWith("lead", "confirmed cluster write");
  expect(issue.mock.calls[0]).toEqual([expect.objectContaining({ threadId: "lead", scope: "once", askId: ask.id, expiresAt: f.time() + 900_000 })]);
  const revoke = vi.fn<() => Promise<void>>(async () => { throw new Error("Host not reachable"); });
  Object.assign(f.runtime.scopes!, { revokeClusterGrant: revoke });
  const close = vi.fn();
  await expect(f.runtime.closeAfterRevokingClusterGrants(close)).rejects.toThrow(/wait for the grant to expire/i);
  expect(close).not.toHaveBeenCalled();
  revoke.mockResolvedValueOnce(undefined);
  await f.runtime.closeAfterRevokingClusterGrants(close);
  expect(revoke).toHaveBeenCalledWith("lead", ask.id);
  expect(close).toHaveBeenCalledTimes(1);
});
it("tells the Keeper about a failed cluster grant delivery", async () => {
  const f = await fixture();
  const ask = f.k.ask("lead", { ...request(f.q.id), kind: "cluster-write", target: { command: "kubectl apply -f sample.yaml" }, change: "Update the fixture." });
  const receipt = requireUserAct(client, "answerAsk");
  const answer = (option: string) => f.runtime.answerAsk(ask.id, option, null, "page", true, "client (unattested)", receipt);
  f.runtime.scopes = { clusterGuardArmed: async () => true, issueClusterGrant: async () => { throw new Error("Fixture host unavailable"); } } as never;
  const wake = vi.spyOn(f.runtime, "wakeKeeper").mockResolvedValue();
  await answer("approve");
  await expect(answer("confirm-run")).resolves.toMatchObject({ clusterGrantError: expect.stringContaining("Fixture host unavailable") });
  expect(f.k.store.events().find(e => e.type === "ask.cluster-run-failed")).toMatchObject({ data: { askId: ask.id, reason: "Fixture host unavailable" } });
  expect(wake).toHaveBeenCalledWith("lead", "cluster grant delivery failed");
});
it("rejects non-client callers and missing receipts", async () => {
  const f = await fixture();
  expect(() => requireUserAct({ experimental_caller: { kind: "plugin" } } as never, "delegateQuest")).toThrow(/client/);
  expect(() => f.a.delegate(f.q.id, "merge", undefined as never)).toThrow(/client/);
  expect(() => f.a.preapprove(f.q.id, { greenlight: null, placement: true, conclude: true, endsAt: null }, undefined as never)).toThrow(/client/);
});
