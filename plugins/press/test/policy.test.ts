import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  DEFAULT_POLICY,
  PolicyError,
  SETTINGS_OWNED_PATHS,
  applySettings,
  settingsKeyOf,
  deepMerge,
  mergeThreadOverride,
  resolvePolicy,
  resolvePressPolicy,
  settingsOwnedPaths,
  type Policy,
  type PolicyLayer,
  type PressSettings,
} from "../src/policy";
import { DEFAULT_SETTINGS, normalizeSettings, pressSettings } from "../src/settings";

const settings = (patch: Partial<PressSettings> = {}): PressSettings => ({ ...DEFAULT_SETTINGS, ...patch });

describe("defaults", () => {
  it("match the contract", () => {
    expect(DEFAULT_POLICY.mode).toBe("auto");
    expect(DEFAULT_POLICY.window).toEqual({ softPercent: 55, hardPercent: 80, floorTokens: 150_000 });
    expect(DEFAULT_POLICY.points.map((p) => [p.id, p.enabled])).toEqual([
      ["phase", true], ["agent", true], ["volume", true], ["turns", false], ["idle", false], ["thrash", false],
    ]);
    expect(DEFAULT_POLICY.points.find((p) => p.id === "phase")?.signals).toEqual(["plan.approved", "tests.green", "pr.opened"]);
    expect(DEFAULT_POLICY.vetoes).toEqual({ midTurn: true, cooldownSeconds: 600, minTurnsBetween: 2, belowFloor: true, previousCompactionFailed: true });
    expect(DEFAULT_POLICY.providers).toEqual({ pi: { enabled: true } });
  });

  it("are what the default settings produce, so the settings page and policy.json agree", () => {
    expect(applySettings(DEFAULT_POLICY, DEFAULT_SETTINGS)).toEqual(DEFAULT_POLICY);
  });

  it("resolve to themselves with no layers", () => {
    expect(resolvePolicy([])).toEqual(DEFAULT_POLICY);
  });
});

describe("deepMerge", () => {
  it("merges objects recursively", () => {
    expect(deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } })).toEqual({ a: { b: 1, c: 3 } });
  });

  it("replaces arrays and scalars, keeps undefined", () => {
    expect(deepMerge({ list: [1, 2], x: 1 }, { list: [3], x: undefined })).toEqual({ list: [3], x: 1 });
  });
});

describe("resolution order", () => {
  it("a workspace layer overrides a dataDir layer, a thread override beats both", () => {
    const dataDir = resolvePolicy([{ source: "dataDir", value: { mode: "observe", window: { softPercent: 20 } } }]);
    expect(dataDir.mode).toBe("observe");
    expect(dataDir.window.softPercent).toBe(20);
    expect(dataDir.window.hardPercent).toBe(80);

    const workspace = resolvePolicy([
      { source: "dataDir", value: { mode: "observe", window: { softPercent: 20 } } },
      { source: "workspace", value: { mode: "auto" } },
    ]);
    expect(workspace.mode).toBe("auto");
    expect(workspace.window.softPercent).toBe(20);

    const thread = resolvePolicy([
      { source: "dataDir", value: { mode: "observe" } },
      { source: "workspace", value: { mode: "auto" } },
      { source: "thread", value: { mode: "advisor" } },
    ]);
    expect(thread.mode).toBe("advisor");
  });

  it("replaces the points array wholesale, then validates each point", () => {
    const resolved = resolvePolicy([{ source: "workspace", value: { points: [{ id: "only", when: "idleSeconds", value: 10 }] } }]);
    expect(resolved.points).toHaveLength(1);
    expect(resolved.points[0]).toMatchObject({ id: "only", enabled: true, when: "idleSeconds", value: 10 });
  });

  it("keeps unknown fields for forward compatibility", () => {
    const resolved = resolvePolicy([{ source: "workspace", value: { futureKnob: { x: 1 } } }]);
    expect((resolved as { futureKnob?: unknown }).futureKnob).toEqual({ x: 1 });
  });

  it("throws a clear error on a bad value", () => {
    expect(() => resolvePolicy([{ source: "workspace", value: { mode: "yolo" } }])).toThrow(PolicyError);
  });

  it("clamps an inverted window and reports the layer that set it", () => {
    const reports: unknown[] = [];
    const layers = [
      { source: "dataDir", value: { window: { softPercent: 90 } } },
      { source: "workspace", value: { window: { hardPercent: 40 } } },
      { source: "another", value: { mode: "observe" } },
    ];
    const report = (source: string, issues: readonly string[]) => reports.push([source, issues]);
    expect(resolvePolicy(layers, report).window).toMatchObject({ softPercent: 40, hardPercent: 40 });
    expect(reports).toEqual([["workspace", [expect.stringMatching(/softPercent.*90.*hardPercent.*40/)]]]);
    expect(resolvePolicy(layers).window.softPercent).toBe(40);
  });

  it("lets a later layer repair an intermediate inversion before clamping", () => {
    const reports: string[] = [];
    const resolved = resolvePolicy([
      { source: "dataDir", value: { window: { softPercent: 90 } } },
      { source: "workspace", value: { window: { hardPercent: 95 } } },
    ], (source) => reports.push(source));
    expect(resolved.window).toMatchObject({ softPercent: 90, hardPercent: 95 });
    expect(reports).toEqual([]);
  });

  it("throws naming the layer on invalid JSON semantics", () => {
    let error: unknown = null;
    try {
      resolvePolicy([{ source: "workspace", value: { points: "nope" } }]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PolicyError);
    expect(String(error)).toContain("workspace");
  });

  it("a policy file can turn every point off", () => {
    const resolved = resolvePolicy([
      {
        source: "workspace",
        value: { points: DEFAULT_POLICY.points.map((point) => ({ ...point, enabled: false })) },
      },
    ]) as Policy;
    expect(resolved.points.every((point) => !point.enabled)).toBe(true);
  });
});
describe("applySettings", () => {
  it("maps every setting onto the policy", () => {
    const resolved = applySettings(
      DEFAULT_POLICY,
      settings({
        mode: "auto",
        softPercent: 40,
        hardPercent: 80,
        floorTokens: 1000,
        phasePoint: false,
        turnsPoint: true,
        idlePoint: true,
        volumeBytes: 5000,
        turnsBetween: 10,
        idleSeconds: 60,
        cooldownSeconds: 30,
        minTurnsBetween: 2,
        composerModel: "openai/gpt-4o-mini",
        maxSummaryTokens: 900,
      }),
    );
    expect(resolved.mode).toBe("auto");
    expect(resolved.window).toEqual({ softPercent: 40, hardPercent: 80, floorTokens: 1000 });
    expect(resolved.points.find((point) => point.id === "phase")?.enabled).toBe(false);
    expect(resolved.points.find((point) => point.id === "volume")).toMatchObject({ enabled: true, value: 5000 });
    expect(resolved.points.find((point) => point.id === "turns")).toMatchObject({ enabled: true, value: 10 });
    expect(resolved.points.find((point) => point.id === "idle")).toMatchObject({ enabled: true, value: 60 });
    expect(resolved.vetoes.cooldownSeconds).toBe(30);
    expect(resolved.vetoes.minTurnsBetween).toBe(2);
    expect(resolved.composer.model).toBe("openai/gpt-4o-mini");
    expect(resolved.composer.maxSummaryTokens).toBe(900);
  });

  it("an empty composerModel means the thread's own model", () => {
    const resolved = applySettings(DEFAULT_POLICY, settings({ composerModel: "" }));
    expect(resolved.composer.model).toBeNull();
  });

  it("keeps what the UI cannot express: signals, minPercent, providers, custom points", () => {
    const withCustom = resolvePolicy([
      {
        source: "workspace",
        value: {
          points: [
            ...DEFAULT_POLICY.points,
            { id: "custom", enabled: true, when: "idleSeconds", value: 99, minPercent: 5 },
          ],
          providers: { pi: { enabled: false } },
        },
      },
    ]);
    const resolved = applySettings(withCustom, settings({ idlePoint: false, idleSeconds: 42 }));
    const custom = resolved.points.find((point) => point.id === "custom");
    expect(custom).toMatchObject({ enabled: true, value: 99, minPercent: 5 });
    expect(resolved.providers.pi.enabled).toBe(false);
    expect(resolved.points.find((point) => point.id === "phase")?.signals).toEqual(DEFAULT_POLICY.points[0].signals);
  });

  it("clamps when the settings make soft exceed hard", () => {
    expect(applySettings(DEFAULT_POLICY, settings({ softPercent: 90, hardPercent: 20 })).window).toMatchObject({
      softPercent: 20,
      hardPercent: 20,
    });
  });
});

const reportInto = (reports: unknown[]) => (source: string, issues: readonly string[]) => reports.push([source, issues]);

describe("settings", () => {
  it("clamps the normalized soft threshold to the normalized hard threshold and can report it", () => {
    const reports: unknown[] = [];
    expect(normalizeSettings({ softPercent: 90, hardPercent: 20.4 }, reportInto(reports))).toMatchObject({ softPercent: 20, hardPercent: 20 });
    expect(reports).toEqual([["settings", [expect.stringMatching(/softPercent.*90.*hardPercent.*20/)]]]);
    expect(normalizeSettings({ softPercent: 90, hardPercent: 20 }).softPercent).toBe(20);
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it("describes the soft window as a gate and the backstop as respecting idle and cooldown", () => {
    expect(pressSettings.softPercent.label).toBe("Points can fire from (percent of window)");
    expect(pressSettings.softPercent.description).toMatch(/only count at or above/);
    expect(pressSettings.hardPercent.description).toMatch(/idle.*cooldown/);
    expect(pressSettings.cooldownSeconds.label).toMatch(/attempt/);
  });

  it("reports only supplied settings-owned fields, leaving point arrays and other fields to the file layer", () => {
    expect(SETTINGS_OWNED_PATHS).toEqual([
      "mode", "window.softPercent", "window.hardPercent", "window.floorTokens",
      "vetoes.cooldownSeconds", "vetoes.minTurnsBetween", "composer.model", "composer.maxSummaryTokens",
    ]);
    expect(settingsOwnedPaths({
      mode: "observe",
      window: { hardPercent: 75, floorTokens: 0 },
      vetoes: { midTurn: false, cooldownSeconds: 0 },
      composer: { model: null, ledger: false, maxSummaryTokens: 0 },
      points: [{ id: "phase", enabled: false, when: "boundary", signals: ["plan.approved"] }],
    })).toEqual([
      "mode", "window.hardPercent", "window.floorTokens", "vetoes.cooldownSeconds", "composer.model", "composer.maxSummaryTokens",
      "points[phase].enabled",
    ]);
    expect(settingsOwnedPaths({ mode: undefined, window: null, "window.softPercent": 15 })).toEqual([]);
    expect(settingsOwnedPaths(Object.create({ mode: "auto" }))).toEqual([]);
    expect(settingsOwnedPaths(null)).toEqual([]);
  });

  it("reports the built-in points' switches and thresholds, which the settings overwrite, with their setting keys", () => {
    const owned = settingsOwnedPaths({
      points: [
        { id: "volume", when: "toolResultBytes", value: 500_000 },
        { id: "idle", enabled: true, when: "idleSeconds", value: 60, minPercent: 10 },
        { id: "phase", when: "boundary", signals: ["tests.green"] },
        { id: "custom", enabled: false, when: "toolResultBytes", value: 5 },
        "not a point",
      ],
    });
    expect(owned).toEqual(["points[volume].value", "points[idle].enabled", "points[idle].value"]);
    expect(owned.map(settingsKeyOf)).toEqual(["volumeBytes", "idlePoint", "idleSeconds"]);
    expect(settingsKeyOf("window.softPercent")).toBe("softPercent");
    expect(settingsKeyOf("composer.model")).toBe("composerModel");
    expect(settingsOwnedPaths({ points: "nope" })).toEqual([]);
  });

  it("refuses a summary model that is not provider/modelId, in the settings and in a policy file", () => {
    const schema = pressSettings.composerModel.experimental_schema as z.ZodType | undefined;
    expect(schema?.safeParse("").success).toBe(true);
    expect(schema?.safeParse("anthropic/claude-sonnet").success).toBe(true);
    expect(schema?.safeParse("claude-sonnet").success).toBe(false);
    expect(() => resolvePolicy([{ source: "workspace", value: { composer: { model: "claude-sonnet" } } }])).toThrow(/composer\.model/);
    expect(resolvePolicy([{ source: "workspace", value: { composer: { model: "a/b" } } }]).composer.model).toBe("a/b");
    expect(resolvePolicy([{ source: "workspace", value: { composer: { model: null } } }]).composer.model).toBeNull();
    // A value stored before the schema refused it degrades to the thread's own model instead of failing every resolution.
    expect(normalizeSettings({ composerModel: "claude-sonnet" }).composerModel).toBe("");
    expect(resolvePressPolicy([], normalizeSettings({ composerModel: "claude-sonnet" }), null).composer.model).toBeNull();
  });
});

describe("thread controls", () => {
  it("merges mode and one point without replacing raw arrays or other overrides", () => {
    const original = { custom: { retained: 1 }, points: [{ id: "idle", when: "idleSeconds", value: 12 }], pointOverrides: { phase: false } };
    const mode = mergeThreadOverride(JSON.stringify(original), { mode: "auto" });
    const point = mergeThreadOverride(JSON.stringify(mode), { pointOverrides: { idle: false } });
    expect(point).toEqual({ ...original, mode: "auto", pointOverrides: { phase: false, idle: false } });
    expect(resolvePressPolicy([], DEFAULT_SETTINGS, { source: "test", value: point }).points)
      .toEqual([{ ...original.points[0], enabled: false }]);
  });

  it("keeps untouched defaults live and can explicitly enable an absent point", () => {
    const lookup = (value: unknown) => resolvePressPolicy([], { ...DEFAULT_SETTINGS, turnsBetween: 11 }, { source: "test", value });
    const value = mergeThreadOverride(null, { pointOverrides: { volume: false } });
    expect(lookup(value).points.find((p) => p.id === "turns")?.value).toBe(11);
    const missing = mergeThreadOverride('{"points":[]}', { pointOverrides: { turns: true } });
    expect(lookup(missing).points).toEqual([{ id: "turns", when: "turnsSinceCompaction", enabled: true, value: 11 }]);
    expect(() => mergeThreadOverride("[]", { mode: "auto" })).toThrow("JSON object");
  });
});

describe("resolvePressPolicy", () => {
  const dataDir: PolicyLayer = { source: "dataDir", value: { mode: "observe", window: { softPercent: 20 }, providers: { codex: { enabled: false } } } };
  const workspace: PolicyLayer = {
    source: "workspace",
    value: { providers: { codex: { enabled: true } }, points: [{ id: "only", when: "idleSeconds", value: 10 }] },
  };
  const override: PolicyLayer = { source: "thread override", value: { mode: "advisor" } };
  const skipped: string[] = [];
  const onLayerError = (source: string): void => {
    skipped.push(source);
  };

  it("the dataDir layer overrides the built-in defaults for what files still own", () => {
    const resolved = resolvePressPolicy([dataDir], settings(), null);
    expect(resolved.providers.codex.enabled).toBe(false);
    expect(resolved.points.find((point) => point.id === "phase")?.signals).toEqual(DEFAULT_POLICY.points[0].signals);
  });

  it("the workspace layer overrides the dataDir layer", () => {
    const resolved = resolvePressPolicy([dataDir, workspace], settings(), null);
    expect(resolved.providers.codex.enabled).toBe(true);
    expect(resolved.points).toHaveLength(1);
  });

  it("the settings win over the files for everything the UI covers, even at their defaults", () => {
    // The files set mode=observe and softPercent=20; untouched settings carry the defaults and win.
    const atDefaults = resolvePressPolicy([dataDir], settings(), null);
    expect(atDefaults.mode).toBe("auto");
    expect(atDefaults.window.softPercent).toBe(55);

    const chosen = resolvePressPolicy([dataDir], settings({ mode: "observe", softPercent: 30, volumeBytes: 7000, phasePoint: false }), null);
    expect(chosen.mode).toBe("observe");
    expect(chosen.window.softPercent).toBe(30);
    expect(chosen.points.find((point) => point.id === "phase")?.enabled).toBe(false);
  });

  it("the settings patch the built-in points even when no file replaced them", () => {
    const resolved = resolvePressPolicy(
      [{ source: "dataDir", value: { mode: "observe" } }],
      settings({ thrashPoint: false, turnsBetween: 33 }),
      null,
    );
    expect(resolved.points.find((point) => point.id === "thrash")?.enabled).toBe(false);
    expect(resolved.points.find((point) => point.id === "turns")).toMatchObject({ value: 33 });
  });

  it("the per-thread override beats the settings", () => {
    const resolved = resolvePressPolicy([dataDir, workspace], settings({ mode: "auto" }), override);
    expect(resolved.mode).toBe("advisor");
  });

  it("the files keep what the UI cannot express under the settings layer", () => {
    const resolved = resolvePressPolicy(
      [{ source: "workspace", value: { providers: { pi: { enabled: false } }, points: [{ id: "only", when: "idleSeconds", value: 10 }] } }],
      settings({ thrashPoint: false }),
      null,
    );
    expect(resolved.providers.pi.enabled).toBe(false);
    // The workspace layer replaced the points array; the settings still apply to what exists.
    expect(resolved.points.find((point) => point.id === "only")).toMatchObject({ enabled: true, value: 10 });
  });

  it("a bad file layer is skipped and reported, the rest still resolve", () => {
    const resolved = resolvePressPolicy(
      [{ source: "bad file", value: { mode: "yolo" } }, dataDir],
      settings({ mode: "auto" }),
      null,
      onLayerError,
    );
    expect(skipped).toContain("bad file");
    expect(resolved.mode).toBe("auto");
    expect(resolved.providers.codex.enabled).toBe(false);
  });

  it("a bad override is skipped, the settings stand", () => {
    const resolved = resolvePressPolicy([], settings({ mode: "observe" }), {
      source: "override",
      value: { window: "nope" },
    }, onLayerError);
    expect(skipped).toContain("override");
    expect(resolved.mode).toBe("observe");
  });

  it("a null override layer resolves to the settings alone", () => {
    const resolved = resolvePressPolicy([dataDir], settings({ mode: "advisor" }), { source: "override", value: null });
    expect(resolved.mode).toBe("advisor");
  });

  it("reports and clamps settings and a per-thread inversion without throwing or skipping the override", () => {
    const reports: unknown[] = [];
    const resolved = resolvePressPolicy([], settings({ softPercent: 90, hardPercent: 75 }), {
      source: "thread override",
      value: { mode: "advisor", window: { hardPercent: 40 } },
    }, reportInto(reports));
    expect(resolved.window).toMatchObject({ softPercent: 40, hardPercent: 40 });
    expect(resolved.mode).toBe("advisor");
    expect(reports).toEqual([
      ["settings", [expect.stringMatching(/softPercent.*90.*hardPercent.*75/)]],
      ["thread override", [expect.stringMatching(/softPercent.*75.*hardPercent.*40/)]],
    ]);
  });

  it.each([
    ["boundary", "test.green"],
    ["signal", "sameFileReads>=3"],
    ["signal", "sameFileRead=>3"],
    ["signal", "same FileRead>=3"],
    ["signal", `toolResultBytes>${"9".repeat(400)}`],
  ])("rejects a %s policy layer with the invalid signal %s", (when, signal) => {
    const reports: unknown[] = [];
    const bad = { source: "workspace", value: { providers: { pi: { enabled: false } }, points: [{ id: "unknown", when, signals: [signal] }] } };
    expect(resolvePressPolicy([], settings(), null).points).toEqual(DEFAULT_POLICY.points);
    expect(resolvePressPolicy([bad], settings(), null, reportInto(reports))).toEqual(DEFAULT_POLICY);
    expect(reports).toEqual([["workspace", [expect.stringContaining("points.0.signals.0")]]]);
    expect(() => resolvePolicy([bad])).toThrow(/workspace: points\.0\.signals\.0/);
  });

  it("loads a 0.1.0 file that lists the retired journal.entry.done, dropping only that name, with a warning", () => {
    const reports: unknown[] = [];
    const legacy = {
      source: "workspace",
      value: {
        providers: { pi: { enabled: false } },
        vetoes: { midTurn: false },
        points: [{ id: "phase", enabled: true, when: "boundary", signals: ["plan.approved", "tests.green", "pr.opened", "journal.entry.done"] }],
      },
    };
    const resolved = resolvePressPolicy([legacy], settings(), null, reportInto(reports));
    expect(resolved.providers.pi).toEqual({ enabled: false });
    expect(resolved.vetoes.midTurn).toBe(false);
    expect(resolved.points).toEqual([{ id: "phase", enabled: true, when: "boundary", signals: ["plan.approved", "tests.green", "pr.opened"] }]);
    expect(reports).toEqual([["workspace", [expect.stringMatching(/points\.0\.signals.*journal\.entry\.done.*retired/)]]]);
    expect(resolvePolicy([legacy]).providers.pi).toEqual({ enabled: false });
  });

  it("keeps boundary names and threshold expressions accepted by the decision engine", () => {
    const points = [
      { id: "phase", when: "boundary", signals: ["tests.green", "agentHint"] },
      { id: "metrics", when: "signal", signals: [" sameFileRead >= 3 ", "sameCommandFailed<=2", "toolResultBytes>1", "subagentReportBytes==40.5"] },
    ];
    expect(resolvePolicy([{ source: "workspace", value: { points } }]).points)
      .toEqual(points.map((point) => ({ ...point, enabled: true })));
  });
});
