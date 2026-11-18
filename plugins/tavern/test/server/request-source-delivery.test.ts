// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureRequestSources, requestSourcePacket } from "../../src/server/request-sources";
import { registerTools } from "../../src/server/tools";
import { setup } from "./runtime-fixture";
import { makePluginAgentConfigurationContext } from "./host";
import { planInput, waypointEntry } from "./support";

const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const raw = 'SOURCE_ONLY_original: for NaN return exactly "unknown".';
const brief = { outcome: "Return unknown items", mode: "make-it-work" as const, outOfScope: "Publish", doneWhen: "Tests pass", context: [], questions: [], timeboxMinutes: null };
async function fixture(classId = "smith") {
  const f = setup(); databases.push(f.k.store.db);
  f.k.receiveUser("lead", raw); f.k.route("lead", { kind: "new-quest", summary: "Format counts", notes: [] });
  const q = await f.k.openQuest("lead", "Format", "Counts");
  const plan = planInput(q.id);
  if (classId === "warden") {
    f.k.bind("maker", "smith", "juno", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: "w1", title: "Make", errand: false, brief });
    const entry = waypointEntry("maker", q.id), get = f.port.get;
    f.port.get = id => ({ ...get(id), entries: id === "maker" ? [entry] : [] }); f.port.linkedEntries = () => [entry];
  }
  f.k.plan("lead", { ...plan, ...(classId === "warden" ? { waypoints: [{ ...plan.waypoints[0]!, owner: "maker" }] } : {}), party: [{ classId, characterId: null, model: null, purpose: "Work", waypointIds: ["w1"] }] });
  f.k.answerAsk(f.k.store.openAsks("lead").find(ask => ask.kind === "greenlight")!.id, "approve", null, "page", "user");
  return { ...f, q, input: { classId, title: "Work", boardQuestId: q.id, waypointId: "w1", brief } };
}

describe("verbatim user sources at native brief delivery", () => {
  it.each(["smith", "warden"])("attaches the original request to an initial %s hire without putting it in session memory", async classId => {
    const f = await fixture(classId), member = await f.runtime.hire("lead", "project", f.input);
    const spawn = f.harness.inspection.sdk.callsTo("threads.spawn")[0]!.args[0] as { input: { text: string }[] };
    const text = spawn.input[0]!.text;
    expect(text).toContain("Return unknown items"); expect(text).toContain(raw);
    expect(text.split("User request, verbatim")[1]).not.toContain("Return unknown items");
    const manifest = f.k.store.runtime(member.threadId).requestSources!;
    expect(text).toContain(manifest.id);
    expect(f.k.store.runtime(member.threadId).brief).toEqual(brief);
    expect(f.runtime.configure(makePluginAgentConfigurationContext({ thread: { id: member.threadId } })).instructions).not.toContain("SOURCE_ONLY_original");
  });
  it("freezes a follow-up packet across retries and keeps only assignment text in accumulated context", async () => {
    const f = await fixture(), manifest = captureRequestSources(f.k, "lead", f.q.id);
    f.k.bind("child", "smith", "juno", "project", { keeperThreadId: "lead", boardQuestId: f.q.id, waypointId: "w1", title: "Work", errand: false, brief, requestSources: manifest });
    f.runtime.spawnBriefDelivered("child");
    f.k.receiveUser("lead", 'SOURCE_ONLY_steer: keep "unknown" exactly.'); f.k.route("lead", { kind: "steer", boardQuestId: f.q.id, summary: "Use unknown items", notes: [] });
    const send = vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValueOnce(new Error("temporarily offline"));
    await f.runtime.tell("lead", "child", "Return unknown items");
    const pending = f.k.store.runtime("child").pendingBrief!;
    expect(pending.assignmentText).toBe("Return unknown items"); expect(pending.text).toContain(raw); expect(pending.text).toContain("SOURCE_ONLY_steer");
    const id = pending.requestSources!.id;
    f.k.receiveUser("lead", "SOURCE_ONLY_later: unrelated new steer."); f.k.route("lead", { kind: "steer", boardQuestId: f.q.id, summary: "Later", notes: [] });
    await f.runtime.tell("lead", "child", "Return unknown items");
    expect(f.k.store.runtime("child").pendingBrief!.id).toBe(pending.id);
    expect(f.k.store.runtime("child").pendingBrief!.requestSources!.id).toBe(id);
    f.advance(60_001); await f.runtime.retryInitialBriefs("lead");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0].input).toEqual(send.mock.calls[0]![0].input);
    const state = f.k.store.runtime("child");
    expect(state.pendingBrief).toBeNull(); expect(state.requestSources!.id).toBe(id);
    expect(state.brief!.context).toContain("Follow-up v2: Return unknown items");
    expect(JSON.stringify(state.brief)).not.toContain("SOURCE_ONLY");
    expect(f.k.store.events("lead", 0, 200).filter(event => event.type === "member.told").every(event => !event.text.includes("SOURCE_ONLY"))).toBe(true);
    expect(f.runtime.configure(makePluginAgentConfigurationContext({ thread: { id: "child" } })).instructions).not.toContain("SOURCE_ONLY");
  });
  it("keeps a deferred initial packet out of both accumulated context and told events", async () => {
    const f = await fixture(), manifest = captureRequestSources(f.k, "lead", f.q.id), assignmentText = "The Keeper assigned formatting.";
    f.k.bind("deferred", "smith", "juno", "project", { keeperThreadId: "lead", boardQuestId: f.q.id, waypointId: "w1", title: "Work", errand: false, brief, requestSources: manifest, assignmentText });
    await f.runtime.sendInitialBrief("deferred", `${assignmentText}\n\n${requestSourcePacket(f.k, manifest)}`);
    expect(f.k.store.runtime("deferred")).toMatchObject({ initialBriefAt: expect.any(Number), brief: { context: [] }, assignmentText, requestSources: { id: manifest.id } });
    expect(f.k.store.events("lead", 0, 200).filter(event => event.type === "member.told").every(event => event.text === assignmentText)).toBe(true);
  });
  it("offers members only the scoped source tool and leaves the status tool Keeper-only", async () => {
    const f = await fixture(), child = await f.runtime.hire("lead", "project", f.input);
    const manifest = f.k.store.runtime(child.threadId).requestSources!;
    registerTools(f.bb, f.runtime);
    const memberConfig = f.runtime.configure(makePluginAgentConfigurationContext({ thread: { id: child.threadId } }));
    expect(memberConfig.tools).toContain("tavern_request_sources"); expect(memberConfig.tools).not.toContain("tavern_status");
    const member = { threadId: child.threadId }, keeper = { threadId: "lead" };
    const invoke = f.harness.behavior.invokeAgentTool;
    expect(JSON.parse(await invoke("tavern_request_sources", { manifestId: manifest.id }, member) as string)).toMatchObject({ text: raw });
    await expect(invoke("tavern_status", { section: "requests", memberThreadId: child.threadId }, member)).rejects.toThrow(/Keeper/i);
    await expect(invoke("tavern_request_sources", { manifestId: manifest.id }, keeper)).rejects.toThrow(/member/i);
    expect(JSON.parse(await invoke("tavern_status", { section: "requests", memberThreadId: child.threadId, manifestId: manifest.id }, keeper) as string)).toMatchObject({ text: raw });
    await expect(invoke("tavern_request_sources", { manifestId: manifest.id, memberThreadId: "other" }, member)).rejects.toThrow();
  });
});
