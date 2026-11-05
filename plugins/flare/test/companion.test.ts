// @vitest-environment node
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { Companions, companionMessage, filesFolder, rewriteReferences, storageReferences } from "../src/companion";
import { MODEL_ID, PROVIDER_ID, parseRenderPrompt } from "../src/provider";
import { FlareStore, MIGRATIONS, type FlareRow } from "../src/store";

interface World {
  environmentId?: string | null;
  files?: Record<string, string>;
  sendFails?: boolean;
  gone?: boolean;
  writeFails?: boolean;
}

function setup(world: World = {}) {
  let now = 1_000_000;
  let spawned = 0;
  const written: Record<string, string> = {};
  const { bb, harness } = createFakePluginHost({
    pluginId: "flare",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          if (threadId.startsWith("thr_companion") && world.gone) throw Object.assign(new Error(`Thread ${threadId} not found`), { status: 404 });
          return makeThreadResponse({ id: threadId, projectId: "proj", title: "Fix checkout", environmentId: world.environmentId === undefined ? "env_1" : world.environmentId } as never);
        },
        spawn: async () => ({ id: `thr_companion_${++spawned}` }),
        send: async () => {
          if (world.sendFails) throw new Error("Host is not connected");
          return { ok: true, delivery: "sent", turnRequestId: "req" };
        },
        delete: async () => ({ ok: true }),
        storageLocation: async ({ threadId }: { threadId: string }) => ({ hostId: "host_1", storageRootPath: `/storage/${threadId}` }),
        queuedMessages: {
          list: async ({ threadId }: { threadId: string }) => [{ id: `qm_${threadId}`, updatedAt: 7 }],
          send: async () => ({ ok: true, delivery: "sent" }),
          update: async () => ({ ok: true }),
        },
      },
      files: {
        read: async ({ path }: { path: string }) => {
          const content = world.files?.[path];
          if (content === undefined) throw new Error("ENOENT");
          return { content, contentEncoding: "utf8", sizeBytes: content.length, sha256: "x", path };
        },
        mkdir: async () => ({ ok: true }),
        write: async ({ path, content }: { path: string; content: string }) => {
          if (world.writeFails) throw new Error("No storage yet");
          written[path] = content;
          return { outcome: "written", sha256: "x", sizeBytes: content.length };
        },
      },
      plugins: { callRpc: async () => ({ ok: true }) },
    },
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new FlareStore(db);
  const companions = new Companions(bb, store, () => now);
  const calls = (path: string) => harness.inspection.sdk.callsTo(path).map((args) => args[0] as Record<string, unknown>);
  const add = (title: string, options: { threadId?: string; body?: string; audience?: string[]; at?: number } = {}): FlareRow => {
    now = options.at ?? now + 1_000;
    const row = store.insertFlare({
      threadId: options.threadId ?? "thr_a",
      projectId: "proj",
      draft: { kind: "finding", title, body: options.body ?? "", urgent: false },
      source: "tool",
      now,
    });
    store.setThreadTitle(row.id, "Fix checkout");
    if (options.audience !== undefined) store.addAudience(row.id, options.audience);
    return row;
  };
  const texts = (path: "threads.send" | "threads.spawn") => calls(path).map((call) => parseRenderPrompt((call.input as { text: string }[])[0]!.text)!.text);
  return { companions, store, calls, written, world, add, texts, advance: (ms: number) => (now += ms) };
}

describe("companionMessage", () => {
  it("shows the title, then the body unchanged; the divider carries the rest", () => {
    expect(companionMessage({ title: "Root *cause* found", body: '```ui\nCard("x", [])\n```' })).toBe('**Root \\*cause\\* found**\n\n```ui\nCard("x", [])\n```');
    expect(companionMessage({ title: "Blocked", body: "" })).toBe("**Blocked**");
  });
});

describe("storage references", () => {
  it("finds thread-storage files a body names, and points the copied ones at a folder per flare", () => {
    const body = 'Tests(Load("$BB_THREAD_STORAGE/tests.json")) and /storage/thr_a/reports/out.html, not $BB_THREAD_STORAGE/../x';
    expect(storageReferences(body, "/storage/thr_a")).toEqual(["tests.json", "reports/out.html"]);
    expect(rewriteReferences("Saved to $BB_THREAD_STORAGE/report.html.", null, new Set(["report.html"]), filesFolder("fl_1"))).toBe(
      "Saved to $BB_THREAD_STORAGE/flare-files/fl_1/report.html.",
    );
    expect(rewriteReferences(body, "/storage/thr_a", new Set(["tests.json"]), filesFolder("fl_1"))).toBe(
      'Tests(Load("$BB_THREAD_STORAGE/flare-files/fl_1/tests.json")) and /storage/thr_a/reports/out.html, not $BB_THREAD_STORAGE/../x',
    );
  });
});

describe("Companions", () => {
  it("starts a hidden, quiet companion, held until it is muted, then releases it", async () => {
    const { companions, store, calls, add } = setup();
    const flare = add("Root cause found");
    await companions.show(["thr_a"]);
    const [spawn] = calls("threads.spawn");
    expect(spawn).toMatchObject({
      projectId: "proj",
      environment: { type: "reuse", environmentId: "env_1" },
      providerId: PROVIDER_ID,
      model: MODEL_ID,
      reasoningLevel: "low",
      visibility: "hidden",
      parentThreadId: "thr_a",
      parentNotifications: "off",
      lifecycleOwnerThreadId: "thr_a",
      pluginMetadata: { companionOf: "thr_a" },
      title: "Flares: Fix checkout",
      sendAt: flare.createdAt + 60_000,
    });
    expect((spawn!.input as { visibility: string }[])[0]!.visibility).toBe("agent-only");
    expect(calls("plugins.callRpc")).toEqual([expect.objectContaining({ method: "threadNotifications.set", input: { threadId: "thr_companion_1", level: "muted" } })]);
    expect(calls("threads.queuedMessages.send")).toEqual([{ threadId: "thr_companion_1", queuedMessageId: "qm_thr_companion_1", mode: "auto" }]);
    expect(store.unshownFor("thr_a", 10)).toEqual([]);
  });

  it("replays every retained flare into a new companion, in order, then sends new ones to it", async () => {
    const { companions, add, texts } = setup();
    add("One");
    add("Two");
    await companions.show(["thr_a"]);
    add("Three");
    await companions.show(["thr_a"]);
    expect(texts("threads.spawn")).toEqual(["**One**"]);
    expect(texts("threads.send")).toEqual(["**Two**", "**Three**"]);
  });

  it("keeps a companion that failed for a passing reason, and sends the flare again with the next one", async () => {
    const { companions, calls, add, world, store } = setup();
    add("One");
    await companions.show(["thr_a"]);
    world.sendFails = true;
    add("Two");
    await companions.show(["thr_a"]);
    expect(calls("threads.spawn")).toHaveLength(1);
    expect(store.companionOf("thr_a")).toBe("thr_companion_1");
    world.sendFails = false;
    add("Three");
    await companions.show(["thr_a"]);
    expect(store.unshownFor("thr_a", 10)).toEqual([]);
  });

  it("replaces a companion that is gone, replaying everything into the new one", async () => {
    const { companions, calls, add, world, store, texts } = setup();
    add("One");
    await companions.show(["thr_a"]);
    world.sendFails = true;
    world.gone = true;
    add("Two");
    await companions.show(["thr_a"]);
    world.sendFails = false;
    world.gone = false;
    await companions.settled();
    expect(calls("threads.delete")).toEqual([{ threadId: "thr_companion_1", childThreadsConfirmed: true }]);
    expect(store.companionOf("thr_a")).toBe("thr_companion_2");
    expect(texts("threads.spawn")).toEqual(["**One**", "**One**"]);
    expect(store.unshownFor("thr_a", 10)).toEqual([]);
  });

  it("rebuilds a companion that would show an older flare after newer ones", async () => {
    const { companions, calls, add, store, advance } = setup();
    add("Late arrival", { at: 1_000_000 });
    store.markShown("placeholder", "thr_a", 0);
    advance(10 * 60_000);
    const newer = add("Newer");
    store.setCompanion("thr_a", "thr_companion_old", 0);
    store.markShown(newer.id, "thr_a", 0);
    await companions.show(["thr_a"]);
    expect(calls("threads.delete")).toEqual([{ threadId: "thr_companion_old", childThreadsConfirmed: true }]);
    expect(calls("threads.spawn")).toHaveLength(1);
    expect(store.unshownFor("thr_a", 10)).toEqual([]);
  });

  it("shows a child's flare in every viewer's own companion", async () => {
    const { companions, store, add } = setup();
    add("From the child", { threadId: "thr_child", audience: ["thr_a"] });
    await companions.show(["thr_child", "thr_a"]);
    expect([store.companionOf("thr_child"), store.companionOf("thr_a")].sort()).toEqual(["thr_companion_1", "thr_companion_2"]);
  });

  it("starts nothing for a thread with no environment yet", async () => {
    const { companions, store, calls, add } = setup({ environmentId: null });
    add("One");
    await companions.show(["thr_a"]);
    expect(calls("threads.spawn")).toEqual([]);
    expect(store.companionOf("thr_a")).toBeNull();
  });

  it("replays only the newest flares into a new companion, and leaves the rest as cards without rebuilding again", async () => {
    const { companions, calls, add, store } = setup();
    const rows = Array.from({ length: 103 }, (_, index) => add(`Flare ${index}`));
    await companions.show(["thr_a"]);
    expect(calls("threads.spawn")).toHaveLength(1);
    expect(calls("threads.send")).toHaveLength(99);
    add("One more");
    await companions.show(["thr_a"]);
    expect(calls("threads.spawn")).toHaveLength(1);
    expect(calls("threads.delete")).toEqual([]);
    const drawn = store.shownAmong("thr_a", rows.map((row) => row.id));
    expect(rows.filter((row) => !drawn.has(row.id)).map((row) => row.title)).toEqual(["Flare 0", "Flare 1", "Flare 2"]);
  });

  it("sends a later flare as written when its files could not be copied, so the ones after it still go", async () => {
    const { companions, add, world, texts, store } = setup({ files: { "/storage/thr_a/tests.json": "{}" } });
    add("First");
    await companions.show(["thr_a"]);
    world.writeFails = true;
    add("With a file", { body: 'Load("$BB_THREAD_STORAGE/tests.json")' });
    add("After it");
    await companions.show(["thr_a"]);
    expect(texts("threads.send")).toEqual(['**With a file**\n\nLoad("$BB_THREAD_STORAGE/tests.json")', "**After it**"]);
    expect(store.unshownFor("thr_a", 10)).toEqual([]);
  });

  it("sends a new companion's first flare unchanged when its files could not be copied", async () => {
    const { companions, calls, add } = setup({ files: { "/storage/thr_a/tests.json": "{}" }, writeFails: true });
    add("Tests", { body: 'Load("$BB_THREAD_STORAGE/tests.json")' });
    await companions.show(["thr_a"]);
    const [update] = calls("threads.queuedMessages.update");
    expect(update).toMatchObject({ threadId: "thr_companion_1", queuedMessageId: "qm_thr_companion_1", expectedUpdatedAt: 7 });
    expect((update!.input as { text: string }[])[0]!.text).toContain('Load("$BB_THREAD_STORAGE/tests.json")');
  });

  it("copies the storage files a body names into a folder for that flare, before releasing the companion", async () => {
    const { companions, written, add, texts } = setup({ files: { "/storage/thr_a/tests.json": '{"ok":true}' } });
    const flare = add("Tests", { body: 'Tests(Load("$BB_THREAD_STORAGE/tests.json")) and $BB_THREAD_STORAGE/missing.json' });
    await companions.show(["thr_a"]);
    expect(written).toEqual({ [`/storage/thr_companion_1/flare-files/${flare.id}/tests.json`]: '{"ok":true}' });
    expect(texts("threads.spawn")[0]).toContain(`Load("$BB_THREAD_STORAGE/flare-files/${flare.id}/tests.json")`);
    expect(texts("threads.spawn")[0]).toContain("$BB_THREAD_STORAGE/missing.json");
  });
});
