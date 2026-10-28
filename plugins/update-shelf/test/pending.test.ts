import { describe, expect, it } from "vitest";
import { updateRows, type InstalledPluginLike, type LabelMemory, type UpdateJobLike } from "../src/pending";
import { BURN_CANDIDATE, BURN_INSTALLED, GENUI_CANDIDATE, GENUI_INSTALLED, burn, current, genui, results } from "./fixtures";

const rows = (plugins: InstalledPluginLike[], jobs: UpdateJobLike[] = [], memory: LabelMemory = new Map()) =>
  updateRows(plugins, results, jobs, memory);

const job = (id: string, pluginId: string, state: UpdateJobLike["state"], extra: Partial<UpdateJobLike> = {}): UpdateJobLike => ({
  id,
  pluginId,
  state,
  ...extra,
});

/** What bb's plugin record says once it starts activating an update: no waiting update, and the new version. */
const activated = (plugin: InstalledPluginLike, version: string): InstalledPluginLike => ({ ...plugin, version, updateState: {} });

describe("updateRows", () => {
  it("lists the plugins bb marks with an update, by name, with versions a person can read", () => {
    const [first, second] = rows([genui, current, burn]);
    expect([first!.id, second!.id]).toEqual(["burn", "genui"]);
    expect(second).toEqual({
      id: "genui",
      name: "Generative UI",
      icon: "AppWindow",
      imageUrl: null,
      installed: { version: GENUI_INSTALLED, label: "0.2.6" },
      candidate: { version: GENUI_CANDIDATE, label: "0.2.7" },
      updateAvailable: true,
      lastFailure: null,
      job: null,
    });
    expect(first).toMatchObject({
      icon: null,
      imageUrl: "/api/v1/plugins/burn/assets/icon?h=9f",
      installed: { label: "0.7.2" },
      candidate: { version: BURN_CANDIDATE, label: "eed8698" },
    });
  });

  it("keeps a running update's row after bb clears its waiting update, with the versions it had before", () => {
    // The bug this guards: bb clears availableVersion when it starts activating, 30 s or more before the job ends,
    // so the running update vanished and only the queued ones were left, looking stuck.
    const memory: LabelMemory = new Map();
    rows([genui], [job("j1", "genui", "queued")], memory);
    const [row] = rows([activated(genui, "0.2.7")], [job("j1", "genui", "running", { phase: "checking" })], memory);
    expect(row).toMatchObject({
      id: "genui",
      updateAvailable: false,
      installed: { label: "0.2.6" },
      candidate: { label: "0.2.7" },
      job: { id: "j1", state: "running", phase: "checking", queuePosition: null },
    });
  });

  it("falls back to the last check's versions for a running update it never saw waiting", () => {
    const [row] = rows([activated(burn, "0.7.2")], [job("j1", "burn", "running", { phase: "activating" })]);
    expect(row).toMatchObject({ installed: { version: BURN_INSTALLED, label: "a713743" }, candidate: { label: "eed8698" } });
  });

  it("orders the running update first, then the queue in the order bb will run it, then the rest", () => {
    const plugins = [genui, burn, { ...current, updateState: { availableVersion: "c".repeat(40) } }];
    const jobs = [job("j0", "loom", "completed", { result: { from: results[0]!.installed, to: results[0]!.candidate, outcome: "updated" } }), job("j1", "genui", "queued"), job("j2", "burn", "running", { phase: "preparing" })];
    const ordered = rows(plugins, jobs);
    expect(ordered.map((row) => [row.id, row.job?.state ?? null, row.job?.queuePosition ?? null])).toEqual([
      ["burn", "running", null],
      ["genui", "queued", 1],
      ["loom", null, null],
    ]);
  });

  it("numbers each queued update by its place in bb's queue", () => {
    const plugins = [genui, burn];
    const ordered = rows(plugins, [job("j1", "burn", "queued"), job("j2", "genui", "queued")]);
    expect(ordered.map((row) => [row.id, row.job?.queuePosition])).toEqual([
      ["burn", 1],
      ["genui", 2],
    ]);
  });

  it("keeps a finished update as a result until bb forgets the job", () => {
    const done = job("j1", "genui", "completed", {
      result: { from: results[0]!.installed, to: results[0]!.candidate, outcome: "updated" },
    });
    const [row] = rows([activated(genui, "0.2.7")], [done]);
    expect(row).toMatchObject({
      updateAvailable: false,
      installed: { label: "0.2.6" },
      candidate: { label: "0.2.7" },
      job: { state: "completed", outcome: "updated", error: null },
    });
    expect(rows([activated(genui, "0.2.7")], [])).toEqual([]);
  });

  it("says why an update failed or was rolled back", () => {
    const failed = rows([genui], [job("j1", "genui", "failed", { error: "npm install failed" })])[0]!;
    expect(failed.job).toMatchObject({ state: "failed", error: "npm install failed" });
    const rolledBack = rows(
      [genui],
      [job("j2", "genui", "completed", { result: { from: results[0]!.installed, outcome: "rolled-back", detail: "plugin failed to load" } })],
    )[0]!;
    expect(rolledBack.job).toMatchObject({ outcome: "rolled-back", error: "plugin failed to load" });
    expect(rolledBack.updateAvailable).toBe(true);
  });

  it("drops an old successful job once a newer update is waiting", () => {
    const old = job("j1", "genui", "completed", { result: { from: results[0]!.installed, to: results[0]!.candidate, outcome: "updated" } });
    expect(rows([genui], [old])[0]!.job).toBeNull();
  });

  it("forgets remembered versions once bb forgets the job", () => {
    const memory: LabelMemory = new Map();
    rows([genui], [job("j1", "genui", "queued")], memory);
    expect(memory.has("j1")).toBe(true);
    rows([genui], [], memory);
    expect(memory.size).toBe(0);
  });

  it("carries a rolled-back update so the row can offer a retry", () => {
    const failedState = { ...genui, updateState: { ...genui.updateState, lastFailure: { version: GENUI_CANDIDATE, detail: "" } } };
    expect(rows([failedState])[0]!.lastFailure).toBe("The update to f1fb0e8 was rolled back.");
  });
});
