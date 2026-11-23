// @vitest-environment node
import { expect, it, vi } from "vitest";
import { registerRpc } from "../../src/server/rpc";
import { registerTools } from "../../src/server/tools";
import { AttentionSnapshot } from "../../src/server/attention";
import { DEFAULT_SETTINGS } from "../../src/shared/settings";
import { setup } from "./runtime-fixture";
import { seedQuest } from "./support";

async function fixture() {
  const f = setup();
  registerTools(f.bb, f.runtime);
  registerRpc(f.bb, f.runtime);
  vi.spyOn(f.runtime, "wakeKeeper").mockResolvedValue(undefined as never);
  const q = await seedQuest(f.k, "lead", "Update docs", "Docs");
  const input = { boardQuestId: q.id, kind: "merge", question: "Merge the documentation branch?", why: "The review is complete",
    target: { commit: "a".repeat(40) }, meanwhile: "Continue reading", holds: [],
    options: [{ id: "approve", label: "Approve", detail: "Allow the merge", recommended: false }] };
  const call = (tool: string, args: object) => f.harness.behavior.invokeAgentTool(tool, args, { threadId: "lead" });
  const open = async (override: object = {}) => {
    const result = await call("tavern_ask", { ...input, ...override });
    return { result, ask: f.k.store.openAsks("lead", q.id).at(-1)! };
  };
  return { ...f, q, call, open };
}

it.each(["delegation", "settings"] as const)("uses separate Keeper and user ask projections under %s authority", async authority => {
  const f = await fixture();
  expect((await f.open()).ask.lane).toBe("user");
  expect(new AttentionSnapshot(f.k.store).asks).toHaveLength(1);
  f.k.withdrawAsk(f.k.store.openAsks("lead", f.q.id)[0]!.id, "turn-recovered");
  if (authority === "delegation") f.k.authority.delegate(f.q.id, "merge", { act: "delegateQuest", surface: "page (client, unattested)", attribution: "user" });
  else f.k.settings = () => ({ ...DEFAULT_SETTINGS, keepers: { ...DEFAULT_SETTINGS.keepers, alwaysAsk: DEFAULT_SETTINGS.keepers.alwaysAsk.filter(kind => kind !== "merge") } });
  const { ask, result } = await f.open();
  expect(ask).toMatchObject({ lane: "keeper", state: "open" });
  expect(new AttentionSnapshot(f.k.store).asks).toEqual([]);
  const tick = f.k.restatement("lead");
  expect(tick).toContain(`Keeper lane (not shown to the user):\n${ask.id} [merge]`);
  expect(tick).toContain("Open user asks:\nNone");
  expect(result).not.toContain("::tavern-ask");
  expect(result).toMatch(new RegExp(`${ask.id}.*Keeper lane.*ask-user`, "s"));
  expect(ask.options.find(o => o.id === "approve")?.detail).toMatch(/does not run it.*Keeper lane.*current Warden verdict/);
  f.k.store.db.close();
});

it("does not treat chat as an answer or replay a delegated ask without a Warden", async () => {
  const f = await fixture();
  f.k.authority.delegate(f.q.id, "merge", { act: "delegateQuest", surface: "page (client, unattested)", attribution: "user" });
  const { ask } = await f.open();
  f.k.receiveUser("lead", "Yes, merge the documentation branch.");
  f.k.route("lead", { kind: "steer", boardQuestId: f.q.id, summary: "Says to merge", notes: [] });
  const input = { boardQuestId: f.q.id, askId: ask.id, optionId: "approve", text: "Merge docs", why: "The user said yes in chat", reversible: true,
    consequence: { change: "Docs are current", audience: "Project readers", undo: "Revert the change" }, unsure: false };
  await expect(f.call("tavern_decide", { ...input, source: "ask" })).rejects.toThrow(new RegExp(`${ask.id}.*not a user-answered ask`));
  await expect(f.call("tavern_decide", { ...input, source: "keeper" })).rejects.toThrow("The Warden verdict is no longer current");
  expect(f.k.store.get("asks", ask.id)).toMatchObject({ state: "open", answer: null });
  const handoff = await f.open({ unsure: true });
  expect(handoff.ask).toMatchObject({ lane: "user", state: "open" });
  expect(new AttentionSnapshot(f.k.store).asks.map(a => a.id)).toEqual([handoff.ask.id]);
  await f.harness.invokeRpc("answerAsk", { askId: handoff.ask.id, via: "banner", optionId: "deny", note: null });
  expect(f.k.store.get("asks", handoff.ask.id)).toMatchObject({ state: "answered", answer: { by: "user", optionId: "deny" } });
  expect(f.k.store.get("asks", ask.id)).toMatchObject({ state: "open", answer: null });
  f.k.store.db.close();
});

it("hands the existing merge ask to the user without granting or duplicating it", async () => {
  const f = await fixture();
  f.k.authority.delegate(f.q.id, "merge", { act: "delegateQuest", surface: "page (client, unattested)", attribution: "user" });
  const { ask } = await f.open();
  const notified = vi.fn();
  f.k.askOpened = notified;
  const change = { mergeAskId: ask.id, action: "ask-user", reason: "The user needs to decide" };
  const card = `::tavern-ask{id="${ask.id}"}`;
  await expect(f.call("tavern_ask", change)).resolves.toContain(card);
  await expect(f.call("tavern_ask", change)).resolves.toContain(card);
  expect(f.k.store.openAsks("lead", f.q.id)).toMatchObject([{ id: ask.id, target: ask.target, answer: null, unsure: true, lane: "user" }]);
  expect(new AttentionSnapshot(f.k.store).asks.map(a => a.id)).toEqual([ask.id]);
  expect(notified).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: ask.id, lane: "user" }));
  expect(f.k.store.events("lead").filter(e => e.type === "ask.lane-changed" && e.data.askId === ask.id)).toHaveLength(1);
  await f.harness.invokeRpc("answerAsk", { askId: ask.id, via: "banner", optionId: "deny" });
  expect(f.k.store.get("asks", ask.id)?.answer).toMatchObject({ optionId: "deny", by: "user" });
  await expect(f.call("tavern_ask", { ...change, action: "withdraw" })).rejects.toThrow(new RegExp(`${ask.id}.*no longer open`));
  f.k.store.db.close();
});

it("withdraws a moot open merge ask without recording an answer or erasing it", async () => {
  const f = await fixture();
  const { ask } = await f.open();
  const reason = "The proposed documentation merge is no longer needed";
  const input = { mergeAskId: ask.id, action: "withdraw", reason };
  await expect(f.call("tavern_ask", input)).resolves.toContain(ask.id);
  await expect(f.call("tavern_ask", input)).resolves.toContain(ask.id);
  expect(new AttentionSnapshot(f.k.store).asks).toEqual([]);
  expect(f.k.store.get("asks", ask.id)).toMatchObject({ state: "withdrawn", answer: null, withdrawnCause: "merge-moot", target: ask.target });
  expect(f.k.store.events("lead").filter(e => e.type === "ask.withdrawn" && e.data.askId === ask.id)).toMatchObject([{ text: reason, actor: { kind: "agent", threadId: "lead" } }]);
  expect(f.k.store.all("decisions")).toEqual([]);
  f.k.store.db.close();
});

it("does not withdraw another Keeper's ask or a different kind of decision", async () => {
  const f = await fixture();
  f.k.bind("other", "keeper", "moss", "project");
  const { ask } = await f.open();
  const foreign = f.k.ask("other", { kind: "merge", question: "Merge the other branch?", why: ask.why,
    meanwhile: ask.meanwhile, holds: [], options: [], effect: { type: "decision" } });
  const decision = (await f.open({ kind: "decision" })).ask;
  for (const item of [foreign, decision]) {
    await expect(f.call("tavern_ask", { mergeAskId: item.id, action: "withdraw", reason: "The work has moved on" })).rejects.toThrow(new RegExp(`${item.id}.*not a plain merge ask owned by this Keeper`));
    expect(f.k.store.get("asks", item.id)?.state).toBe("open");
  }
  f.k.store.db.close();
});
