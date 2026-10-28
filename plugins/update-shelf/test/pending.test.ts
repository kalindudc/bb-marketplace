import { describe, expect, it } from "vitest";
import { pendingUpdates } from "../src/pending";
import { BURN_CANDIDATE, GENUI_CANDIDATE, GENUI_INSTALLED, burn, current, genui, results } from "./fixtures";

describe("pendingUpdates", () => {
  it("lists the plugins bb marks with an update, by name, with versions a person can read", () => {
    const updates = pendingUpdates([genui, current, burn], results, []);
    expect(updates.map((update) => update.id)).toEqual(["burn", "genui"]);
    expect(updates[1]).toEqual({
      id: "genui",
      name: "Generative UI",
      icon: "AppWindow",
      imageUrl: null,
      installed: { version: GENUI_INSTALLED, label: "0.2.6" },
      candidate: { version: GENUI_CANDIDATE, label: "0.2.7" },
      lastFailure: null,
      job: null,
    });
    expect(updates[0]).toMatchObject({
      icon: null,
      imageUrl: "/api/v1/plugins/burn/assets/icon?h=9f",
      installed: { label: "0.7.2" },
      candidate: { version: BURN_CANDIDATE, label: "eed8698" },
    });
  });

  it("labels a candidate by its short commit when the check results describe another one", () => {
    const [update] = pendingUpdates([{ ...genui, updateState: { availableVersion: BURN_CANDIDATE } }], results, []);
    expect(update!.candidate.label).toBe("eed8698");
  });

  it("shows the latest job for each plugin while it is waiting, running or failed", () => {
    const at = (state: "queued" | "running" | "completed" | "failed", extra = {}) => ({ pluginId: "genui", state, ...extra });
    const job = (jobs: Parameters<typeof pendingUpdates>[2]) => pendingUpdates([genui], results, jobs)[0]!.job;
    expect(job([at("queued")])).toEqual({ state: "queued", detail: null });
    expect(job([at("failed", { error: "old" }), at("running", { phase: "activating" })])).toEqual({ state: "running", detail: "Activating" });
    expect(job([at("failed", { error: "build failed" })])).toEqual({ state: "failed", detail: "build failed" });
    expect(job([at("completed")])).toBeNull();
    expect(job([{ pluginId: "burn", state: "queued" }])).toBeNull();
  });

  it("carries a rolled-back update so the row can offer a retry", () => {
    const failed = { ...genui, updateState: { ...genui.updateState, lastFailure: { version: GENUI_CANDIDATE, detail: "" } } };
    expect(pendingUpdates([failed], results, [])[0]!.lastFailure).toBe("The update to f1fb0e8 was rolled back.");
  });
});
