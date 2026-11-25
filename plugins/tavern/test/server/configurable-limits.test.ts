// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, settingsPatchSchema, settingsUpdateSchema } from "../../src/shared/settings";
import { exportToml, previewToml } from "../../src/server/settings/toml";
import { SettingsStore } from "../../src/server/settings/store";
import { registerTools } from "../../src/server/tools";
import { setup } from "./runtime-fixture";
import { planInput, seedQuest } from "./support";

describe("protective limits", () => {
  it("keeps the catalog small and rejects removed field-by-field settings", () => {
    expect(DEFAULT_SETTINGS.limits).toEqual({
      intake: { proseChars: 16000, briefPromptBytes: 32000 },
      journal: { entriesMax: 200, noteKeepChars: 2000, reminderBytes: 4096 },
      transport: { draftBodyChars: 8000, toolResultChars: 18000 },
    });
    expect(settingsPatchSchema.safeParse({ limits: { plans: { waypointsMax: 4 } } }).success).toBe(false);
  });

  it("round-trips the text budget through TOML and validates its reset path", () => {
    const f = setup();
    const store = new SettingsStore(f.k.store.db);
    try {
      store.update({ revision: store.snapshot().revision, patch: { limits: { intake: { proseChars: 12000 } } }, why: "Set a test limit" }, null);
      const toml = exportToml(store.snapshot());
      expect(toml).toContain("[limits.intake]\nprose_chars = 12000");
      expect(previewToml(toml, store.snapshot()).user).toMatchObject({ limits: { intake: { proseChars: 12000 } } });
      expect(previewToml("[limits.intake]\nprose_chars = 0", store.snapshot()).problems).toMatchObject([{ key: "limits.intake.prose_chars", allowed: "64 to 64000" }]);
      const reset = settingsUpdateSchema.parse({ revision: store.snapshot().revision, patch: {}, reset: ["limits.intake.proseChars"], why: "Reset the test limit" });
      store.update(reset, null);
      expect(store.read().limits.intake.proseChars).toBe(16000);
    } finally { f.k.store.db.close(); }
  });

  it("does not cap plan list length, reads changed prose budgets live and leaves saved plans alone", async () => {
    const f = setup();
    const store = f.runtime.settings = new SettingsStore(f.k.store.db);
    registerTools(f.bb, f.runtime);
    const call = (input: unknown) => f.harness.behavior.invokeAgentTool("tavern_plan", input, { threadId: "lead" });
    const title = "Long waypoint title ".repeat(20);
    try {
      const quest = await seedQuest(f.k, "lead", "Check the parser", "Parser");
      const base = planInput(quest.id);
      const waypoints = Array.from({ length: 61 }, (_, n) => ({ ...base.waypoints[0], id: `w${n + 1}`, owner: null, check: "none", title }));
      const questions = Array.from({ length: 4 }, (_, n) => ({ id: `q${n + 1}`, text: `Question ${n + 1}?`, options: [], recommended: null, reversible: true }));
      await expect(call({ ...base, waypoints, questions })).resolves.toContain("Plan v1 saved");
      store.update({ revision: store.snapshot().revision, patch: { limits: { intake: { proseChars: 64 } } }, why: "Tune the stored text budget" });
      await expect(call({ ...base, waypoints, questions })).resolves.toContain("Limit: limits.intake.proseChars = 64 (Settings, Limits)");
      expect(f.k.store.get("plans", `${quest.id}:1`)?.waypoints[0]?.title).toBe(title);
      expect(f.k.store.get("plans", `${quest.id}:2`)?.waypoints[0]?.title).toBe(`${title.slice(0, 63)}…`);
    } finally { f.k.store.db.close(); }
  });

  it("does not let a copied class silently narrow the Settings staffing limits", async () => {
    const f = setup();
    const store = f.runtime.settings = new SettingsStore(f.k.store.db);
    const snapshot = f.runtime.snapshot();
    vi.spyOn(f.runtime, "snapshot").mockReturnValue({ ...snapshot, classes: snapshot.classes.map(role => role.id === "keeper"
      ? { ...role, source: "/example/classes/keeper.md", budget: { members: 1, rangers: 1, rangerMinutes: 2 } } : role) });
    const hire = { classId: "ranger", title: "Research", errand: true, brief: {
      outcome: "Read", mode: "make-it-work" as const, doneWhen: "Report evidence", context: [], outOfScope: "", questions: ["What changed?"], timeboxMinutes: 5,
    } };
    try {
      store.update({ revision: store.snapshot().revision, patch: { keepers: { partyMax: 3, rangerMax: 2 }, knobs: { rangerTimeboxMaxMinutes: 8 } }, why: "Configure staffing" });
      await f.runtime.hire("lead", "project", hire);
      await f.runtime.hire("lead", "project", hire);
      await expect(f.runtime.hire("lead", "project", hire)).rejects.toThrow("Limit: keepers.rangerMax = 2 (Settings, Keepers and decisions)");
    } finally { f.k.store.db.close(); }
  });

  it("keeps the full headline and the Warden label while shortening only storage-sized report prose", async () => {
    const f = setup();
    registerTools(f.bb, f.runtime);
    f.k.bind("check", "warden", null, "project", { keeperThreadId: "lead", boardQuestId: null, waypointId: null, title: "Check", errand: true,
      brief: { outcome: "Check", mode: "make-it-work", outOfScope: "", doneWhen: "Done", context: [], questions: [], timeboxMinutes: null } });
    f.k.store.put("members", "check", { ...f.k.member("check")!, checkIndependence: "same-family" });
    const headline = "Y".repeat(1300);
    try {
      const result = await f.harness.behavior.invokeAgentTool("tavern_report", { status: "blocked", outcome: "X".repeat(16001), headline, evidence: [], artifacts: [] }, { threadId: "check" });
      expect(result).toContain("Limit: limits.intake.proseChars = 16000 (Settings, Limits)");
      const report = f.k.store.all("reports")[0]!;
      expect(report.headline).toBe(`same-family check (not independent): ${headline}`);
      expect(report.outcome).toHaveLength(16000);
      expect(report.outcome.endsWith("…")).toBe(true);
    } finally { f.k.store.db.close(); }
  });

  it("uses the live decision timer and names the refusal setting", async () => {
    const f = setup();
    const store = f.runtime.settings = new SettingsStore(f.k.store.db);
    f.k.settings = questId => store.read(questId);
    registerTools(f.bb, f.runtime);
    const call = (minutes: number) => f.harness.behavior.invokeAgentTool("tavern_ask", {
      operation: "open", question: "Use the first check?", why: "Either check is reversible", kind: "decision",
      options: [{ id: "go", label: "Use it", recommended: true }], holds: [], meanwhile: "", reversible: true, proceedInMinutes: minutes,
    }, { threadId: "lead" });
    try {
      store.update({ revision: store.snapshot().revision, patch: { keepers: { decisionTimerMax: 3 } }, why: "Limit timed defaults" });
      await expect(call(4)).rejects.toThrow("Limit: keepers.decisionTimerMax = 3 (Settings, Keepers and decisions)");
      await call(3);
      expect(f.k.store.all("asks")[0]?.proceedAt).not.toBeNull();
    } finally { f.k.store.db.close(); }
  });

  it("bounds delivered results independently of saved prose and names the setting", async () => {
    const f = setup();
    const store = f.runtime.settings = new SettingsStore(f.k.store.db);
    registerTools(f.bb, f.runtime);
    try {
      store.update({ revision: store.snapshot().revision, patch: { limits: { transport: { toolResultChars: 512 } } }, why: "Limit model output" });
      const out = await f.harness.behavior.invokeAgentTool("tavern_status", {}, { threadId: "lead" }) as string;
      expect(out.length).toBeLessThanOrEqual(512);
      expect(out).toContain("Limit: limits.transport.toolResultChars = 512 (Settings, Limits)");
    } finally { f.k.store.db.close(); }
  });

  it("keeps ask labels and options whole and never rewrites an exact draft", async () => {
    const f = setup();
    registerTools(f.bb, f.runtime);
    const call = (input: unknown) => f.harness.behavior.invokeAgentTool("tavern_ask", input, { threadId: "lead" });
    const label = "Y".repeat(1201);
    const options = Array.from({ length: 21 }, (_, n) => ({ id: `option-${n}`, label: `${label}${n}` }));
    const ask = { operation: "open", question: "A question?", why: "Because", kind: "decision", options, meanwhile: "Work continues.", holds: [] };
    try {
      expect(await call(ask)).not.toContain("Text truncated");
      expect(f.k.store.all("asks")[0]!.options.map(o => o.label)).toEqual(options.map(o => o.label));
      const draft = { to: "Recipient", body: " B".repeat(4000) };
      await expect(call({ ...ask, kind: "sends-as-you", draft: { ...draft, body: draft.body + "!" } })).rejects.toThrow("Limit: limits.transport.draftBodyChars = 8000 (Settings, Limits)");
      await call({ ...ask, kind: "sends-as-you", draft });
      expect(f.k.store.all("asks").find(a => a.kind === "sends-as-you")?.draft).toEqual(draft);
    } finally { f.k.store.db.close(); }
  });
});
