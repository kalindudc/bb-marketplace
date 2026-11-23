// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { registerTools } from "../../src/server/tools";
import { registerRpc } from "../../src/server/rpc";
import { Keeper } from "../../src/server/keeper/service";
import { TavernRuntime } from "../../src/server/runtime";
import { registerJournal } from "../../src/server/journal";
import { withMemberFixtures } from "./member-fixture";
import { setup } from "./runtime-fixture";
import { planInput, seedQuest, waypointEntry } from "./support";

const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const checkedPlan = (id: string) => {
  const plan = planInput(id);
  return { ...plan, waypoints: [{ ...plan.waypoints[0]!, owner: "maker", check: "warden" as const }],
    party: [{ classId: "warden", characterId: "vex", model: null, purpose: "Check", waypointIds: ["w1"] }] };
};

async function fixture() {
  const f = setup(); databases.push(f.k.store.db);
  const registered = vi.spyOn(f.bb.agents, "registerTool");
  registerTools(f.bb, f.runtime);
  const q = await seedQuest(f.k, "lead", "Check the parser", "Parser");
  const plan = checkedPlan(q.id);
  f.k.plan("lead", plan);
  const greenlight = f.k.store.openAsks("lead", q.id).find(a => a.kind === "greenlight")!;
  f.k.answerAsk(greenlight.id, "approve", null, "page", "user");
  const fields = { boardQuestId: q.id, text: "Run the staging check", why: "It proves the output", reversible: true, source: "keeper",
    coveredBy: { kind: "plan" as const, version: 1, waypointId: "w1" }, options: ["Run staging", "Keep local only"],
    consequence: { change: "Staging receives the test build", audience: "The test party", undo: "Remove the test build" }, unsure: false };
  const decide = (override: Record<string, unknown> = {}) => f.harness.behavior.invokeAgentTool("tavern_decide",
    Object.fromEntries(Object.entries({ ...fields, ...override }).filter(([, value]) => value !== undefined)), { threadId: "lead" });
  return { ...f, q, plan, fields, decide, registered };
}

it("saves the Keeper's structured check instead of discarding it at the tool boundary", async () => {
  const f = await fixture();
  await f.decide();
  const { coveredBy, options, consequence, unsure } = f.fields;
  expect(f.k.store.all("decisions")).toEqual([expect.objectContaining({ coveredBy, options, consequence, unsure })]);
});

it.each([
  { kind: "route", id: "nonexistent" }, { kind: "rule", id: "nonexistent" }, { kind: "answer", id: "nonexistent" },
  { kind: "plan", version: 1, waypointId: "missing-waypoint" },
])("refuses a false coverage citation: %j", async coveredBy => {
  const f = await fixture();
  await expect(f.decide({ coveredBy })).rejects.toThrow(/coveredBy.*(route|rule|answer|plan)/i);
  expect(f.k.store.all("decisions")).toHaveLength(0);
});

it("uses the opening route before greenlight, but not as proof for another quest", async () => {
  const f = await fixture();
  const thin = await seedQuest(f.k, "lead", "Scout another parser", "Scout");
  const opening = f.k.store.query("routes", "keeperThreadId", "lead", 50).find(route => route.boardQuestId === thin.id)!;
  await expect(f.decide({ boardQuestId: thin.id, coveredBy: { kind: "route", id: opening.id } })).resolves.toContain("Run the staging check");
  await expect(f.decide({ coveredBy: { kind: "route", id: opening.id } })).rejects.toThrow(/coveredBy.*route/i);
});

it("refuses uncertainty without answering or recording a decision", async () => {
  const f = await fixture();
  await expect(f.decide({ unsure: true })).rejects.toThrow(/ask the user/i);
  expect(f.k.store.all("decisions")).toHaveLength(0);
});

it("requires the full plain-decision check in the registered schema", async () => {
  const f = await fixture();
  const tool = f.registered.mock.calls.find(([tool]) => tool.name === "tavern_decide")![0];
  const schema = tool.parameters as { type?: string; anyOf?: { required: string[] }[] };
  expect(schema.type).toBe("object");
  expect(schema.anyOf).toEqual([
    expect.objectContaining({ required: expect.arrayContaining(["coveredBy", "options", "consequence", "unsure"]) }),
    expect.objectContaining({ required: expect.arrayContaining(["askId", "optionId", "consequence", "unsure"]) }),
  ]);
  expect(schema.anyOf?.[1]?.required).not.toContain("coveredBy");
  expect(schema.anyOf?.[1]?.required).not.toContain("options");
  await expect(f.decide({ coveredBy: undefined })).rejects.toThrow();
});

it("derives the citation and alternatives from its exact delegated ask", async () => {
  const f = await fixture();
  f.k.authority.delegate(f.q.id, "credential", { act: "delegateQuest", surface: "page (client, unattested)", attribution: "user" });
  const options = [{ id: "use-local", label: "Use local access", detail: "It is available", recommended: true },
    { id: "wait", label: "Wait", detail: "No change", recommended: false }];
  const ask = f.k.ask("lead", { boardQuestId: f.q.id, kind: "credential", question: "How should we proceed?", why: "Access is needed", holds: [], meanwhile: "Inspect local setup", options, effect: { type: "decision" } });
  const overrides = { askId: ask.id, optionId: "use-local", coveredBy: undefined, options: undefined };
  await expect(f.decide({ ...overrides, unsure: true })).rejects.toThrow(/ask the user/i);
  await f.decide(overrides);
  expect(f.k.store.get("asks", ask.id)?.answer).toMatchObject({ by: "keeper", optionId: "use-local" });
  expect(f.k.store.all("decisions")).toEqual([expect.objectContaining({
    coveredBy: { kind: "answer", id: ask.id }, options: options.map(option => option.label), consequence: f.fields.consequence, unsure: false,
  })]);
});

it("records a widget answer by its exact quest ask and selected option without answering again", async () => {
  const f = await fixture();
  registerRpc(f.bb, f.runtime);
  const ask = f.k.ask("lead", { boardQuestId: f.q.id, kind: "decision", question: "Which check?", why: "Choose a check",
    holds: [], meanwhile: "Inspect the setup", options: [
      { id: "local", label: "Local", detail: "Run locally", recommended: true },
      { id: "staging", label: "Staging", detail: "Run in staging", recommended: false },
    ], effect: { type: "decision" } });
  await f.harness.invokeRpc("answerAsk", { askId: ask.id, via: "banner", optionId: "local", note: null });
  const answer = f.k.store.get("asks", ask.id)!;
  expect(answer).toMatchObject({ state: "answered", answer: { by: "user", optionId: "local" } });

  const exact = { source: "ask", askId: ask.id, optionId: "local", coveredBy: undefined, options: undefined };
  await expect(f.decide({ ...exact, optionId: "staging" })).rejects.toThrow(new RegExp(`${ask.id}.*local`));
  const wrong = await seedQuest(f.k, "lead", "Unrelated work", "Other");
  await expect(f.decide({ ...exact, boardQuestId: wrong.id })).rejects.toThrow(new RegExp(`${ask.id}.*${f.q.id}`));
  await expect(f.decide({ source: "user", coveredBy: { kind: "answer", id: ask.id } })).rejects.toThrow(/cannot assert user consent/);
  await f.decide(exact);
  expect(f.k.store.all("decisions")).toEqual([expect.objectContaining({
    source: "ask", sourceRef: ask.id, askId: ask.id, optionId: "local", coveredBy: { kind: "answer", id: ask.id }, options: ["Local", "Staging"],
  })]);
  expect(f.k.store.get("asks", ask.id)).toEqual(answer);
  expect(f.k.store.events("lead", 0, 100).filter(e => e.type === "ask.answered" && e.data.askId === ask.id)).toHaveLength(1);
});

it("cannot decide an undelegated merge without the user's approval", async () => {
  const f = await fixture();
  const ask = f.k.ask("lead", { boardQuestId: f.q.id, kind: "merge", question: "Merge it?", why: "Ready for merge", holds: [], meanwhile: "Nothing",
    options: [{ id: "approve", label: "Approve", detail: "Merge", recommended: true }], effect: { type: "decision" } });
  await expect(f.decide({ askId: ask.id, optionId: "approve", coveredBy: undefined, options: undefined })).rejects.toThrow(/belongs to the user/i);
  expect(f.k.store.get("asks", ask.id)?.state).toBe("open");
  expect(f.k.store.all("decisions")).toHaveLength(0);
});

it("computes the version diff even when the Keeper repeats its reason", async () => {
  const f = await fixture();
  for (const [i, title] of ["Check parser output", "Check parser edge cases"].entries()) {
    f.k.plan("lead", { ...f.plan, changeNote: "Still within the party", waypoints: [{ ...f.plan.waypoints[0]!, title }] });
    const event = f.k.store.events("lead", 0, 100).filter(e => e.type === "plan.revised").at(-1);
    expect(event?.data).toMatchObject({ fromVersion: i + 1, toVersion: i + 2, reason: "Still within the party",
      diff: { waypoints: { changed: [{ id: "w1", fields: { title: { before: i ? "Check parser output" : "Build", after: title } } }] } } });
  }
  expect(f.k.quest(f.q.id)).toMatchObject({ phase: "build", planVersion: 3 });
  expect(f.k.store.openAsks("lead", f.q.id)).toHaveLength(0);
});

async function acceptedWaypoints() {
  const f = setup(); databases.push(f.k.store.db);
  const q = await seedQuest(f.k, "lead", "Build and accept", "Acceptance");
  const base = planInput(q.id);
  const one = { ...base.waypoints[0]!, check: "keeper" as const };
  const two = { ...one, id: "w2", title: "Document" };
  const plan = { ...base, waypoints: [one, two] };
  f.k.plan("lead", plan);
  f.k.answerAsk(f.k.store.openAsks("lead", q.id).find(a => a.kind === "greenlight")!.id, "approve", null, "page", "user");
  f.port.linkedEntries = () => [waypointEntry("smith", q.id, "w1"), waypointEntry("smith", q.id, "w2", "a2")];
  const accept = (waypointId: string, reason: string) => f.k.settle("lead", { boardQuestId: q.id, waypointId, as: "accepted", reason });
  const original = accept("w1", "Tests cover the work");
  accept("w2", "Documentation checked");
  const waypoints = (version?: number) => f.k.summary(q.id, version).waypoints;
  return { ...f, q, plan, one, two, original, waypoints };
}

it("carries the original acceptance through unchanged versions and records it in history", async () => {
  const f = await acceptedWaypoints();
  for (const [i, goal] of ["First revision", "Next revision"].entries()) {
    f.k.plan("lead", { ...f.plan, goal, waypoints: [f.one, { ...f.two, doneWhen: "Include examples" }] });
    expect(f.waypoints()).toMatchObject([{ state: "accepted", resolutionReason: "Tests cover the work" }, { state: "reported" }]);
    expect(f.k.store.events("lead", 0, 100).filter(e => e.type === "waypoint.acceptance-carried").at(-1)?.data)
      .toEqual({ fromVersion: i + 1, toVersion: i + 2, acceptances: [{ waypointId: "w1", decisionId: f.original.id }] });
  }
  f.k.undoDecision(f.original.id);
  expect(f.waypoints().map(w => w.state)).toEqual(["reported", "reported"]);
});

it("does not revive acceptance after changing and restoring a waypoint definition", async () => {
  const f = await acceptedWaypoints();
  f.k.plan("lead", { ...f.plan, waypoints: [{ ...f.one, doneWhen: "Include the edge cases" }, f.two] });
  f.k.plan("lead", f.plan);
  expect(f.waypoints().map(w => w.state)).toEqual(["reported", "accepted"]);
  expect(f.waypoints(1).map(w => w.state)).toEqual(["accepted", "accepted"]);
});

it("reopening a carried acceptance prevents another carry", async () => {
  const f = await acceptedWaypoints();
  f.k.plan("lead", f.plan);
  f.k.settle("lead", { boardQuestId: f.q.id, waypointId: "w1", as: "open", reason: "Review again" });
  f.k.plan("lead", f.plan);
  expect(f.waypoints().map(w => w.state)).toEqual(["reported", "accepted"]);
});

it("Undo says a command that already ran cannot be reversed", async () => {
  const f = await fixture();
  const d = f.k.decide("lead", { ...f.fields, source: "keeper" }, undefined, { pullRequestGrant: { digest: "a".repeat(64) } });
  f.k.undoDecision(d.id);
  expect(f.k.store.events("lead", 0, 100).filter(e => e.type === "decision.undone").at(-1)?.text).toMatch(/already ran.*cannot be reversed/i);
});

async function reviewFixture() {
  const f = setup(); databases.push(f.k.store.db);
  f.bb.sdk.plugins.list = async () => ({ plugins: [] });
  f.bb.sdk.threads.getPluginMetadata = async () => ({});
  let k: Keeper;
  const journal = registerJournal(f.bb, f.k.store.db, {
    roleOf: id => { const member = k.member(id); return member ? { ...member, checkerWaypointIds: k.checkerWaypoints(id) } : null; },
    invalidate: () => {},
    verdictSubmitted: (actor, entries) => k.recordWardenRound(actor, entries),
  });
  k = withMemberFixtures(new Keeper(f.k.store, journal, f.time, () => {}));
  const q = await seedQuest(k, "lead", "Build and check", "Checked");
  const brief = { outcome: "Build", mode: "make-it-work" as const, outOfScope: "Publish", doneWhen: "Checks pass", context: [], questions: [], timeboxMinutes: null };
  k.bind("maker", "smith", "bram", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: "w1", title: "Build", errand: false, brief });
  k.bind("warden", "warden", "vex", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: "w1", title: "Check", errand: false, brief });
  k.bind("second-warden", "warden", null, "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: "w1", title: "Second check", errand: false, brief });
  const first = checkedPlan(q.id);
  const plan = { ...first, party: [...first.party, { ...first.party[0]!, characterId: null }] };
  k.plan("lead", plan);
  k.answerAsk(k.store.openAsks("lead", q.id).find(a => a.kind === "greenlight")!.id, "approve", null, "page", "user");
  await journal.prepare("maker");
  const a = journal.linkWaypoint("maker", { boardQuestId: q.id, waypointId: "w1" }, "Check output", "maker", { kind: "tavern" });
  const ids = [a, "b2", "c3"];
  for (const id of ids.slice(1)) f.k.store.db.prepare("INSERT INTO questlog_entries(thread_id,id,board_quest_id,data) VALUES(?,?,?,?)")
    .run("maker", id, q.id, JSON.stringify(waypointEntry("maker", q.id, "w1", id)));
  const run = (threadId: string, input: unknown) => f.harness.behavior.invokeAgentTool("journal", input, { threadId });
  const evidence = [{ kind: "note" as const, ref: "Checked output", detail: "", exitCode: null }];
  const ready = async (selected = ids) => expect(await run("maker", { action: "done", ids: selected, evidence })).toEqual(expect.any(String));
  const report = (outcome: string) => k.report("maker", { status: "done", outcome, evidence, artifacts: [], confidence: null });
  const wardenCall = (warden: string, action: "verify" | "reject", selected: string[]) =>
    run(warden, { action, ids: selected, threadId: "maker", ...(action === "reject" ? { reason: "Does not meet the plan" } : {}), evidence });
  const verdict = async (...args: Parameters<typeof wardenCall>) => expect(await wardenCall(...args)).toEqual(expect.any(String));
  const runtime = new TavernRuntime(f.bb, k, f.runtime.registry);
  registerTools(f.bb, runtime);
  const reportTool = (outcome: string) => f.harness.behavior.invokeAgentTool("tavern_report", { status: "done", outcome, evidence, artifacts: [] }, { threadId: "maker" });
  const send = vi.spyOn(f.bb.sdk.threads, "send");
  const tick = async () => { f.advance(180_000); await runtime.tick("lead"); };
  const rounds = () => k.store.events("lead", 0, 100).filter(event => event.type === "waypoint.review-round");
  return { q, k, journal, plan, ids, ready, report, reportTool, verdict, wardenCall, rounds, tick, send };
}

it("counts a first review once when two Wardens verify three separate entries", async () => {
  const f = await reviewFixture();
  const [a, b, c] = f.ids as [string, string, string];
  await f.ready();
  const report = f.report("Ready for the first review");
  await f.verdict("warden", "verify", [a]);
  await f.verdict("second-warden", "verify", [b]);
  await f.verdict("warden", "verify", [c]);
  expect(f.journal.get("maker").entries.filter(e => f.ids.includes(e.id)).map(e => e.status)).toEqual(["verified", "verified", "verified"]);
  expect(f.rounds()).toEqual([expect.objectContaining({ data: expect.objectContaining({ reportId: report.id, planVersion: 1 }) })]);
  f.k.plan("lead", { ...f.plan, changeNote: "Keep the checked waypoint" });
  expect(f.k.summary(f.q.id).waypoints[0]?.state).toBe("verified");
  expect(f.k.store.events("lead", 0, 100).filter(e => e.type === "waypoint.acceptance-carried")).toEqual([]);
});

it("stores the third report, tells the maker and Keeper, and holds the review until a new plan", async () => {
  const f = await reviewFixture();
  const [a, b, c] = f.ids as [string, string, string];
  await f.ready();
  const first = f.report("Ready for review");
  await f.verdict("warden", "verify", [c]);
  await f.verdict("warden", "reject", [a]);
  await f.verdict("second-warden", "reject", [b]);
  await f.ready([a, b]);
  const second = f.report("Ready for review");
  expect(second.id).not.toBe(first.id);
  await f.verdict("warden", "reject", [a, b]);
  const rejections = f.k.store.events("lead", 0, 100).filter(event => event.data.verdict === "rejected");
  expect(rejections.map(event => event.data.reportId)).toEqual([first.id, second.id]);
  await f.ready([a, b]);
  f.k.store.patch("lead", { cursor: f.k.store.eventSequence("lead"), userAt: null, reanchor: null });
  f.k.endTurn("lead");
  const toolResult = await f.reportTool("Third attempt finished");
  expect(toolResult).toMatch(/Report written[\s\S]*w1[\s\S]*waits for the Keeper/);
  const third = f.k.store.all("reports").find(report => report.outcome === "Third attempt finished")!;
  expect(third).toMatchObject({ reviewWait: { planVersion: 1, waypointIds: ["w1"] } });
  expect(await f.wardenCall("warden", "verify", [a, b])).toMatchObject({ isError: true });
  expect(f.journal.get("maker").entries.filter(entry => [a, b].includes(entry.id)).map(entry => entry.status)).toEqual(["done", "done"]);
  expect(f.rounds()).toHaveLength(2);
  await f.tick();
  await f.tick();
  const sent = JSON.stringify(f.send.mock.calls);
  expect(sent).toContain("Third attempt finished");
  expect(sent.match(/record a new plan version before the next review/gi)).toHaveLength(1);
  f.k.plan("lead", { ...f.plan, changeNote: "Use independent test data" });
  expect(f.k.store.openAsks("lead", f.q.id)).toHaveLength(0);
  await f.verdict("warden", "verify", [a, b]);
  expect(f.rounds().map(e => [e.data.reportId, e.data.planVersion])).toEqual([[first.id, 1], [second.id, 1], [third.id, 2]]);
});
