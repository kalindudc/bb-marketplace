// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import type { Room } from "../../src/shared/contract";
import { isNewsEvent, isWakeEvent } from "../../src/server/news";
import { registerRpc, rpcHandlers } from "../../src/server/rpc";
import { registerTools } from "../../src/server/tools";
import { setup } from "./runtime-fixture";
import { concludeQuest, planInput, seedQuest, waypointEntry } from "./support";

const draft = { title: "Watch ended", body: "No alerts in **two shifts**.", links: [] };
const dbs: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

async function fixture(beforeRegistration?: (f: ReturnType<typeof setup>, questId: string) => void) {
  const f = setup(); dbs.push(f.k.store.db);
  const q = await seedQuest(f.k, "lead", "Watch the rollout", "Watch");
  const brief = { outcome: "Read the log", mode: "make-it-work" as const, outOfScope: "Deploying", doneWhen: "Log checked", context: [], questions: [], timeboxMinutes: null };
  f.k.bind("maker", "smith", "vale", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: "w1", errand: false, title: "Read the log", brief });
  f.k.bind("other", "keeper", "wren", "project");
  beforeRegistration?.(f, q.id);
  registerTools(f.bb, f.runtime);
  registerRpc(f.bb, f.runtime);
  const post = async (extra: Record<string, unknown> = {}, threadId = "lead") => {
    const result = await f.harness.behavior.invokeAgentTool("tavern_summary", { ...draft, boardQuestId: q.id, ...extra }, { threadId });
    const id = String(result).match(/::tavern-summary\{id="([^"]+)"\}/)?.[1];
    expect(id).toBeTruthy();
    return id!;
  };
  const detail = () => f.harness.invokeRpc("boardQuest", { id: q.id });
  return { ...f, q, post, detail };
}

it("records Keeper-authored news, not a Keeper wake, and refuses members and other Keepers", async () => {
  const f = await fixture();
  await expect(f.post({}, "maker")).rejects.toThrow(/only a Tavern keeper/i);
  await expect(f.post({}, "other")).rejects.toThrow(/own quest/i);
  const id = await f.post();
  expect(await f.detail()).toMatchObject({ summaries: [{ ...draft, id, keeperThreadId: "lead", boardQuestId: f.q.id, seen: false, correctedBy: null }] });
  const event = f.k.store.latestQuestEvent(f.q.id, "summary.posted")!;
  expect(event).toMatchObject({ text: draft.title, actor: { kind: "agent", threadId: "lead" }, data: { summaryId: id } });
  expect(isNewsEvent(event, "lead")).toBe(false);
  expect(isWakeEvent(event, "lead")).toBe(false);
  expect(await f.harness.invokeRpc("room", {})).toMatchObject({ recent: expect.arrayContaining([expect.objectContaining({ type: "summary.posted" })]) });
});

it("flags only routes recorded after answer tracking starts and can still search for a linked older route", async () => {
  const oldText = "Keep the original copper gauge.";
  const f = await fixture((fixture, questId) => {
    fixture.k.receiveUser("lead", oldText);
    fixture.k.route("lead", { kind: "steer", boardQuestId: questId, summary: "Keep the gauge" });
    fixture.advance(1);
  });
  const unanswered = () => f.harness.invokeRpc("unansweredMessages", { boardQuestId: f.q.id });
  expect(await unanswered()).toMatchObject({ messages: [] });
  f.k.receiveUser("lead", "Can we sign off now?");
  const question = f.k.route("lead", { kind: "question", boardQuestId: f.q.id, summary: "Asked about sign-off" });
  expect(await unanswered()).toMatchObject({ messages: [{ id: question.id, kind: "question" }] });
  const old = f.k.store.all("routes").find(route => route.userText === oldText)!;
  const id = await f.post({ answers: [old.id] });
  expect(await f.harness.invokeRpc("searchAnswers", { query: "original copper gauge" })).toMatchObject({ answers: [{ id }] });
  expect(await unanswered()).toMatchObject({ messages: [{ id: question.id }] });
  f.advance(1);
  const reopened = rpcHandlers(f.runtime);
  expect(await reopened.unansweredMessages({ boardQuestId: f.q.id })).toMatchObject({ messages: [{ id: question.id }] });
});

it("answers a quest question from its original words, without treating the route as permission", async () => {
  const f = await fixture();
  const text = "Can the watch use this evidence? " + "More context. ".repeat(20) + "OriginalSearchTerm";
  f.advance(1);
  f.k.receiveUser("lead", text);
  const question = f.k.route("lead", { kind: "question", boardQuestId: f.q.id, summary: "Asked about evidence" });
  expect(() => f.k.setQuestHeld(f.q.id, true, { kind: "agent", threadId: "lead" }, question.sourceMessageId!)).toThrow(/routed message/);
  const unanswered = () => f.harness.invokeRpc("unansweredMessages", { boardQuestId: f.q.id });
  expect(await unanswered()).toMatchObject({ messages: [{ id: question.id, text, kind: "question" }] });
  const first = await f.post({ answers: [question.id, question.id] });
  expect(await unanswered()).toMatchObject({ messages: [] });
  expect(await f.harness.invokeRpc("summary", { id: first, threadId: "lead" })).toMatchObject({ summary: {
    answers: [question.id], answerMessages: [{ id: question.id, text, kind: "question" }], questTitle: f.q.title,
  } });
  await expect(f.post({ answers: ["missing"] })).rejects.toThrow(/route/);
  const replacement = await f.post({ answers: [question.id], supersedes: first });
  const search = (query: string) => f.harness.invokeRpc("searchAnswers", { query, boardQuestId: f.q.id });
  expect(await search("originalsearchterm")).toMatchObject({ answers: [{ id: replacement, correctedBy: null }, { id: first, correctedBy: replacement }] });
  await f.post({ answers: [], supersedes: replacement });
  expect(await unanswered()).toMatchObject({ messages: [{ id: question.id }] });
});

it("scopes route links to their Keeper and quest, but searches the whole Tavern", async () => {
  const f = await fixture();
  const other = await seedQuest(f.k, "other", "Survey the bridge", "Survey");
  f.k.receiveUser("other", "Look under the stone arch.");
  const steer = f.k.route("other", { kind: "steer", boardQuestId: other.id, summary: "Inspect the arch" });
  await expect(f.post({ answers: [steer.id] })).rejects.toThrow(/route/);
  const answer = await f.post({ boardQuestId: other.id, title: "Bridge survey", body: "Ice has not formed.", answers: [steer.id], results: { figures: [{ label: "Arches", value: "1" }] } }, "other");
  const search = (query: string, boardQuestId?: string) => f.harness.invokeRpc("searchAnswers", { query, boardQuestId });
  expect(await search("stone arch", f.q.id)).toMatchObject({ answers: [] });
  for (const query of ["stone arch", "Survey the bridge", "result", "Ice has not formed"]) {
    expect(await search(query)).toMatchObject({ answers: [{ id: answer, questTitle: other.title }] });
  }
  expect(await f.harness.invokeRpc("unansweredMessages", { boardQuestId: f.q.id })).toMatchObject({ messages: [] });
});

it("uses the configured page size and keeps answer push opt-in", async () => {
  const f = await fixture();
  const original = f.runtime.config();
  const push = vi.spyOn(f.runtime.alerts, "deliver").mockResolvedValue({ outcome: "sent" });
  const config = vi.spyOn(f.runtime, "config").mockReturnValue({ ...original, attention: { ...original.attention, answerPageSize: 1 } });
  const first = await f.post({ title: "First watch result" });
  expect(push).not.toHaveBeenCalled();
  config.mockReturnValue({ ...original, attention: { ...original.attention, answerPageSize: 1, pushAnswers: true } });
  const last = await f.post({ title: "Final watch result" });
  expect(push).toHaveBeenCalledExactlyOnceWith("New Keeper answer", "Final watch result", "lead");
  const page = await rpcHandlers(f.runtime).searchAnswers({ query: "watch result" });
  expect(page.answers.map(answer => answer.id)).toEqual([last]);
  expect((await rpcHandlers(f.runtime).searchAnswers({ query: "watch result", before: page.nextCursor! })).answers.map(answer => answer.id)).toEqual([first]);
  expect(await f.detail()).toMatchObject({ summariesNextCursor: last });
});

it("folds an append-only correction under its new summary and drops the old item from attention", async () => {
  const f = await fixture();
  const old = await f.post();
  const correction = await f.post({ title: "One alert", supersedes: old });
  expect(await f.detail()).toMatchObject({ summaryCounts: { current: 1, corrected: 1 }, summaries: [{ id: correction, supersedes: old, correctedBy: null, previousTitle: draft.title }] });
  expect(await f.harness.invokeRpc("summary", { id: old, threadId: "lead" })).toMatchObject({ summary: { id: old, correctedBy: correction, title: draft.title } });
  expect(f.k.store.latestQuestEvent(f.q.id, "summary.posted")?.data).toMatchObject({ summaryId: correction, supersedes: old });
  expect(await f.harness.invokeRpc("ledger", { threadId: "lead" })).toMatchObject({ attention: { new: 1, summaries: 1, items: [{ id: correction, kind: "summary", title: "One alert", seen: false }] } });
  await expect(f.post({ supersedes: "missing" })).rejects.toThrow(/earlier summary/i);
  await expect(f.post({ supersedes: old })).rejects.toThrow(/already corrected/i);
});

it("counts the same unseen summary across views and acknowledges only the IDs read", async () => {
  const f = await fixture();
  const first = await f.post();
  const room = await f.harness.invokeRpc("room", {}) as Room;
  const decor = await f.harness.invokeRpc("decor", { threadId: "lead" });
  expect(room).toMatchObject({ attention: { new: 1 } });
  expect(room.keepers.find(keeper => keeper.member.threadId === "lead")).toMatchObject({ boardQuests: [{ attention: { summaries: 1 } }] });
  expect(decor).toMatchObject({ keeperView: { attention: { new: 1 }, boardQuests: [{ attention: { summaries: 1 } }] } });
  expect(await f.detail()).toMatchObject({ summaries: [{ id: first, seen: false }] });
  const next = await f.post({ title: "Another result" });
  await f.harness.invokeRpc("markSummariesSeen", { boardQuestId: f.q.id, ids: [first] });
  expect(f.k.store.get("attentionSeen", first)).toMatchObject({ seenAt: f.time() });
  expect(await f.detail()).toMatchObject({ attention: { new: 1 }, summaries: [{ id: next, seen: false }, { id: first, seen: true }] });
  await f.harness.invokeRpc("markSummariesSeen", { boardQuestId: f.q.id, ids: [next] });
  expect(await f.harness.invokeRpc("room", {})).toMatchObject({ attention: { new: 0 } });
});

it("shows a soft reminder but permits a seventh summary and requires linked requests to belong to the quest", async () => {
  const f = await fixture();
  const another = await seedQuest(f.k, "other", "Another goal", "Another");
  const note = f.k.memory.note("other", { kind: "waiting-on-user", text: "Check the dashboard", action: "Check the dashboard", need: "Please check the dashboard.", boardQuestId: another.id });
  await expect(f.post({ request: { kind: "hand-back", id: note.id } })).rejects.toThrow(/hand-back.*quest/i);
  for (let i = 1; i <= 7; i++) await f.post({ title: `Result ${i}` });
  const restatement = f.k.restatement("lead");
  expect(restatement).toMatch(/6 summaries per quest per day/i);
  expect(restatement).toContain("Watch: 7 summaries today");
  expect(restatement.indexOf("Summary reminder")).toBeGreaterThan(restatement.indexOf("Standing rules"));
  expect(await f.detail()).toMatchObject({ attention: { new: 7 } });
});

it("keeps one summary in Ledger attention and widget titles behind 25 newer calls", async () => {
  const f = await fixture();
  const id = await f.post();
  for (let i = 0; i < 25; i++) f.k.decide("lead", { boardQuestId: f.q.id, text: `Call ${i}`, why: "Reversible", source: "keeper", reversible: true });
  const rpc = rpcHandlers(f.runtime);
  for (const view of [await rpc.ledger({ threadId: "lead" }), (await rpc.decor({ threadId: "lead" })).keeperView!]) {
    expect(view.attention).toMatchObject({ new: 26, summaries: 1, decided: 25 });
    expect(view.attention?.items).toEqual(expect.arrayContaining([expect.objectContaining({ id, kind: "summary" })]));
  }
});

it("bounds seen summary history on boardQuest with 300 full-length records on one quest", async () => {
  const f = await fixture();
  const rpc = rpcHandlers(f.runtime);
  const notes = Array.from({ length: 300 }, (_, i) => ({ ...draft, id: `summary-${i}`, keeperThreadId: "lead", boardQuestId: f.q.id, createdAt: f.time(), title: `Note ${i}`, body: "x".repeat(4000) }));
  f.k.store.atomic(() => notes.forEach((note, i) => {
    f.k.store.put("summaries", note.id, note);
    if (i !== 0) f.k.store.put("attentionSeen", note.id, { token: "test", seenAt: f.time() });
  }));
  const start = performance.now();
  const page = await rpc.boardQuest({ id: f.q.id });
  const ms = performance.now() - start;
  expect(page.summaryCounts).toEqual({ current: 300, corrected: 0 });
  expect(page.summaries?.filter(summary => summary.body !== undefined)).toHaveLength(4);
  expect(page.summaries?.some(summary => summary.id === notes[0]?.id && !summary.seen)).toBe(true);
  expect(page.summaries!.length).toBeLessThan(25);
  const next = await rpc.olderSummaries({ boardQuestId: f.q.id, beforeId: page.summariesNextCursor! });
  expect(next.summaries.length).toBeGreaterThan(0);
  expect(next.summaries.every(summary => summary.body === undefined)).toBe(true);
  const bytes = Buffer.byteLength(JSON.stringify(page));
  process.stdout.write(`SUMMARY_HISTORY ${JSON.stringify({ ms, bytes, entries: page.summaries?.length })}\n`);
  expect(bytes).toBeLessThan(50_000);
});

it("finishes a quest with reports, waypoint changes and events but no automatic summary", async () => {
  const f = await fixture();
  const input = planInput(f.q.id);
  f.k.plan("lead", { ...input, waypoints: [{ ...input.waypoints[0]!, owner: "maker", check: "none" }] });
  f.k.answerAsk(f.k.store.openAsks("lead", f.q.id)[0]!.id, "approve", null, "page", "user");
  const entry = waypointEntry("maker", f.q.id);
  f.port.linkedEntries = () => [entry];
  const get = f.port.get;
  f.port.get = threadId => ({ ...get(threadId), entries: threadId === "maker" ? [entry] : [] });
  f.k.report("maker", { status: "done", outcome: "The log is clear", evidence: [], artifacts: [], confidence: null, voice: null });
  await concludeQuest(f.runtime, "lead", f.q.id, "The watch ended", "");
  expect(await f.detail()).toMatchObject({ quest: { phase: "done" }, summaries: [] });
  expect(f.k.store.latestQuestEvent(f.q.id, "summary.posted")).toBeNull();
  await expect(f.post()).rejects.toThrow(/active quest/i);
});
