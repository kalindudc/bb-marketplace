// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "./runtime-fixture";
import { memoryToolInput, type MemoryDraft } from "../../src/shared/memory";
import { TavernMemory } from "../../src/server/memory";
import { memoryHandlers } from "../../src/server/memory-rpc";
import { MemoryStore } from "../../src/server/memory-store";
import { BackupRecords } from "../../src/server/backup/records";
import { SettingsStore } from "../../src/server/settings/store";
import { runMemory, preflightMemory } from "../../src/host/memory";
import type { HostPort } from "../../src/host/client";
import type { HostInput } from "../../src/host-contract";

const draft: MemoryDraft = { kind: "finding", title: "Index timing", body: "Index use cuts the read time.", source: { kind: "command", value: "npm test" }, appliesTo: { kind: "date", value: "2026-11-21" }, tags: ["index"] };
const fixture = () => {
  const f = setup();
  f.k.bind("maker", "smith", "ash", "project");
  f.k.bind("other", "keeper", "ash", "another");
  return f;
};
let f: ReturnType<typeof fixture>;
afterEach(() => f?.k.store.db.close());
const tool = (threadId: string, input: unknown, project = "project") =>
  f.runtime.memory.tool(memoryToolInput.parse(input), threadId, project, new AbortController().signal);

it("saves immediately for a solo class; only its project Keeper can review", async () => {
  f = fixture();
  const { note } = await tool("maker", { op: "save", note: draft }) as { note: { id: string; updatedAt: number } };
  expect(note).toMatchObject({ status: "accepted", memory: "included", reviewedAt: null, author: { thread: "maker", classId: "smith" } });
  expect(await tool("lead", { op: "find", text: "index" })).toMatchObject({ notes: [{ id: note.id, reviewedBy: null }] });
  expect(f.k.ledger("lead").text).toContain("Durable notes await review");
  expect(await tool("lead", { op: "unreviewed" })).toMatchObject({ notes: [{ id: note.id, author: "maker" }] });
  const exclude = { op: "curate", action: "exclude", id: note.id, expectedUpdatedAt: note.updatedAt, reason: "Superseded by measurement." };
  await expect(tool("maker", exclude)).rejects.toThrow("Keeper");
  await expect(tool("other", exclude, "another")).rejects.toThrow("project");
  await expect(tool("lead", exclude)).resolves.toMatchObject({ note: { memory: "excluded", reviewedBy: "lead", exclusionReason: exclude.reason } });
  expect(await tool("lead", { op: "find", text: "index" })).toMatchObject({ notes: [] });
  await expect(tool("lead", exclude)).rejects.toThrow("changed");
});
it("supersedes atomically and refuses writes at Closing time and all calls at Stop all", async () => {
  f = fixture();
  const { note } = await tool("lead", { op: "save", note: draft }) as { note: { id: string; updatedAt: number } };
  const result = await tool("lead", { op: "curate", action: "supersede", id: note.id, expectedUpdatedAt: note.updatedAt, note: { ...draft, title: "New result" } });
  expect(result).toMatchObject({ note: { title: "New result", supersedes: note.id } });
  expect(await tool("lead", { op: "find" })).toMatchObject({ notes: [{ title: "New result" }] });
  expect(await f.runtime.memory.list({ project: "project", text: "", kind: null, limit: 4, status: "accepted", memory: null, offset: 0 })).toMatchObject({
    people: { lead: "Wren (Keeper)" }, previousTitles: { [note.id]: draft.title },
  });
  expect(f.runtime.memory.previous("another", note.id)).toBeNull();
  f.runtime.away.store.close({ revision: 0, until: f.time() + 3_600_000, quests: [], allowWatched: false, note: "" }, [], 12);
  await expect(tool("lead", { op: "save", note: draft })).rejects.toThrow(/closed/i);
  expect(await tool("lead", { op: "find" })).toMatchObject({ notes: [{ title: "New result" }] });
  f.k.store.put("stopAll", "tavern", { state: "stopped", since: f.time(), by: { kind: "user" }, receipt: null });
  await expect(tool("lead", { op: "find" })).rejects.toThrow(/stopped/i);
});

it("finds terms in any order and returns a next page when more notes match", async () => {
  f = fixture();
  for (let i = 0; i < 5; i++) await tool("lead", { op: "save", note: { ...draft, title: `Rule for machine placement ${i}` } });
  await tool("lead", { op: "save", note: { ...draft, title: "Unrelated rule" } });
  const query = { op: "find", text: "placement rule", limit: 4 };
  const page = await tool("lead", query) as { notes: { title: string }[] };
  expect(page).toMatchObject({ more: true, nextOffset: 4 });
  expect(page.notes.map(note => note.title)).toHaveLength(4);
  expect(page.notes.every(note => note.title.startsWith("Rule for machine placement"))).toBe(true);
  await expect(tool("lead", { ...query, offset: 4 })).resolves.toMatchObject({ notes: [expect.objectContaining({ title: expect.stringContaining("Rule for machine placement") })], more: false });
});

it("lets the human edit while paused and closed without allowing agent writes", async () => {
  f = fixture();
  const { note } = await tool("lead", { op: "save", note: draft }) as { note: { id: string; updatedAt: number } };
  f.runtime.away.store.close({ revision: 0, until: f.time() + 3_600_000, quests: [], allowWatched: false, note: "" }, [], 12);
  await expect(f.runtime.memory.manage({ action: "edit", id: note.id, expectedUpdatedAt: note.updatedAt, note: { ...draft, title: "Edited while closed" } })).resolves.toMatchObject({ title: "Edited while closed" });
  const config = f.runtime.config();
  vi.spyOn(f.runtime, "config").mockReturnValue({ ...config, tavern: { ...config.tavern, paused: true } });
  await expect(tool("lead", { op: "save", note: draft })).rejects.toThrow(/paused/i);
  const edited = f.runtime.memory.store.get("builtin", note.id)!.note;
  await expect(f.runtime.memory.manage({ action: "edit", id: note.id, expectedUpdatedAt: edited.updatedAt, note: { ...draft, title: "Edited while paused" } })).resolves.toMatchObject({ title: "Edited while paused" });
});

it("requires an explicit client to configure or browse other projects", () => {
  f = fixture();
  const handlers = memoryHandlers(f.runtime);
  expect(() => handlers.memoryConfigure({ revision: 0, config: { active: "builtin", profiles: [] } }, { experimental_caller: { kind: "plugin", pluginId: "fixture" } } as never)).toThrow(/explicit client/i);
  expect(() => handlers.memoryList({ project: "another", text: "", status: null, kind: null, memory: null, limit: 5, offset: 0 }, undefined as never)).toThrow("Memory page");
});

it("includes built-in notes, but not command profiles or external projections, in portable backups", async () => {
  f = fixture();
  const { note } = await tool("lead", { op: "save", note: draft }) as { note: { id: string } };
  const { db } = f.k.store;
  const memory = new MemoryStore(db);
  memory.configure(0, { active: "field-notes", profiles: [{ id: "field-notes", name: "Field notes", save: "/opt/notes/save", find: "/opt/notes/find", curate: "/opt/notes/curate", hostId: "host", timeoutSeconds: 3 }] });
  memory.save("not-portable", { ...memory.get("builtin", note.id)!.note, id: "external" }, "external ref");
  const backup = new BackupRecords(db, new SettingsStore(db)).capture();
  expect(backup.tables).not.toHaveProperty("tavern_memory_config");
  expect(backup.tables.tavern_memory_notes!.rows).toEqual([expect.objectContaining({ id: note.id, store: "builtin" })]);
});

it("runs three configured executables, refuses unrelated output, and switches without moving notes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "memory-profile-")));
  try {
    f = setup({ hosts: { get: async () => ({}) }, projects: { list: async () => [] }, environments: { list: async () => [] } });
    const engine = new TavernMemory(f.runtime, () => ({ call: (async (_host, method, input, options) => method === "memoryPreflight"
      ? preflightMemory(input as HostInput<"memoryPreflight">, options!.signal!)
      : runMemory(input as HostInput<"memoryRun">, options!.signal!)) as HostPort["call"], onWorkerExit: vi.fn() }));
    const call = (input: unknown) => engine.tool(memoryToolInput.parse(input), "lead", "project", new AbortController().signal);
    const config = { id: "field-notes", name: "Field notes", timeoutSeconds: 2, save: join(root, "save"), find: join(root, "find"), curate: join(root, "curate") };
    const dataFile = join(root, "note.json");
    for (const op of ["save", "find", "curate"] as const) await writeFile(config[op],
      `#!${process.execPath}\nconst fs = require('node:fs');\nif (process.argv[2] === '--help') process.exit(0);\nconst input = JSON.parse(fs.readFileSync(0,'utf8'));\nconst file = ${JSON.stringify(dataFile)};\n` + ({
        save: "fs.writeFileSync(file, JSON.stringify(input)); console.log('fixture-ref');",
        find: "if (fs.existsSync(file)) { const raw = fs.readFileSync(file, 'utf8'); if (JSON.parse(raw).memory === 'included') console.log(raw); }",
        curate: "fs.writeFileSync(file, JSON.stringify(input.note)); console.log(input.reference);",
      })[op], { mode: 0o700 });
    await call({ op: "save", note: { ...draft, title: "Built-in only" } });
    const refresh = vi.fn(() => engine.commandPaths());
    f.runtime.scopes = { refreshMemoryGuards: refresh } as never;
    const closed = f.runtime.away.store.close({ revision: 0, until: f.time() + 3_600_000, quests: [], allowWatched: false, note: "" }, [], 12);
    await expect(engine.configure(0, { active: config.id, profiles: [config] })).resolves.toMatchObject({ revision: 1 });
    expect(refresh).toHaveLastReturnedWith([config.save, config.find, config.curate]);
    f.runtime.away.store.finish(closed.window!.id, { kind: "explicit-return", threadId: null, refId: null });
    const { note } = await call({ op: "save", note: draft }) as { note: { id: string; updatedAt: number; project: string } };
    await expect(call({ op: "find" })).resolves.toMatchObject({ notes: [{ id: note.id, project: "project" }] });
    await expect(call({ op: "curate", action: "exclude", id: note.id, expectedUpdatedAt: note.updatedAt, reason: "Not applicable." })).resolves.toMatchObject({ note: { memory: "excluded" } });
    await expect(call({ op: "find" })).resolves.toMatchObject({ notes: [] });
    await writeFile(dataFile, JSON.stringify({ ...note, project: "another" }));
    await expect(call({ op: "find" })).rejects.toThrow("unrelated note");
    const stored = await engine.list({ project: "project", text: "", kind: null, limit: 4, status: null, memory: "excluded", offset: 0 });
    await writeFile(dataFile, JSON.stringify(stored.notes[0]));
    f.runtime.away.store.close({ revision: 2, until: f.time() + 3_600_000, quests: [], allowWatched: false, note: "" }, [], 12);
    await expect(engine.manage({ action: "include", id: note.id, expectedUpdatedAt: stored.notes[0]!.updatedAt })).resolves.toMatchObject({ memory: "included" });
    await engine.configure(1, { active: "builtin", profiles: [config] });
    expect(refresh).toHaveLastReturnedWith([]);
    await expect(call({ op: "find" })).resolves.toMatchObject({ notes: [{ title: "Built-in only" }] });
    const events = f.k.store.db.prepare("SELECT data FROM tavern_events WHERE type='memory.finished'").all();
    expect(JSON.stringify(events)).not.toContain(draft.body);
  } finally { await rm(root, { recursive: true, force: true }); }
});
