// @vitest-environment node
import { expect, it, vi } from "vitest";
import { localClock } from "../../src/server/clock";
import { InsightsReader } from "../../src/server/insights";
import { SettingsStore } from "../../src/server/settings/store";
import { registerTools } from "../../src/server/tools";
import { dispatch049, queued049 } from "./dispatch-fixture";
import { makeThreadResponse } from "./host";
import { putMemberFixture } from "./member-fixture";
import { setup } from "./runtime-fixture";
import { seedQuest } from "./support";

async function fixture() {
  const f = setup();
  const q = await seedQuest(f.k, "lead", "Watch the tracker", "Watch");
  const brief = { outcome: "Check the tracker", mode: "make-it-work" as const, doneWhen: "Report changes",
    outOfScope: "Writes", context: [], questions: [], timeboxMinutes: null };
  f.k.bind("member", "ranger", "lark", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null,
    errand: false, title: "Watch", brief });
  f.runtime.spawnBriefDelivered("member");
  const settings = new SettingsStore(f.k.store.db, f.time);
  f.runtime.enableSettings(settings, new InsightsReader(f.k.store.db, settings, f.time));
  registerTools(f.bb, f.runtime);
  const send = vi.spyOn(f.bb.sdk.threads, "send");
  const messages = (threadId = "member") => send.mock.calls.filter(([args]) => args.threadId === threadId).flatMap(([args]) =>
    args.input.filter(p => p.type === "text"));
  const terminal = (status = "completed", type = "turn/completed") =>
    [{ type, seq: f.time(), data: { status, reason: "manual-stop" }, createdAt: f.time() }] as never;
  const history = vi.spyOn(f.bb.sdk.threads.events, "list").mockImplementation(async args =>
    args.threadId === "member" ? terminal() : []);
  const idle = (status: "idle" | "error" = "idle") =>
    f.runtime.memberEnded(makeThreadResponse({ id: "member", status }), "The public tracker is unchanged.");
  return { ...f, q, settings, send, messages, history, terminal, idle };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const report = { status: "needs-decision" as const, outcome: "Waiting for source", evidence: [], artifacts: [], voice: null, confidence: null };

it("sends one private nudge per brief, including after duplicate idle events", async () => {
  const f = await fixture();
  await Promise.all([f.idle(), f.idle()]);
  expect(f.messages()).toEqual([expect.objectContaining({ visibility: "agent-only", text: expect.stringMatching(
    /ended without a Tavern report.*tavern_report.*waiting.*declared wait.*ignore/s) })]);
  f.advance(1000);
  f.runtime.briefed("member");
  await f.idle();
  expect(f.messages()).toHaveLength(2);
  const reminder = dispatch049({ threadId: "member", pluginId: "tavern", text: f.messages()[1]!.text });
  expect(await f.runtime.dispatch(reminder)).toMatchObject({ action: "proceed" });
  f.advance(1000);
  expect(await f.runtime.dispatch(reminder)).toMatchObject({ action: "reject" });
});

it.each([
  ["disabled", (f: Fixture) => f.settings.update({ revision: 0, patch: { keepers: { unreportedNudges: false } }, why: "Fewer nudges" })],
  ["pending wake-up", (f: Fixture) => vi.spyOn(f.bb.sdk.threads, "experimental_listPluginMetadata").mockResolvedValue(
    { threads: [{ threadId: "member", metadata: { wakeups: { version: 1, pending: ["wake"], untilAt: f.time() + 50_000 } } }] })],
  ["declared wait", (f: Fixture) => {
    f.k.report("member", { ...report, wait: { condition: "Source becomes available", dueAt: f.time() + 60_000 } });
    // A report from the previous brief can still hold a current member on a declared wait.
    f.k.store.patch("member", { reportedBriefVersion: 0 });
  }],
  ["failed turn", (f: Fixture) => f.history.mockImplementation(async () => f.terminal("failed"))],
  ["interrupted turn", (f: Fixture) => f.history.mockImplementation(async () => f.terminal("interrupted"))],
  ["user stop", (f: Fixture) => f.history.mockImplementation(async () => f.terminal("completed", "system/thread/interrupted"))],
  ["unknown turn ending", (f: Fixture) => f.history.mockResolvedValue([])],
  ["Keeper stop", (f: Fixture) => putMemberFixture(f.k.store, "member", { engagement: "stopping" })],
  ["Stop all", (f: Fixture) => f.runtime.stopAll.stop({ kind: "user" })],
  ["paused", (f: Fixture) => f.settings.update({ revision: 0, patch: { tavern: { paused: true } }, why: "Paused" })],
  ["releasing", (f: Fixture) => putMemberFixture(f.k.store, "member", { engagement: "releasing" })],
  ["archiving", (f: Fixture) => putMemberFixture(f.k.store, "member", { engagement: "archiving" })],
  ["archived", (f: Fixture) => putMemberFixture(f.k.store, "member", { engagement: "archived" })],
  ["quest held", (f: Fixture) => f.k.setQuestHeld(f.q.id, true, { kind: "user" })],
  ["already reported", (f: Fixture) => f.k.report("member", report)],
] as const)("does not nudge on %s", async (_, arrange) => {
  const f = await fixture();
  await arrange(f);
  f.send.mockClear();
  await f.idle();
  expect(f.messages()).toHaveLength(0);
});

it("does not nudge an error-status thread", async () => {
  const f = await fixture();
  await f.idle("error");
  expect(f.messages()).toHaveLength(0);
});

it("quotes a refused report, but not if another Tavern call followed it", async () => {
  const f = await fixture();
  const refuse = async () => {
    try {
      await f.harness.behavior.invokeAgentTool("tavern_report", {}, { threadId: "member" });
    } catch (error) { return (error as Error).message; }
    throw new Error("Expected a refusal");
  };
  const reason = await refuse();
  await f.idle();
  expect(f.messages()[0]?.text).toContain(JSON.stringify(reason));

  f.runtime.briefed("member");
  await refuse();
  await expect(f.harness.behavior.invokeAgentTool("tavern_status", {}, { threadId: "member" })).rejects.toThrow(/keeper/);
  await f.idle();
  expect(f.messages()[1]?.text).not.toContain("refused");
});

it("rejects a nudge at dispatch if the quest was held after the send began", async () => {
  const f = await fixture();
  let admission: unknown;
  f.send.mockImplementation(async args => {
    const text = args.input.find(p => p.type === "text")!.text;
    f.k.setQuestHeld(f.q.id, true, { kind: "user" });
    admission = await f.runtime.dispatch(dispatch049({ threadId: "member", pluginId: "tavern", text }));
    return { ok: true, delivery: "sent" };
  });
  await f.idle();
  expect(admission).toMatchObject({ action: "reject" });
});

it.each(["user", "keeper"])("does not block a %s message grouped with an obsolete nudge", async sender => {
  const f = await fixture();
  await f.idle();
  const reminder = { ...queued049("reminder", f.messages()[0]!.text, f.time(), { pluginId: "tavern", retry: true }),
    threadId: "member", groupWithNext: true, content: f.messages() };
  f.advance(1000);
  const followUp = { ...queued049("follow-up", "Check the new issue", f.time(),
    sender === "keeper" ? { pluginId: "tavern", senderThreadId: "lead" } : {}), threadId: "member" };
  expect(await f.runtime.dispatch(dispatch049({ threadId: "member", rows: [reminder, followUp] }))).toMatchObject({ action: "proceed" });
});

it("keeps the scheduled round's unreported fact and only skips the nudge", async () => {
  const f = await fixture();
  putMemberFixture(f.k.store, "member", { permanent: { why: "Watch", decisionId: "standing", schedules: [
    { id: "morning", cadence: "daily", at: "07:00", duty: "Read the tracker", nextAt: f.time() },
  ] } });
  const scheduled = dispatch049({ threadId: "member", pluginId: "tavern", text: `[Tavern schedule] morning ${f.time()}\nScheduled round (daily 07:00): Read the tracker` });
  expect(await f.runtime.dispatch(scheduled)).toMatchObject({ action: "proceed" });
  await f.idle();
  await f.idle();
  expect(f.messages()).toHaveLength(0);
  const events = f.k.store.events("lead").filter(e => e.type === "member.unreported");
  expect(events).toEqual([expect.objectContaining({ data: expect.objectContaining({
    excerpt: "The public tracker is unchanged.", strikes: 1,
  }) })]);
  expect(f.k.member("member")).toMatchObject({ doing: "The public tracker is unchanged.", strikes: 1 });
  f.advance(f.runtime.config().knobs.afterMessageHoldSeconds * 1000);
  await f.runtime.tick("lead");
  expect(f.messages("lead")[0]?.text).toContain("The public tracker is unchanged.");

  f.advance(1000);
  f.runtime.briefed("member");
  expect(await f.runtime.dispatch(dispatch049({ threadId: "member", pluginId: "tavern", text: "Check the new issue" }))).toMatchObject({ action: "proceed" });
  await f.idle();
  expect(f.messages()).toHaveLength(1);
});

it("tells the Keeper about a quiet watcher even with no other news, without waking it on every sweep", async () => {
  const f = await fixture();
  f.settings.update({ revision: 0, patch: { keepers: { permanentQuietMinutes: 10 } }, why: "Check sooner" });
  putMemberFixture(f.k.store, "member", { permanent: { why: "Watch", decisionId: "standing" } });
  f.k.store.patch("lead", { cursor: f.k.store.events("lead").at(-1)!.id, reanchor: null, userAt: null });
  f.advance(11 * 60_000);
  await f.runtime.tick("lead");
  expect(f.messages("lead")).toHaveLength(1);
  f.advance(61_000);
  await f.runtime.tick("lead");
  expect(f.messages("lead")).toHaveLength(1);
  f.k.report("member", report);
  await f.runtime.tick("lead");
  const settled = f.messages("lead").length;
  f.advance(11 * 60_000);
  await f.runtime.tick("lead");
  expect(f.messages("lead")).toHaveLength(settled + 1);
});

it("turns off permanent member quiet facts when the window is set to zero", async () => {
  const f = await fixture();
  f.settings.update({ revision: 0, patch: { keepers: { permanentQuietMinutes: 0 } }, why: "Turn off quiet checks" });
  putMemberFixture(f.k.store, "member", { permanent: { why: "Watch", decisionId: "standing" } });
  f.k.store.patch("lead", { cursor: f.k.store.events("lead").at(-1)!.id, reanchor: null, userAt: null });
  f.advance(45 * 24 * 60 * 60_000);
  await f.runtime.tick("lead");
  expect(f.k.store.events("lead").filter(e => e.type === "member.permanent-quiet")).toEqual([]);
  expect(f.messages("lead")).toEqual([]);
});

it("adds one fact per quiet permanent member and uses the latest report or journal timestamp", async () => {
  const f = await fixture();
  f.settings.update({ revision: 0, patch: { keepers: { permanentQuietMinutes: 10 } }, why: "Check sooner" });
  const original = f.k.member("member")!;
  putMemberFixture(f.k.store, "member", { permanent: { why: "Watch", decisionId: "standing" }, lastReportAt: f.time() + 60_000 });
  const quietJournalAt = f.time() + 120_000;
  const quietReportAt = f.time() + 180_000;
  for (const id of ["report-newer", "fresh", "never", "released", "temporary"]) {
    f.k.bind(id, "ranger", "lark", "project", { keeperThreadId: "lead", boardQuestId: f.q.id, waypointId: null,
      errand: false, title: id, brief: f.k.store.runtime("member").brief! });
    putMemberFixture(f.k.store, id, { permanent: id === "temporary" ? undefined : { why: "Watch", decisionId: id },
      engagement: id === "released" ? "released" : "active",
      lastReportAt: id === "report-newer" ? quietReportAt : null });
  }
  const progress = f.k.journal.progress.bind(f.k.journal);
  vi.spyOn(f.k.journal, "progress").mockImplementation(id => ({
    ...progress(id), ...(id === "fresh" ? { lastEvidenceAt: f.time() - 10 * 60_000 } :
      id === "member" || id === "report-newer" ? { lastEvidenceAt: quietJournalAt } : {}),
  }));
  f.advance(14 * 60_000);
  f.k.store.event(f.time(), "lead", f.q.id, "promise.due", "A tick fact");
  await f.runtime.tick("lead");
  const tick = f.messages("lead")[0]!.text;
  const facts = tick.split("\n").filter(line => line.includes('"type":"member.permanent-quiet"'));
  expect(facts).toHaveLength(3);
  expect(facts).toEqual(expect.arrayContaining([
    expect.stringContaining(localClock(quietJournalAt)),
    expect.stringContaining(localClock(quietReportAt)),
    expect.stringContaining(`No report or journal evidence since ${localClock(original.createdAt)}`),
  ]));
  expect(tick).toMatch(/check that each live member is working, waiting on something named, or has reported.*nudge, wait or release/i);
  expect(tick).toMatch(/you decide what to tell the user.*something changed.*needs to decide.*without a reply/i);
});
