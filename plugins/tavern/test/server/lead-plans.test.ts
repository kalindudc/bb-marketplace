// @vitest-environment node
import { expect, it, vi } from "vitest";
import { registerTools } from "../../src/server/tools";
import { registerRpc } from "../../src/server/rpc";
import { attention } from "../../src/server/attention";
import { registerJournal } from "../../src/server/journal";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights";
import { setup } from "./runtime-fixture";
import { planInput, putQuestFixture, seedQuest } from "./support";
import { boardQuestDetailSchema, roomSchema } from "../../src/shared/contract";

const brief = { outcome: "Coordinate two parallel tracks", mode: "make-it-work" as const, outOfScope: "No deployment", doneWhen: "Both checks pass", context: [], questions: [], timeboxMinutes: null };
const workSlot = (index: number) => ({ classId: "smith", characterId: null, model: null, purpose: `Build track ${index}`, waypointIds: ["w1"] });

async function fixture(parentCheck: "warden" | "keeper" | "none" = "none", journalLive = false) {
  const f = setup();
  if (journalLive) {
    f.bb.sdk.plugins.list = async () => ({ plugins: [] });
    f.bb.sdk.threads.getPluginMetadata = async () => ({});
    Object.assign(f.port, registerJournal(f.bb, f.k.store.db, {
      roleOf: id => f.runtime.journalRole(id),
      invalidate: () => {},
    }));
  }
  const settings = new SettingsStore(f.k.store.db, f.time);
  f.runtime.enableSettings(settings, new InsightsReader(f.k.store.db, settings, f.time));
  settings.update({ revision: 0, patch: { keepers: { greenlight: "by-size" } }, why: "Ensure chain plans do not use root automation" });
  registerTools(f.bb, f.runtime);
  registerRpc(f.bb, f.runtime);
  const parent = await seedQuest(f.k, "lead", "Upgrade both services", "Upgrade");
  const parentPlan = planInput(parent.id);
  f.k.plan("lead", { ...parentPlan, waypoints: [{ ...parentPlan.waypoints[0]!, check: parentCheck }], party: [{ classId: "keeper", characterId: null, model: "anthropic/claude-sonnet-5-5", purpose: brief.outcome,
    waypointIds: ["w1"], leadEnvelope: { members: 1, rangers: 0, depth: 1 } },
    ...(parentCheck === "warden" ? [{ classId: "warden", characterId: null, model: null, purpose: "Check the child outcome", waypointIds: ["w1"] }] : [])] });
  f.k.answerAsk(f.k.store.openAsks("lead", parent.id)[0]!.id, "approve", null, "page", "user");
  const lead = await f.runtime.hire("lead", "project", { classId: "keeper", boardQuestId: parent.id, waypointId: "w1", title: brief.outcome, brief });
  const child = await f.k.openQuest(lead.threadId, "Child checks", "Checks");
  const propose = (members = 1, check?: "warden" | "keeper" | "none") => {
    const plan = planInput(child.id);
    return f.k.plan(lead.threadId, { ...plan, ...(check ? { waypoints: [{ ...plan.waypoints[0]!, check }] } : {}), reversible: true,
      party: Array.from({ length: members }, (_, index) => workSlot(index + 1)) });
  };
  const decision = (version: number, action: "approve" | "refuse" = "approve", extra = {}) => ({
    boardQuestId: parent.id, text: "Child service checks", why: "The requested work fits the approved service waypoint", source: "keeper", reversible: true,
    coveredBy: { kind: "plan", version: 1, waypointId: "w1" }, options: ["Approve these checks", "Ask for a revision"],
    consequence: { change: "Approve this exact plan only", audience: "The lead sees the result", undo: "Staffing returns to awaiting approval, but external work remains" }, unsure: false,
    leadPlan: { childQuestId: child.id, version, action }, ...extra,
  });
  const decide = (input: ReturnType<typeof decision>, threadId = "lead") => f.harness.behavior.invokeAgentTool("tavern_decide", input, { threadId });
  const answer = (askId: string, optionId = "approve") => f.harness.invokeRpc("answerAsk", { askId, optionId, note: null, via: "page" });
  return { ...f, parent, lead, child, propose, decision, decide, answer };
}

it("only the immediate parent can approve a fitting exact child plan, without a user ask or an automatic decision", async () => {
  const f = await fixture();
  const plan = f.propose();
  expect(f.k.quest(f.child.id)).toMatchObject({ phase: "greenlight", greenlitVersion: null });
  expect(f.k.store.openAsks(f.lead.threadId, f.child.id)).toHaveLength(0);
  expect(f.k.restatement("lead")).toContain("Child checks");
  await expect(f.decide(f.decision(plan.version), f.lead.threadId)).rejects.toThrow(/own|parent/i);
  await f.decide(f.decision(plan.version));
  expect(f.k.quest(f.child.id)).toMatchObject({ phase: "build", greenlitVersion: plan.version });
  const receipt = f.k.store.get("leadPlans", `${f.child.id}:${plan.version}`);
  expect(receipt).toMatchObject({ state: "approved", receipt: { kind: "decision" } });
  await expect(f.runtime.hire(f.lead.threadId, "project", { classId: "smith", boardQuestId: f.child.id, waypointId: "w1", title: "Start the approved track", brief })).resolves.toMatchObject({ classId: "smith" });
});

it("requires the user's greenlight for a fitting child plan with a scheduled permanent slot", async () => {
  const f = await fixture();
  const schedule = { cadence: "weekly", weekday: 1, at: "09:30", duty: "Read the public tracker" } as const;
  const plan = f.k.plan(f.lead.threadId, { ...planInput(f.child.id), reversible: true,
    party: [{ ...workSlot(1), permanent: { why: "Standing duty", schedules: [schedule] } }] });
  await expect(f.decide(f.decision(plan.version))).rejects.toThrow(/user's answer/);
  const ask = f.k.store.openAsks(f.lead.threadId, f.child.id)[0]!;
  expect(ask.effect).toMatchObject({ type: "lead-plan", request: { scheduledSlots: [{ slot: 1, schedules: [schedule] }] } });
  await f.answer(ask.id);
  expect(f.k.quest(f.child.id).greenlitVersion).toBe(plan.version);
});

it("keeps a pending plan answerable after either quest is renamed and shows both new names", async () => {
  const f = await fixture();
  const plan = f.propose(2);
  const ask = f.k.store.openAsks(f.lead.threadId, f.child.id)[0]!;
  await f.harness.invokeRpc("renameBoardQuest", { id: f.parent.id, title: "Service restoration", short: "Restore" });
  await f.harness.invokeRpc("renameBoardQuest", { id: f.child.id, title: "Lamp checks", short: "Lamps" });
  const detail = await f.harness.invokeRpc("boardQuest", { id: f.child.id });
  expect(detail).toMatchObject({ asks: expect.arrayContaining([expect.objectContaining({
    id: ask.id, question: expect.stringContaining(`Restore: Approve Lamp checks, plan v${plan.version}?`),
    effect: { type: "lead-plan", request: expect.objectContaining({ parentTitle: "Service restoration",
      changes: [expect.objectContaining({ questTitle: "Service restoration" })] }) },
  })]) });
  expect(f.k.store.get("asks", ask.id)?.effect).toEqual(ask.effect);
  await f.answer(ask.id);
  expect(f.k.quest(f.child.id).greenlitVersion).toBe(plan.version);
});

it("will not reuse a refusal, superseded version or a held parent's decision", async () => {
  const f = await fixture();
  const first = f.propose();
  await f.decide(f.decision(first.version, "refuse"));
  expect(f.k.quest(f.child.id).greenlitVersion).toBeNull();
  expect(f.k.store.get("leadPlans", `${f.child.id}:${first.version}`)).toMatchObject({ state: "refused" });
  const revised = f.propose();
  await expect(f.decide(f.decision(first.version))).rejects.toThrow(/version|superseded/i);
  f.k.setQuestHeld(f.parent.id, true, { kind: "user" });
  await expect(f.decide(f.decision(revised.version))).rejects.toThrow(/held/i);
  expect(f.k.quest(f.child.id).greenlitVersion).toBeNull();
});

it("leaves the user card and envelope untouched when the parent plan changes before the answer", async () => {
  const f = await fixture();
  const plan = f.propose(2);
  const ask = f.k.store.openAsks(f.lead.threadId, f.child.id)[0]!;
  const parentPlan = f.k.store.get("plans", `${f.parent.id}:1`)!;
  f.k.plan("lead", { ...parentPlan, fromSteer: null, goal: "Updated parent goal" });
  await expect(f.answer(ask.id)).rejects.toThrow(/parent approval changed/i);
  expect(f.k.store.get("asks", ask.id)).toMatchObject({ state: "open", answer: null });
  expect(f.k.store.all("leadLinks")).toMatchObject([{ envelope: { members: 1 } }]);
  expect(f.k.quest(f.child.id)).toMatchObject({ planVersion: plan.version, greenlitVersion: null });
});

it.each(["new", "legacy"] as const)("shows the renamed parent on a %s forwarded ask without changing its body", async stored => {
  const f = await fixture();
  const body = `Wait until the bell rings: does the “${f.parent.short}” memo still apply?`;
  const ask = f.k.ask(f.lead.threadId, { boardQuestId: f.child.id, kind: "blocker", effect: { type: "decision" }, question: body,
    why: "The glass might be cracked.", holds: [], meanwhile: "", options: [{ id: "wait", label: "Wait", detail: "", recommended: false }] });
  expect(ask.question).toContain(`${f.parent.short}: ${body}`);
  if (stored === "legacy") {
    const { forwardedQuestion: _, ...legacy } = ask;
    f.k.store.put("asks", ask.id, legacy);
  }
  f.runtime.away.store.close({ revision: 0, until: f.time() + 60_000, quests: [{ questId: f.parent.id, endState: "drafts-ready" }] });
  await f.harness.invokeRpc("renameBoardQuest", { id: f.parent.id, title: "Restore the harbor bell", short: "Bell: harbor" });
  const question = ask.question.replace(`${f.parent.short}: ${body}`, `Bell: harbor: ${body}`);
  const row = expect.objectContaining({ id: ask.id, question });
  const room = roomSchema.parse(await f.harness.invokeRpc("room", {}));
  expect(room.asks).toContainEqual(row);
  expect(room.attention?.items).toContainEqual(expect.objectContaining({ id: ask.id, title: question }));
  expect(room.attention?.items.filter(item => item.id === ask.id)).toHaveLength(1);
  expect(room.keepers.flatMap(keeper => keeper.boardQuests).filter(quest => quest.id === f.child.id)).toMatchObject([
    { leadChain: { seat: { parentQuestId: f.parent.id, parentTitle: "Restore the harbor bell", parentKeeperThreadId: "lead" } } },
  ]);
  expect(await f.harness.invokeRpc("boardQuest", { id: f.parent.id })).toMatchObject({
    attention: { items: expect.arrayContaining([expect.objectContaining({ id: ask.id, questId: f.child.id, keeperThreadId: f.lead.threadId })]) },
    asks: expect.arrayContaining([row]),
  });
  expect(await f.harness.invokeRpc("decor", { threadId: "lead" })).toMatchObject({ keeperView: { openAsks: [row] } });
  expect(f.k.store.get("asks", ask.id)?.forwardedQuestion).toMatchObject({ parentQuestId: f.parent.id, body });
  expect(f.k.restatement("lead")).toContain(`Bell: harbor: ${body}`);
  expect(await f.harness.invokeRpc("ledger", { threadId: f.lead.threadId })).toMatchObject({ asks: expect.arrayContaining([row]) });
  expect(await f.harness.invokeRpc("awayDigest", {})).toMatchObject({ asks: expect.arrayContaining([expect.objectContaining({ ask: row })]) });
  await f.answer(ask.id, "wait");
  expect(f.k.store.get("asks", ask.id)).toMatchObject({ state: "answered", keeperThreadId: f.lead.threadId, boardQuestId: f.child.id });
  expect(await f.harness.invokeRpc("decor", { threadId: "lead" })).toMatchObject({ keeperView: { openAsks: [] } });
});

it("projects the current seat beside the waypoint and keeps old attempts in history", async () => {
  const f = await fixture("warden");
  const current = f.k.store.get("leadLinks", f.lead.leadLinkId!)!;
  const previous = { ...f.child, id: "earlier-quest", title: "Earlier check", phase: "stopped" as const, endedAt: f.time() };
  putQuestFixture(f.k.store, previous.id, previous);
  f.k.store.put("leadLinks", "earlier-seat", { ...current, id: "earlier-seat", hireToken: "earlier-hire", childQuestId: previous.id, state: "stopped" });
  f.k.store.put("leadLinks", current.id, { ...current, state: "retiring", cleanupError: "Thread stop not confirmed" });
  const { quest } = boardQuestDetailSchema.parse(await f.harness.invokeRpc("boardQuest", { id: f.parent.id }));
  expect(quest.waypoints.find(w => w.id === "w1")).toMatchObject({ sideQuest: { linkId: current.id, state: "retiring",
    quest: { id: f.child.id, phase: f.child.phase }, error: "Thread stop not confirmed" } });
  expect(quest.leadChain?.children.find(side => side.linkId === "earlier-seat")).toMatchObject({
    current: false, quest: { id: previous.id, phase: "stopped" },
  });
});

it("cannot use an ordinary greenlight or hire outside the linked child", async () => {
  const f = await fixture();
  const plan = f.propose();
  const legacy = f.k.ask(f.lead.threadId, { kind: "greenlight", boardQuestId: f.child.id, question: "Ordinary greenlight",
    effect: { type: "greenlight", planVersion: plan.version }, why: "Not a chain approval", meanwhile: "", holds: [],
    options: [{ id: "approve", label: "Approve", detail: "Does not change authority", recommended: false }] });
  await expect(f.answer(legacy.id)).rejects.toThrow(/ordinary greenlight/i);
  await expect(f.runtime.hire(f.lead.threadId, "project", { classId: "wanderer", errand: true, title: "Unlinked help", brief })).rejects.toThrow(/linked child quest/i);
  expect(f.k.quest(f.child.id).greenlitVersion).toBeNull();
});

it("records an oversized plan's amendment and its exact greenlight from one user answer", async () => {
  const f = await fixture();
  const plan = f.propose(2);
  const asks = f.k.store.openAsks(f.lead.threadId, f.child.id);
  expect(asks).toHaveLength(1);
  const ask = asks[0]!;
  expect(ask.effect).toMatchObject({ type: "lead-plan", request: { version: plan.version, approved: { members: 1 }, requested: { members: 2 } } });
  await expect(f.decide(f.decision(plan.version))).rejects.toThrow(/user|envelope/i);
  f.k.answerAsk(ask.id, "revise", null, "page", "user");
  const next = f.propose(2, "keeper");
  const nextAsk = f.k.store.openAsks(f.lead.threadId, f.child.id)[0]!;
  expect(nextAsk.effect).toMatchObject({ request: { planChanges: { fromVersion: plan.version, changedWaypoints: [expect.any(String)] } } });
  await f.answer(nextAsk.id);
  expect(f.k.quest(f.child.id)).toMatchObject({ phase: "build", greenlitVersion: next.version });
  expect(f.k.store.get("leadPlans", `${f.child.id}:${next.version}`)).toMatchObject({ state: "approved", receipt: { kind: "ask-answer", id: nextAsk.id } });
  expect(f.k.store.all("leadLinks")).toMatchObject([{ envelope: { members: 2 }, amendedBy: nextAsk.id }]);
});

it("moves an uncertain plan to the user and undo invalidates a parent's exact greenlight", async () => {
  const f = await fixture();
  const first = f.propose();
  await f.decide(f.decision(first.version));
  const receipt = f.k.store.get("leadPlans", `${f.child.id}:${first.version}`)!.receipt!;
  f.k.undoDecision(receipt.id);
  expect(f.k.quest(f.child.id)).toMatchObject({ phase: "greenlight", greenlitVersion: null });
  expect(f.k.store.openAsks(f.lead.threadId, f.child.id)).toHaveLength(1);
  const next = f.propose();
  await f.decide(f.decision(next.version, "approve", { unsure: true }));
  expect(f.k.store.openAsks(f.lead.threadId, f.child.id).map(ask => ask.effect)).toEqual([expect.objectContaining({ type: "lead-plan", request: expect.objectContaining({ version: next.version }) })]);
  expect(f.k.quest(f.child.id).greenlitVersion).toBeNull();
});

it.each([["keeper", "reported"], ["warden", "reported"], ["none", "done"]] as const)("concludes a settled child without giving away the parent's %s check", async (check, state) => {
  const f = await fixture(check, true);
  const plan = f.propose(1, check === "warden" ? "none" : check);
  if (check === "warden") {
    const amend = f.k.store.openAsks(f.lead.threadId, f.child.id)[0]!;
    await f.answer(amend.id);
    f.k.bind("parent-warden", "warden", null, "project", { keeperThreadId: "lead", boardQuestId: f.parent.id, waypointId: "w1", title: "Check the child outcome", errand: false, brief });
    expect(f.k.checkerWaypoints("parent-warden")).not.toContain("w1");
  } else await f.decide(f.decision(plan.version));
  const maker = await f.runtime.hire(f.lead.threadId, "project", { classId: "smith", boardQuestId: f.child.id, waypointId: "w1", title: "Check tracks", brief });
  const entry = f.k.journal.get(maker.threadId).entries.find(e => e.link?.boardQuestId === f.child.id)!;
  const proof = [{ kind: "note", ref: "Both checks passed" }];
  await f.harness.behavior.invokeAgentTool("journal", { action: "done", id: entry.id, evidence: proof }, { threadId: maker.threadId });
  f.advance(Date.now() - f.time() + 100);
  if (check === "keeper") f.k.settle(f.lead.threadId, { boardQuestId: f.child.id, waypointId: "w1", as: "accepted", reason: "Checked both tracks." });
  const wrap = await f.runtime.proposeWrap(f.lead.threadId, f.child.id, "Both tracks checked", "");
  expect(wrap.askId).toBeTruthy();
  if (check === "none") expect(attention(f.k.store, {}).items.some(item => item.id === wrap.askId)).toBe(true);
  const input = { boardQuestId: f.parent.id, text: "Conclude the closed map", why: "The child met its plan", source: "keeper", reversible: false, askId: wrap.askId, optionId: "conclude",
    consequence: { change: "Record the child result", audience: "The parent party", undo: "The child has finished" }, unsure: false };
  const conclude = (threadId: string) => f.harness.behavior.invokeAgentTool("tavern_decide", input, { threadId });
  await expect(conclude(f.lead.threadId)).rejects.toThrow(/parent|belongs|own/i);
  if (check === "none") {
    await expect(f.runtime.answerAsk(wrap.askId!, "conclude", null, "chat")).rejects.toThrow(/explicit/);
    await f.answer(wrap.askId!, "conclude");
    expect(f.k.store.get("asks", wrap.askId!)?.answer?.by).toBe("user");
  } else {
    await conclude("lead");
    await conclude("lead");
  }
  expect(f.k.quest(f.child.id)).toMatchObject({ phase: "done", outcome: "concluded" });
  await expect(f.harness.invokeRpc("ledger", { threadId: "lead" })).resolves.toMatchObject({ boardQuests: [
    expect.objectContaining({ id: f.parent.id, leadChain: expect.objectContaining({ children: [expect.objectContaining({ quest: expect.objectContaining({ id: f.child.id }) })] }) }),
  ] });
  expect(f.k.summary(f.parent.id).waypoints[0]).toMatchObject({ state, evidenceCount: 1, checkedBy: [] });
  expect(f.k.store.events("lead").filter(event => event.type === "lead.outcome")).toHaveLength(1);
  if (check === "warden") {
    const entry = f.k.journal.get(f.lead.threadId).entries.find(e => e.link?.boardQuestId === f.parent.id)!;
    const verdict = await f.harness.behavior.invokeAgentTool("journal", { action: "verify", id: entry.id, threadId: f.lead.threadId, evidence: [{ kind: "note", ref: "Reviewed the child tale and proof" }] }, { threadId: "parent-warden" });
    expect(verdict).toEqual(expect.any(String));
    expect(f.k.summary(f.parent.id).waypoints[0]).toMatchObject({ state: "verified", checkedBy: ["parent-warden"] });
  }
  if (check === "keeper") f.k.settle("lead", { boardQuestId: f.parent.id, waypointId: "w1", as: "accepted", reason: "Reviewed the child outcome." });
  const invoke = (threadId: string, memberThreadId?: string) => f.harness.behavior.invokeAgentTool("tavern_release", memberThreadId
    ? { memberThreadId, reason: "The child finished" }
    : { confirmRetirement: true }, { threadId });
  await invoke("lead", f.lead.threadId);
  expect(f.k.store.get("leadLinks", f.lead.leadLinkId!)?.state).toBe("retirement-requested");
  expect(f.k.member(f.lead.threadId)?.engagement).toBe("active");
  await expect(invoke("lead")).rejects.toThrow(/lead/i);
  const pr = f.k.store.recordPullRequest({ keeperThreadId: f.lead.threadId, boardQuestId: f.child.id, projectId: "project", url: "https://forge.example/pr/12", forge: null, head: "topic", base: "main", owner: "unknown", memberHead: "a".repeat(40), pushedHead: null, verifiedCommit: null, state: "draft" }, f.time());
  await expect(invoke(f.lead.threadId)).rejects.toThrow(/recorded owner/);
  expect(f.k.store.get("leadLinks", f.lead.leadLinkId!)?.state).toBe("retirement-requested");
  f.k.store.changePullRequest({ ...pr, owner: f.lead.threadId }, f.time());
  await invoke(f.lead.threadId);
  expect(f.k.store.get("pullRequests", pr.id)).toMatchObject({ owner: "lead", keeperThreadId: "lead", boardQuestId: f.parent.id, state: "draft", url: pr.url });
  expect(f.k.store.get("leadLinks", f.lead.leadLinkId!)?.state).toBe("retiring");
  await f.runtime.retryStops("lead", f.parent.id, true);
  const retired = f.k.store.get("leadLinks", f.lead.leadLinkId!);
  expect(retired?.cleanupError).toBeUndefined();
  expect(retired?.state).toBe("retired");
  expect(f.k.member(f.lead.threadId)?.engagement).toBe("archived");
  expect(f.k.store.events("lead").filter(event => event.type === "lead.retired")).toHaveLength(1);
  const forge = f.runtime.placements().forge;
  vi.spyOn(forge, "inspect").mockResolvedValue({ state: "draft", headCommit: "a".repeat(40) });
  const close = vi.spyOn(forge, "close").mockResolvedValue({ state: "closed" });
  await f.harness.behavior.invokeAgentTool("tavern_pull_request", { action: "close", pullRequestId: pr.id, reason: "Superseded by the parent work" }, { threadId: "lead" });
  expect(close).toHaveBeenCalledOnce();
  expect(f.k.store.get("pullRequests", pr.id)?.state).toBe("closed");
});

it("keeps a lead's early closure in the user lane and does not settle the parent waypoint", async () => {
  const f = await fixture("none", true);
  const wrap = await f.runtime.proposeWrap(f.lead.threadId, f.child.id, "Not done", "No checked output");
  expect(wrap.askId).toBeTruthy();
  expect(attention(f.k.store, {}).items.filter(item => item.id === wrap.askId)).toHaveLength(1);
  await f.answer(wrap.askId!, "close-early");
  expect(f.k.summary(f.parent.id).waypoints[0]).not.toMatchObject({ state: "done" });
  expect(f.k.store.events("lead").filter(event => event.type === "lead.outcome")).toHaveLength(0);
});

it("points the parent to the original child ask, summary and hand-back without offering it an answer", async () => {
  const f = await fixture();
  const ask = f.k.ask(f.lead.threadId, { boardQuestId: f.child.id, kind: "credential", question: "Which access should we use?", why: "No current access", holds: [], meanwhile: "", effect: { type: "decision" },
    options: [{ id: "wait", label: "Wait", detail: "No change", recommended: true }] });
  const handBack = f.k.memory.note(f.lead.threadId, { kind: "waiting-on-user", boardQuestId: f.child.id, text: "Confirm the test account", action: "Confirm the account", need: "Only you know which account to use." });
  const summary = f.k.postSummary(f.lead.threadId, { boardQuestId: f.child.id, title: "Finished the local checks", body: "Checked both tracks locally.", links: [], request: { kind: "hand-back", id: handBack.id } });
  const due = f.k.memory.note(f.lead.threadId, { kind: "commitment", boardQuestId: f.child.id, text: "Check the access request", action: "Check the test account", condition: "Access arrives", dueAt: f.time() + 1 });
  f.advance(2);
  f.k.memory.due(f.lead.threadId);
  const ledger = f.k.restatement("lead");
  expect(ledger).toContain("Read-only child asks");
  expect(ledger).toContain(ask.id);
  expect(ledger).toContain(summary.id);
  expect(ledger).toContain(handBack.id);
  expect(f.k.memory.notes(f.lead.threadId).find(note => note.id === due.id)?.state).toBe("open");
  const items = attention(f.k.store, {}).items;
  expect(items.filter(item => item.id === ask.id)).toEqual([expect.objectContaining({ keeperThreadId: f.lead.threadId, title: expect.stringMatching(/asks, for.*Upgrade/) })]);
  expect(items.filter(item => item.id === handBack.id)).toHaveLength(1);
  await expect(f.harness.behavior.invokeAgentTool("tavern_decide", {
    boardQuestId: f.parent.id, text: "Answer the child", why: "Read the question", reversible: true, source: "keeper", askId: ask.id, optionId: "wait",
    consequence: { change: "Wait", audience: "Only the child", undo: "None" }, unsure: false,
  }, { threadId: "lead" })).rejects.toThrow(/own exact quest ask/);
  expect(f.k.store.get("asks", ask.id)?.state).toBe("open");
});
