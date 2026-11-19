// @vitest-environment node
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS } from "../../src/server/migrations";
import { KeeperStore } from "../../src/server/keeper/store";
import { ANSWER_END, ANSWER_START } from "../../src/server/voice-check/rules";
import { SITUATIONS } from "../../src/server/voice-check/situations";
import { isVoiceCheckThread, VoiceCheckRunner, type VoiceCheckDeps, type VoiceCheckSdk } from "../../src/server/voice-check/run";

const dbs: Database.Database[] = [];
// As bb's model picker names them; the run must show these, with the raw id kept beside them.
const NAMES: Record<string, string> = { "gpt-5.1": "GPT-5.1", "claude-haiku-4-5": "Claude Haiku 4.5" };
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

const reference = Object.fromEntries(SITUATIONS.map((s) => [s.id, s.reference]));
const marked = (value: unknown) => `${ANSWER_START}\n${JSON.stringify(value)}\n${ANSWER_END}`;
const allPass = Object.fromEntries(SITUATIONS.map((s) => [s.id, { pass: true, quote: "" }]));
const draft = { name: "Wren", style: "Speaks like a ship's navigator, all bearings and tides.", quirks: ["charts every course"] };

type Fake = { id: string; status: string; meta: Record<string, unknown>; parent: string | null; spawn: Record<string, unknown>; events: { seq: number; type: string; data: unknown }[] };
function fixture(opts: { writer?: (prompt: string) => string | null; judge?: (prompt: string) => string | null; models?: Record<string, string[]>; burn?: boolean; unavailable?: string[]; push?: boolean; ownError?: boolean } = {}) {
  let clock = 1_800_000_000_000;
  const threads = new Map<string, Fake>(), calls: [string, unknown][] = [];
  let n = 0;
  const reply = (t: Fake) => {
    const text = String((t.spawn.input as { text: string }[])[0]!.text);
    if (t.meta.voiceCheck === "parent") return "ok";
    return t.spawn.model === "claude-haiku-4-5" ? (opts.judge ?? (() => marked(allPass)))(text) : (opts.writer ?? (() => marked(reference)))(text);
  };
  const sdk = {
    threads: {
      spawn: async (args: Record<string, unknown>) => {
        calls.push(["spawn", args]);
        if (args.parentThreadId && !threads.get(String(args.parentThreadId))?.events.length) throw new Error("HTTP 500: parent has never run");
        const id = `thr_fake${++n}`;
        threads.set(id, { id, status: typeof args.sendAt === "number" && args.sendAt > clock ? "pending" : "starting", meta: (args.pluginMetadata ?? {}) as Record<string, unknown>, parent: (args.parentThreadId as string) ?? null, spawn: args, events: [] });
        return { id, status: "starting" };
      },
      get: async ({ threadId }: { threadId: string }) => {
        const t = threads.get(threadId);
        if (!t) throw Object.assign(new Error("HTTP 404: Thread not found"), { status: 404 });
        if (t.status === "pending" && clock >= (t.spawn.sendAt as number)) { calls.push(["sent", threadId]); t.status = "starting"; }
        if (t.status === "starting" && opts.unavailable?.includes(String(t.spawn.model))) {
          // As live on 14 Nov: the catalog lists the model, but the provider can't serve it.
          t.events.push({ seq: 1, type: "provider/error", data: { message: "Provider error", detail: '404 {"type":"error","error":{"type":"not_found_error","message":"Model not found, inaccessible, and/or not deployed"}}' } });
          t.status = "error";
        }
        if (t.status === "starting") {
          const text = reply(t);
          if (text === null) t.status = "active";
          else {
            // Another plugin (cortex) answers after the prompt too: the check must read the first marked answer.
            t.events.push({ seq: 1, type: "item/completed", data: { item: { type: "agentMessage", text } } },
              { seq: 2, type: "item/completed", data: { item: { type: "agentMessage", text: "I got the cortex memory list." } } },
              { seq: 3, type: "thread/tokenUsage/updated", data: { tokenUsage: { total: { totalTokens: 66_000 } } } });
            t.status = "idle";
          }
        }
        return { id: t.id, status: t.status, parentThreadId: t.parent };
      },
      delete: async ({ threadId }: { threadId: string }) => { calls.push(["delete", threadId]); threads.delete(threadId); return { ok: true as const }; },
      stop: async ({ threadId }: { threadId: string }) => { calls.push(["stop", threadId]); return {}; },
      getPluginMetadata: async ({ threadId }: { threadId: string }) => { const t = threads.get(threadId); if (!t) throw Object.assign(new Error("HTTP 404"), { status: 404 }); return t.meta; },
      // As bb does: at most 100 events a page (live on 14 Nov, 200 was refused with HTTP 400), read after a sequence number.
      events: { list: async ({ threadId, types, limit, afterSeq }: { threadId: string; types?: string[]; limit?: string; afterSeq?: string }) => {
        if (opts.ownError && types?.includes("item/completed")) throw new Error("HTTP 400: Thread event limit cannot exceed 100");
        if (Number(limit ?? 50) > 100) throw Object.assign(new Error("HTTP 400: Thread event limit cannot exceed 100"), { status: 400 });
        return (threads.get(threadId)?.events ?? []).filter((e) => (!types || types.includes(e.type)) && e.seq > Number(afterSeq ?? 0)).slice(0, Number(limit ?? 50)).map((e) => ({ ...e, threadId, createdAt: clock }));
      } },
      list: async () => { calls.push(["list", null]); return []; },
      search: async () => { calls.push(["search", null]); return []; },
    },
    projects: { list: async () => [{ id: "proj_tavern", kind: "standard" }, { id: "proj_personal", kind: "personal" }] },
    providers: {
      list: async () => Object.keys(opts.models ?? { pi: ["gpt-5.1", "claude-haiku-4-5"] }).map((id) => ({ id, available: true })),
      models: async ({ providerId }: { providerId: string }) => ({ models: (opts.models ?? { pi: ["gpt-5.1", "claude-haiku-4-5"] })[providerId]!.map((model) => ({ id: model, model, displayName: NAMES[model] ?? model, routeProviderId: null, isDefault: false })), selectedOnlyModels: [], providers: [] }),
    },
    plugins: {
      list: async () => ({ plugins: [...(opts.burn ? [{ id: "burn", enabled: true }] : []), ...(opts.push ? [{ id: "push-notifications", enabled: true }] : [])] }),
      callRpc: async ({ pluginId, method, input }: { pluginId: string; method: string; input: { threadId: string; level?: string } }) => {
        if (pluginId === "push-notifications") { calls.push(["notify-level", { ...input, status: threads.get(input.threadId)?.status }]); return { ok: true }; }
        return { report: { cost: { total: input.threadId === "thr_fake2" ? 0.02 : 0.004 } }, family: { children: [] } };
      },
    },
  };
  const db = new Database(":memory:"); dbs.push(db);
  for (const m of MIGRATIONS) db.exec(m);
  const store = new KeeperStore(db), invalidated: string[] = [];
  const deps = (): VoiceCheckDeps => ({
    bb: { sdk: sdk as unknown as VoiceCheckSdk }, store, pluginId: "tavern", now: () => clock,
    // Each poll yields to the event loop, as a real wait does, so a cancel or a restart can land mid-run.
    sleep: async (ms) => { clock += ms; await new Promise((r) => setTimeout(r, 0)); }, log: () => {}, invalidate: (tags) => invalidated.push(...tags),
    writer: async () => ({ providerId: "pi", model: "gpt-5.1" }),
    character: () => undefined,
  });
  const make = () => new VoiceCheckRunner(deps());
  return { deps, sdk, threads, calls, store, invalidated, make, runner: make(), tick: (ms: number) => { clock += ms; } };
}
const depsOf = (f: ReturnType<typeof fixture>) => f.deps();
const spawns = (f: ReturnType<typeof fixture>) => f.calls.filter(([c]) => c === "spawn").map(([, a]) => a as Record<string, unknown>);

describe("the voice check run", () => {
  it("refuses a new check while Tavern is stopped without spawning or deleting threads", () => {
    const f = fixture();
    f.store.put("stopAll", "tavern", { state: "stopped", since: 1_800_000_000_000, by: { kind: "user" }, receipt: null });
    expect(() => f.runner.start("wren", draft)).toThrow(/Tavern is stopped/);
    expect(f.calls).toEqual([]);
    expect(f.store.all("voiceChecks")).toEqual([]);
  });
  it("runs the draft on the character's model as a hidden child of one hidden Tavern parent, then deletes only its own children", async () => {
    const f = fixture();
    const id = (await f.runner.start("wren", draft)).running!.id;
    await f.runner.settled();
    const [parent, writer, judge] = spawns(f);
    expect(parent).toMatchObject({ projectId: "proj_personal", visibility: "hidden", parentNotifications: "off", title: "Tavern voice checks (hidden)", environment: { type: "host", workspace: { type: "personal" } }, pluginMetadata: { voiceCheck: "parent" } });
    for (const child of [writer, judge]) expect(child).toMatchObject({ projectId: "proj_personal", visibility: "hidden", parentThreadId: "thr_fake1", parentNotifications: "off", environment: { type: "host", workspace: { type: "personal" } }, pluginMetadata: { voiceCheck: id } });
    expect(writer).toMatchObject({ providerId: "pi", model: "gpt-5.1" });
    expect(judge).toMatchObject({ providerId: "pi", model: "claude-haiku-4-5" });
    expect(f.calls.filter(([c]) => c === "delete").map(([, t]) => t)).toEqual(["thr_fake2", "thr_fake3"]);
    expect(f.threads.has("thr_fake1")).toBe(true);
    const done = f.runner.view("wren").history[0]!;
    expect(done.judgeNote).toBe("Judge Claude Haiku 4.5 (pi): a small model from another family (anthropic) than the writer's (openai).");
    expect(done).toMatchObject({ state: "passed", tone: "judged", draft: { name: "Wren", style: draft.style }, writer: { model: "gpt-5.1", name: "GPT-5.1" }, judge: { model: "claude-haiku-4-5", name: "Claude Haiku 4.5" }, reason: null, cost: { usd: null, tokens: 198_000 } });
    expect(done.situations.map((s) => [s.id, s.pass])).toEqual(SITUATIONS.map((s) => [s.id, true]));
    expect(f.calls.some(([c]) => c === "list" || c === "search")).toBe(false);
    const event = f.store.db.prepare("SELECT type, data FROM tavern_events WHERE type='voice.checked'").get() as { data: string };
    expect(JSON.parse(event.data)).toMatchObject({ runId: id, characterId: "wren", state: "passed", writer: "gpt-5.1", failed: [] });
    expect(f.invalidated).toContain("tavern:voice-check:wren");
  });

  it("gives the writer the same voice rules an agent gets, with the draft's name and style, and asks for marked JSON", async () => {
    const f = fixture();
    f.runner.start("wren", draft); await f.runner.settled();
    const prompt = String((spawns(f)[1]!.input as { text: string }[])[0]!.text);
    expect(prompt).toContain("Never use the voice for blockers, failures, asks or reports of trouble.");
    expect(prompt).toContain(JSON.stringify(draft.style));
    expect(prompt).toContain(ANSWER_START);
    for (const s of SITUATIONS) expect(prompt).toContain(s.brief);
    expect(prompt).not.toContain("charts every course");
  });

  it("reuses the parent for the next check", async () => {
    const f = fixture();
    f.runner.start("wren", draft); await f.runner.settled();
    f.runner.start("wren", draft); await f.runner.settled();
    expect(spawns(f).filter((s) => (s.pluginMetadata as Record<string, unknown>).voiceCheck === "parent")).toHaveLength(1);
  });

  it("fails a voice that leaks its style into a blocker, quoting the words", async () => {
    const f = fixture({ writer: () => marked({ ...reference, blocker: { ...reference.blocker as object, outcome: `${(reference.blocker as { outcome: string }).outcome} Our bearings are lost in the tides.` } }) });
    f.runner.start("wren", draft); await f.runner.settled();
    const r = f.runner.view("wren").history[0]!;
    expect(r.state).toBe("failed");
    expect(r.situations.find((s) => s.id === "blocker")).toMatchObject({ pass: false, failures: [expect.objectContaining({ rule: "style-word", field: "outcome" })] });
    expect(JSON.parse(r.situations.find((s) => s.id === "blocker")!.answer!)).toMatchObject({ status: "blocked" });
  });

  it("fails on tone only with a quote found in the answer, and ignores an invented one", async () => {
    const f = fixture({ judge: () => marked({ ...allPass, ask: { pass: false, quote: "Wait for Luc's review" }, failed: { pass: false, quote: "alas, the tests have fallen" } }) });
    f.runner.start("wren", draft); await f.runner.settled();
    const r = f.runner.view("wren").history[0]!;
    expect(r.state).toBe("failed");
    expect(r.situations.find((s) => s.id === "ask")!.failures).toEqual([{ rule: "tone", field: "ask", quote: "Wait for Luc's review" }]);
    expect(r.situations.find((s) => s.id === "failed")!.pass).toBe(true);
  });

  it("rests on rules alone when no model of another family is offered", async () => {
    const f = fixture({ models: { pi: ["gpt-5.1", "gpt-5.1-mini"] } });
    f.runner.start("wren", draft); await f.runner.settled();
    expect(f.runner.view("wren").history[0]).toMatchObject({ state: "passed", judge: null, tone: "not-judged" });
    expect(spawns(f)).toHaveLength(2);
  });

  it("stops a turn after 90 seconds and says so, deleting the thread", async () => {
    const f = fixture({ writer: () => null });
    f.runner.start("wren", draft); await f.runner.settled();
    expect(f.runner.view("wren").history[0]).toMatchObject({ state: "couldnt-run", reason: "Took longer than 90 seconds. Press Try again; if it happens again, the model may be busy." });
    expect(f.calls).toContainEqual(["stop", "thr_fake2"]);
    expect(f.calls).toContainEqual(["delete", "thr_fake2"]);
  });

  it("says the answer couldn't be read when the model gives no marked JSON", async () => {
    const f = fixture({ writer: () => "Here are my answers: blocker is fine." });
    f.runner.start("wren", draft); await f.runner.settled();
    expect(f.runner.view("wren").history[0]).toMatchObject({ state: "couldnt-run", reason: "The model's answer couldn't be read as the five answers." });
  });

  it("runs one check at a time across Tavern and at most 10 an hour", async () => {
    const f = fixture();
    f.runner.start("wren", draft);
    expect(() => f.runner.start("moss", { ...draft, name: "Moss" })).toThrow("Another voice check is running. Try again when it finishes.");
    await f.runner.settled();
    for (let i = 1; i < 10; i++) { f.runner.start("wren", draft); await f.runner.settled(); f.tick(60_000); }
    const view = f.runner.view("wren");
    expect(view.cap).toMatchObject({ used: 10, max: 10 });
    expect(view.cap.nextAt).toBe(view.history.at(-1)!.startedAt + 3_600_000);
    expect(() => f.runner.start("wren", draft)).toThrow(/^10 checks this hour; the next can run at \d\d:\d\d\.$/);
  });

  it("cancels a running check, stopping and deleting its thread", async () => {
    const f = fixture({ writer: () => null });
    const id = (await f.runner.start("wren", draft)).running!.id;
    await vi.waitFor(() => expect(f.threads.has("thr_fake2")).toBe(true));
    f.runner.cancel("wren", id); await f.runner.settled();
    expect(f.runner.view("wren").history[0]).toMatchObject({ state: "cancelled" });
    expect(f.calls).toContainEqual(["delete", "thr_fake2"]);
  });

  it("never deletes a recorded id whose metadata isn't this check's", async () => {
    const f = fixture();
    f.runner.start("wren", draft); await f.runner.settled();
    const r = f.runner.view("wren").history[0]!;
    f.threads.set("thr_other", { id: "thr_other", status: "idle", meta: { voiceCheck: "someone-else" }, parent: null, spawn: {}, events: [] });
    f.store.put("voiceChecks", r.id, { ...f.store.get("voiceChecks", r.id)!, state: "running", threadIds: ["thr_other"] });
    await f.make().recover();
    expect(f.threads.has("thr_other")).toBe(true);
  });

  it("on restart marks an unfinished check couldn't run and deletes only the ids it recorded, never by title or search", async () => {
    const f = fixture({ writer: () => null });
    f.runner.start("wren", draft);
    await new Promise((r) => setTimeout(r, 0));
    f.threads.set("thr_lookalike", { id: "thr_lookalike", status: "idle", meta: {}, parent: null, spawn: { title: "Tavern voice check · Wren" }, events: [] });
    await f.make().recover();
    await f.runner.settled();
    expect(f.runner.view("wren").history[0]).toMatchObject({ state: "couldnt-run", reason: "Tavern restarted during the check." });
    expect(f.threads.has("thr_fake2")).toBe(false);
    expect(f.threads.has("thr_lookalike")).toBe(true);
    expect(f.calls.some(([c]) => c === "list" || c === "search")).toBe(false);
  });

  it("reports Burn's recorded cost when Burn is installed", async () => {
    const f = fixture({ burn: true });
    f.runner.start("wren", draft); await f.runner.settled();
    expect(f.runner.view("wren").history[0]!.cost!.usd).toBeCloseTo(0.028, 6);
  });

  it("takes the judge from the main vendors' small models, never a router or a preview", async () => {
    const f = fixture({ models: { pi: ["anthropic/claude-opus-5-5", "fireworks/fireworks:accounts/fireworks/routers/glm-5p2-fast", "google/gemini-3-flash-preview", "google/gemini-2.5-computer-use-preview-10-2025", "google/gemini-2.5-flash", "google/gemini-2.5-flash-lite", "openai/gpt-5.1"] } });
    const runner = new VoiceCheckRunner({ ...depsOf(f), writer: async () => ({ providerId: "pi", model: "anthropic/claude-opus-5-5" }) });
    runner.start("wren", draft); await runner.settled();
    expect(spawns(f)[0]).toMatchObject({ model: "google/gemini-2.5-flash-lite" });
  });

  it("sets the parent up again on the writer's model when the judge's model can't be served, and judges on rules only", async () => {
    const f = fixture({ unavailable: ["claude-haiku-4-5"] });
    f.runner.start("wren", draft); await f.runner.settled();
    const [first, second] = spawns(f);
    expect(first).toMatchObject({ model: "claude-haiku-4-5", pluginMetadata: { voiceCheck: "parent" } });
    expect(second).toMatchObject({ model: "gpt-5.1", pluginMetadata: { voiceCheck: "parent" } });
    expect(f.calls).toContainEqual(["delete", "thr_fake1"]);
    expect(f.threads.has("thr_fake2")).toBe(true);
    expect(f.runner.view("wren").history[0]).toMatchObject({ state: "passed", judge: null, tone: "not-judged", reason: null,
      judgeNote: "Tone not judged: the judge Claude Haiku 4.5 (pi) couldn't be reached (Model not found, inaccessible, and/or not deployed). Tavern skips it for 24 hours." });
    // The next check doesn't try the unreachable judge again.
    f.tick(60_000);
    f.runner.start("wren", draft); await f.runner.settled();
    expect(f.runner.view("wren").history[0]!.judgeNote).toBe("Tone not judged: no small model from another family than the writer's (openai) is offered. Skipped Claude Haiku 4.5 (pi): couldn't be reached at the last check.");
    expect(spawns(f).some((a) => a.model === "claude-haiku-4-5" && (a.pluginMetadata as Record<string, unknown>).voiceCheck !== "parent")).toBe(false);
  });

  it("names the model and quotes the provider when the writer's model can't be served", async () => {
    const f = fixture({ unavailable: ["claude-haiku-4-5", "gpt-5.1"] });
    f.runner.start("wren", draft); await f.runner.settled();
    expect(f.runner.view("wren").history[0]!.reason).toBe("The setup turn failed on GPT-5.1 (pi): Model not found, inaccessible, and/or not deployed. Check that this model is available to you, or change the character's class model in Tavern settings, then press Try again.");
    expect(f.threads.size).toBe(0);
  });

  it("names the writer as soon as the check starts", async () => {
    const f = fixture({ writer: () => null });
    const started = await f.runner.start("wren", draft);
    expect(started.running!.writer).toEqual({ providerId: "pi", model: "gpt-5.1", name: "GPT-5.1" });
    f.runner.cancel("wren", started.running!.id); await f.runner.settled();
  });

  it("reads the answer past bb's 100-event page when a turn has many messages", async () => {
    const f = fixture({ writer: () => marked(reference) });
    // A long turn: 150 messages before the answer, as a reasoning model with tool-free chatter could write.
    const spawn = f.sdk.threads.spawn;
    f.sdk.threads.spawn = async (args: Record<string, unknown>) => {
      const t = await spawn(args);
      if ((args.pluginMetadata as Record<string, unknown>).voiceCheck !== "parent" && args.model === "gpt-5.1") {
        const thread = f.threads.get(t.id)!, get = f.sdk.threads.get;
        f.sdk.threads.get = async (q: { threadId: string }) => {
          const r = await get(q);
          if (q.threadId === t.id && thread.events.length && thread.events[0]!.seq === 1) thread.events = [...Array.from({ length: 150 }, (_, i) => ({ seq: i + 1, type: "item/completed", data: { item: { type: "reasoning" } } })), ...thread.events.map((e, i) => ({ ...e, seq: 151 + i }))];
          return r;
        };
      }
      return t;
    };
    f.runner.start("wren", draft); await f.runner.settled();
    expect(f.runner.view("wren").history[0]).toMatchObject({ state: "passed", reason: null });
  });

  it("mutes the hidden parent before its one turn runs, so neither it nor its children notify, when the push plugin is installed", async () => {
    const f = fixture({ push: true });
    f.runner.start("wren", draft); await f.runner.settled();
    const parent = spawns(f)[0]!;
    expect(typeof parent.sendAt).toBe("number");
    const muted = f.calls.findIndex(([c, a]) => c === "notify-level" && (a as { threadId: string }).threadId === "thr_fake1");
    expect(f.calls[muted]![1]).toEqual({ threadId: "thr_fake1", level: "muted", status: "pending" });
    expect(muted).toBeLessThan(f.calls.findIndex(([c, a]) => c === "sent" && a === "thr_fake1"));
    expect(f.store.get("voiceCheckParent", "parent")).toMatchObject({ muted: true });
    expect(f.runner.view("wren").history[0]!.state).toBe("passed");
  });

  it("mutes a parent kept from before, once", async () => {
    const f = fixture({ push: true });
    f.runner.start("wren", draft); await f.runner.settled();
    f.store.put("voiceCheckParent", "parent", { ...f.store.get("voiceCheckParent", "parent")!, muted: false });
    f.tick(60_000); f.runner.start("wren", draft); await f.runner.settled();
    f.tick(60_000); f.runner.start("wren", draft); await f.runner.settled();
    expect(f.calls.filter(([c]) => c === "notify-level")).toHaveLength(2);
  });

  it("still runs without the push plugin, and doesn't claim the parent is muted", async () => {
    const f = fixture();
    f.runner.start("wren", draft); await f.runner.settled();
    expect(f.calls.some(([c]) => c === "notify-level")).toBe(false);
    expect(f.store.get("voiceCheckParent", "parent")).toMatchObject({ muted: false });
    expect(f.runner.view("wren").history[0]!.state).toBe("passed");
  });

  it("says plainly when the failure is Tavern's own, with the raw error kept as detail and the cost counted", async () => {
    const f = fixture({ ownError: true, burn: true });
    f.runner.start("wren", draft); await f.runner.settled();
    const r = f.runner.view("wren").history[0]!;
    expect(r).toMatchObject({ state: "couldnt-run", fault: "tavern", detail: "HTTP 400: Thread event limit cannot exceed 100",
      reason: "Tavern's check hit its own error. Nothing is wrong with Wren's voice or with the model." });
    expect(r.reason).not.toMatch(/Try again/);
    expect(r.cost!.usd).toBeGreaterThan(0);
    expect(f.runner.view("wren").cap.used).toBe(1);
  });

  it("counts a charged run toward the hourly limit whoever caused the failure, and a run that cost nothing not at all", async () => {
    const free = fixture({ unavailable: ["claude-haiku-4-5", "gpt-5.1"] });
    free.runner.start("wren", draft); await free.runner.settled();
    expect(free.runner.view("wren").history[0]).toMatchObject({ state: "couldnt-run", fault: "model" });
    expect(free.runner.view("wren").cap.used).toBe(0);
    const charged = fixture({ writer: () => "no marked answer" });
    charged.runner.start("wren", draft); await charged.runner.settled();
    expect(charged.runner.view("wren").history[0]!.cost!.tokens).toBeGreaterThan(0);
    expect(charged.runner.view("wren").cap.used).toBe(1);
  });

  it("reads the configured voice-check rate before taking another run", async () => {
    const f = fixture();
    let max = 2;
    const runner = new VoiceCheckRunner({ ...f.deps(), checksPerHour: () => max });
    runner.start("wren", draft); await runner.settled();
    expect(runner.view("wren").cap).toMatchObject({used:1,max:2,nextAt:null});
    max = 1;
    expect(runner.view("wren").cap).toMatchObject({used:1,max:1,nextAt: expect.any(Number)});
    expect(() => runner.start("wren", draft)).toThrow();
  });
  it("counts the parent's setup turn in the cost of the run that made it", async () => {
    const f = fixture();
    f.runner.start("wren", draft); await f.runner.settled();
    // The parent, the writer and the judge each report 66,000 tokens in the fake.
    expect(f.runner.view("wren").history[0]!.cost).toEqual({ usd: null, tokens: 198_000 });
    f.tick(60_000); f.runner.start("wren", draft); await f.runner.settled();
    expect(f.runner.view("wren").history[0]!.cost).toEqual({ usd: null, tokens: 132_000 });
  });

  it("marks voice-check threads so Tavern offers them no tools", () => {
    expect(isVoiceCheckThread({ voiceCheck: "vc_1" })).toBe(true);
    expect(isVoiceCheckThread({ voiceCheck: "parent" })).toBe(true);
    expect(isVoiceCheckThread({ classId: "smith" })).toBe(false);
  });
});
