import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type {
  CompactionEntry, ExtensionAPI, ExtensionContext, ExtensionHandler, SessionBeforeCompactEvent, SessionBeforeCompactResult,
  SessionCompactEvent, SessionCompactFailedEvent,
} from "@earendil-works/pi-coding-agent";
import pressComposer, { PRESS_COMPOSER_LOG_MAX_BYTES } from "../index.ts";

const THREAD_ID = "thr_hooks";
const stamp = "2026-11-22T00:00:00.000Z";
const usage = { input: 123, output: 45, cacheRead: 0, cacheWrite: 0, totalTokens: 168,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { id: "writer", provider: "test", name: "Fake writer", contextWindow: 100_000,
  api: "openai-completions", baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
  maxTokens: 64_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } satisfies NonNullable<ExtensionContext["model"]>;
const response = (stopReason: AssistantMessage["stopReason"] = "stop", text = "The narrative"): AssistantMessage => ({
  role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason, usage,
  content: [{ type: "text", text }], timestamp: Date.now(),
});
const user = (content: string): UserMessage => ({ role: "user", content, timestamp: 1 });

function setup(t: TestContext, inBb = true, activeModel: NonNullable<ExtensionContext["model"]> = model) {
  const root = mkdtempSync(fileURLToPath(new URL("../node_modules/.press-hooks-", import.meta.url)));
  const previous = process.env.BB_THREAD_ID;
  if (inBb) process.env.BB_THREAD_ID = THREAD_ID;
  else delete process.env.BB_THREAD_ID;
  t.after(() => {
    if (previous === undefined) delete process.env.BB_THREAD_ID;
    else process.env.BB_THREAD_ID = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const press = join(root, ".bb", "press");
  const threadDir = join(press, "threads", THREAD_ID);
  const path = join(threadDir, "ledger.json");
  const configPath = join(threadDir, "composer.json");
  const summaries = join(threadDir, "summaries");
  const log = join(press, "composer.log");
  mkdirSync(threadDir, { recursive: true });
  const events = new EventEmitter();
  const before: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>[] = [];
  const compact: ExtensionHandler<SessionCompactEvent>[] = [];
  const failed: ExtensionHandler<SessionCompactFailedEvent>[] = [];
  const commands: string[] = [];
  const attach = (factory = pressComposer) => factory({
    on(name: string, handler: unknown) {
      if (name === "session_before_compact") before.push(handler as typeof before[number]);
      if (name === "session_compact") compact.push(handler as typeof compact[number]);
      if (name === "session_compact_failed") failed.push(handler as typeof failed[number]);
      return () => {};
    },
    registerCommand(name: string) { commands.push(name); },
    events: {
      emit: (name: string, payload: unknown) => events.emit(name, payload),
      on(name: string, handler: (payload: unknown) => void) {
        events.on(name, handler);
        return () => events.off(name, handler);
      },
    },
  } as unknown as ExtensionAPI);
  attach();
  const requests: Array<{ model: string; prompt: string; budget: number | undefined }> = [];
  const replies: Array<AssistantMessage | Error> = [];
  const warnings: string[] = [];
  const modelLookups: Array<[string, string]> = [];
  const registry: Pick<ExtensionContext["modelRegistry"], "complete" | "find"> = {
    async complete(model, context, options) {
      const content = context.messages[0]?.content;
      const prompt = Array.isArray(content) && content[0]?.type === "text" ? content[0].text : "";
      requests.push({ model: model.id, prompt, budget: options?.maxTokens });
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply ?? response();
    },
    find(provider, id) {
      modelLookups.push([provider, id]);
      return (provider === "test" && id === "configured") || (provider === "openrouter" && id === "anthropic/claude-sonnet-4.6")
        ? { ...model, provider, id } : undefined;
    },
  };
  let leaf: CompactionEntry | undefined;
  let usageReads = 0;
  const getContextUsage: ExtensionContext["getContextUsage"] = () => {
    usageReads += 1;
    return { tokens: null, contextWindow: activeModel.contextWindow, percent: null };
  };
  const ctx = { cwd: root, model: activeModel, modelRegistry: registry, hasUI: true,
    sessionManager: { getLeafEntry: () => leaf },
    ui: { notify: (msg: string, level: string) => { if (level === "warning") warnings.push(msg); } },
    getContextUsage,
  } as unknown as ExtensionContext;
  function beforeEvent(overrides: Partial<SessionBeforeCompactEvent> = {}): SessionBeforeCompactEvent {
    return {
      type: "session_before_compact", reason: "manual", willRetry: false, signal: new AbortController().signal,
      branchEntries: [{ type: "message", id: "first", parentId: null, timestamp: stamp, message: user("Build the queue.") }],
      preparation: { firstKeptEntryId: "kept", tokensBefore: 50_000, isSplitTurn: false,
        messagesToSummarize: [user("Continue from the last step. Never commit without permission.")],
        turnPrefixMessages: [], fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      },
      ...overrides,
    };
  }
  const prepare = async (e = beforeEvent()) => {
    let result: Awaited<ReturnType<typeof before[number]>> = undefined;
    for (const handler of before) result = (await handler(e, ctx)) ?? result;
    return result?.compaction;
  };
  const apply = async (result: NonNullable<Awaited<ReturnType<typeof prepare>>>, fromExtension = true, emitPrevious = false) => {
    const previous = leaf;
    const { summary, firstKeptEntryId, tokensBefore, usage, details } = result;
    leaf = { summary, firstKeptEntryId, tokensBefore, usage, details, fromHook: fromExtension,
      type: "compaction", id: String((previous === undefined ? 0 : Number(previous.id)) + 1),
      parentId: previous?.id ?? null, timestamp: stamp };
    const event: SessionCompactEvent = {
      type: "session_compact", reason: "manual", fromExtension, willRetry: false,
      compactionEntry: emitPrevious ? previous! : leaf,
    };
    for (const handler of compact) await handler(event, ctx);
  };
  const fail = async () => {
    const event: SessionCompactFailedEvent = { type: "session_compact_failed", reason: "manual", fromExtension: true,
      willRetry: false, aborted: true };
    for (const handler of failed) await handler(event, ctx);
  };
  const publish = (settings: Record<string, unknown>) => {
    writeFileSync(configPath, JSON.stringify({ model: null, maxSummaryTokens: 3000, ledger: true,
      resumeContract: true, updatedAt: stamp, ...settings }));
  };
  return { path, configPath, summaries, log, press, ctx, before, compact, commands, requests, replies, warnings, attach,
    prepare, apply, fail, beforeEvent, publish, modelLookups, usageReads: () => usageReads };
}

test("does not register Press or touch the workspace outside bb", async (t) => {
  const f = setup(t, false);
  assert.equal(await f.prepare(), undefined);
  assert.deepEqual(f.commands, []);
  assert.equal(f.requests.length, 0);
  assert.equal(existsSync(f.log), false);
  assert.equal(existsSync(f.path), false);
});

test("reads the thread's published config, saves only after Pi applies, and records the original goal", async (t) => {
  const f = setup(t);
  const legacy = join(f.press, "ledger.json");
  writeFileSync(legacy, JSON.stringify({ composer: { model: "stale/legacy", maxSummaryTokens: 999 } }));
  f.publish({ model: "test/configured", maxSummaryTokens: 900, resumeContract: false });
  const config = readFileSync(f.configPath, "utf8");
  const result = await f.prepare(f.beforeEvent({ customInstructions: "Focus on ordering." }));
  assert.ok(result);
  assert.equal(f.requests[0]?.model, "configured");
  assert.match(f.requests[0]!.prompt, /Focus on ordering\./);
  assert.match(f.requests[0]!.prompt, /Budget: at most 900 tokens/);
  assert.equal(result.firstKeptEntryId, "kept");
  assert.equal(result.tokensBefore, 50_000);
  assert.deepEqual(result.usage, usage);
  assert.doesNotMatch(result.summary, /## Resume/);
  assert.equal(existsSync(f.path), false);
  assert.equal(existsSync(f.summaries), false);
  await f.apply(result);
  await f.apply(result);
  const ledger = JSON.parse(readFileSync(f.path, "utf8"));
  assert.equal(ledger.threadId, THREAD_ID);
  assert.equal(ledger.state.goal, "Build the queue.");
  assert.equal(ledger.compactions, 1);
  assert.equal(ledger.history.length, 1);
  const row = ledger.history[0];
  assert.equal(row.finishedAt, Date.parse(stamp));
  assert.equal(row.point, "manual");
  assert.equal(row.tokensAfter, null);
  assert.equal(f.usageReads(), 0);
  assert.equal(row.model, "test/configured");
  assert.equal(row.outcome, "ok");
  assert.equal(readFileSync(join(f.summaries, `${row.id}.md`), "utf8"), result.summary);
  assert.equal(readFileSync(f.configPath, "utf8"), config);
  assert.match(readFileSync(legacy, "utf8"), /stale\/legacy/);
});

test("an identical summary uses the latest saved compaction when Pi emits the earlier match", async (t) => {
  const f = setup(t);
  const first = await f.prepare();
  assert.ok(first);
  await f.apply(first);
  const second = await f.prepare();
  assert.ok(second);
  assert.equal(second.summary, first.summary);
  await f.apply(second, true, true);
  assert.equal(JSON.parse(readFileSync(f.path, "utf8")).history.length, 2);
});

test("a failed compaction leaves the existing ledger and summaries untouched", async (t) => {
  const f = setup(t);
  const first = await f.prepare();
  assert.ok(first);
  await f.apply(first);
  const before = readFileSync(f.path, "utf8");
  const files = readdirSync(f.summaries);
  const cancelled = await f.prepare();
  assert.ok(cancelled);
  await f.fail();
  assert.equal(readFileSync(f.path, "utf8"), before);
  assert.deepEqual(readdirSync(f.summaries), files);
});

test("carries constraints through a native fallback without recording a Press summary", async (t) => {
  const f = setup(t);
  const event = f.beforeEvent();
  f.replies.push(response("error", "Partial text must not land"));
  assert.equal(await f.prepare(event), undefined);
  assert.equal(f.requests.length, 1);
  assert.equal(existsSync(f.path), false);
  await f.apply({ summary: "Pi's native summary", firstKeptEntryId: event.preparation.firstKeptEntryId,
    tokensBefore: event.preparation.tokensBefore, details: { readFiles: [], modifiedFiles: [] } }, false);
  const ledger = JSON.parse(readFileSync(f.path, "utf8"));
  assert.deepEqual(ledger.constraints.map((row: { text: string }) => row.text), ["Never commit without permission."]);
  assert.equal(ledger.state.goal, "Build the queue.");
  assert.deepEqual(ledger.history, []);
  assert.equal(ledger.compactions, 0);
  assert.equal(existsSync(f.summaries), false);
});

test("carries constraints through another extension's compaction but not Press's unapplied resume or summary", async (t) => {
  const f = setup(t);
  f.replies.push(response("stop", "The narrative\n\nRESUME:\nstate: written\nnext: run\nverify: tests"));
  const replaced = await f.prepare();
  assert.ok(replaced);
  await f.apply({ ...replaced, summary: "Other extension's summary", details: { otherExtension: true } });
  const ledger = JSON.parse(readFileSync(f.path, "utf8"));
  assert.deepEqual(ledger.constraints.map((row: { text: string }) => row.text), ["Never commit without permission."]);
  assert.equal(ledger.resume, null);
  assert.deepEqual(ledger.history, []);
  assert.equal(existsSync(f.summaries), false);
});

test("does not retry error, abort, or other non-normal responses", async (t) => {
  const f = setup(t);
  for (const reason of ["error", "aborted", "toolUse", "deferred", "pending"] as const) {
    f.replies.push(response(reason, "Partial text must not land"));
    assert.equal(await f.prepare(), undefined, reason);
  }
  f.replies.push(new Error("provider rejected request"));
  assert.equal(await f.prepare(), undefined);
  assert.equal(f.requests.length, 6);
  assert.match(readFileSync(f.log, "utf8"), /provider rejected request/);
  assert.equal(existsSync(f.path), false);
});

test("retries a length stop with more headroom and only uses the completed retry", async (t) => {
  const f = setup(t);
  f.replies.push(response("length", "Truncated Press narrative"), response());
  const prepared = await f.prepare();
  assert.ok(prepared);
  assert.match(prepared.summary, /The narrative/);
  assert.doesNotMatch(prepared.summary, /Truncated Press narrative/);
  assert.deepEqual(f.requests.map((r) => r.budget), [8_000, 16_000]);
  assert.match(readFileSync(f.log, "utf8"), /length.*retrying/);
});

test("clamps both budgets to the model limit and does not retry at that limit", async (t) => {
  const f = setup(t, true, { ...model, maxTokens: 10_000 });
  f.replies.push(response("length", "Truncated first"), response("length", "Truncated retry"));
  assert.equal(await f.prepare(), undefined);
  assert.deepEqual(f.requests.map((r) => r.budget), [8_000, 10_000]);
  f.publish({ maxSummaryTokens: 7_000 });
  f.replies.push(response("length", "Truncated at the model limit"));
  assert.equal(await f.prepare(), undefined);
  assert.deepEqual(f.requests.map((r) => r.budget), [8_000, 10_000, 10_000]);
});

test("does not call the model when already aborted", async (t) => {
  const f = setup(t);
  assert.equal(await f.prepare(f.beforeEvent({ signal: AbortSignal.abort() })), undefined);
  assert.equal(f.requests.length, 0);
});

test("retries empty normal output once with a larger budget, not a 12k ceiling", async (t) => {
  const f = setup(t);
  f.publish({ maxSummaryTokens: 15_000 });
  f.replies.push(response("stop", ""), response());
  assert.ok(await f.prepare());
  assert.deepEqual(f.requests.map((r) => r.budget), [30_000, 60_000]);
  f.replies.push(response("stop", ""), response("stop", ""));
  assert.equal(await f.prepare(), undefined);
  f.replies.push(response("stop", ""), response("length", "Partial retry"));
  assert.equal(await f.prepare(), undefined);
  assert.equal(f.requests.length, 6);
});

test("logs unresolvable and malformed config model specs and warns once per spec", async (t) => {
  const f = setup(t);
  for (const spec of ["test/missing", "test/missing", "no-provider", "test/has spaces", "test//writer", "openrouter/anthropic/claude-sonnet-4.6"]) {
    f.publish({ model: spec });
    assert.ok(await f.prepare());
  }
  assert.deepEqual(f.requests.map((r) => r.model), ["writer", "writer", "writer", "writer", "writer", "anthropic/claude-sonnet-4.6"]);
  assert.deepEqual(f.modelLookups, [["test", "missing"], ["test", "missing"], ["openrouter", "anthropic/claude-sonnet-4.6"]]);
  assert.equal(f.warnings.length, 4);
  const log = readFileSync(f.log, "utf8");
  assert.match(log, /model-not-found.*test\/missing/);
  assert.match(log, /model-not-found.*no-provider/);
  assert.match(log, /model-not-found.*test\/has spaces.*invalid-spec/);
});

test("keeps one log backup and prunes only expired Press summary files", async (t) => {
  const f = setup(t);
  writeFileSync(f.log, "x".repeat(PRESS_COMPOSER_LOG_MAX_BYTES));
  mkdirSync(f.summaries);
  writeFileSync(join(f.summaries, "keep-me.txt"), "unrelated");
  let first: string | undefined;
  for (let i = 0; i < 51; i++) {
    const result = await f.prepare();
    assert.ok(result);
    await f.apply(result);
    if (i === 0) first = readdirSync(f.summaries).find((name) => name.endsWith(".md"));
  }
  assert.ok(first);
  assert.equal(statSync(`${f.log}.1`).size, PRESS_COMPOSER_LOG_MAX_BYTES);
  assert.ok(statSync(f.log).size < PRESS_COMPOSER_LOG_MAX_BYTES);
  const names = readdirSync(f.summaries);
  assert.equal(names.filter((name) => name.endsWith(".md")).length, 50);
  assert.equal(names.includes(first), false);
  assert.equal(names.includes("keep-me.txt"), true);
});

test("keeps an applied compaction row even if the summary directory is unwritable", async (t) => {
  const f = setup(t);
  writeFileSync(f.summaries, "not a directory");
  const prepared = await f.prepare();
  assert.ok(prepared);
  await f.apply(prepared);
  const ledger = JSON.parse(readFileSync(f.path, "utf8"));
  assert.equal(ledger.history.length, 1);
  assert.equal(ledger.history[0].summaryPath, null);
  assert.match(readFileSync(f.log, "utf8"), /summary-write-failed/);
});

test("workspace opt-out and lack of a thread model both decline the custom summary", async (t) => {
  const f = setup(t);
  const policy = join(f.press, "policy.json");
  writeFileSync(policy, JSON.stringify({ providers: { pi: { enabled: false } } }));
  assert.equal(await f.prepare(), undefined);
  rmSync(policy);
  f.ctx.model = undefined;
  assert.equal(await f.prepare(), undefined);
  assert.equal(f.requests.length, 0);
  const log = readFileSync(f.log, "utf8");
  assert.match(log, /disabled/);
  assert.match(log, /no-model/);
});

test("the second loaded copy stays inert", async (t) => {
  const f = setup(t);
  const copy = await import(new URL("../index.ts?other-extension-path", import.meta.url).href) as { default: typeof pressComposer };
  f.attach(copy.default);
  assert.deepEqual(f.commands, ["press"]);
  assert.equal(f.before.length, 1);
  assert.equal(f.compact.length, 1);
  assert.ok(await f.prepare());
  assert.equal(f.requests.length, 1);
});
