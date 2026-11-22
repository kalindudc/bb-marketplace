import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  PolicyError,
  applySettings,
  deepMerge,
  resolvePolicy,
  resolvePressPolicy,
  type Policy,
  type PolicyLayer,
  type PressSettings,
} from "../src/policy";
import { DEFAULT_SETTINGS } from "../src/settings";

const settings = (patch: Partial<PressSettings> = {}): PressSettings => ({ ...DEFAULT_SETTINGS, ...patch });

describe("defaults", () => {
  it("match the contract", () => {
    expect(DEFAULT_POLICY.mode).toBe("advisor");
    expect(DEFAULT_POLICY.window).toEqual({ softPercent: 35, hardPercent: 55, floorTokens: 60_000 });
    expect(DEFAULT_POLICY.points.map((p) => p.id)).toEqual(["phase", "agent", "volume", "turns", "idle", "thrash"]);
    expect(DEFAULT_POLICY.vetoes).toEqual({ midTurn: true, cooldownSeconds: 600, minTurnsBetween: 5, belowFloor: true, previousCompactionFailed: true });
    expect(DEFAULT_POLICY.providers).toEqual({ pi: { enabled: true } });
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
    expect(dataDir.window.hardPercent).toBe(55);

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
    expect(() => resolvePolicy([{ source: "workspace", value: { window: { softPercent: 99, hardPercent: 40 } } }])).toThrow(/softPercent/);
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

  it("throws when the settings make soft exceed hard", () => {
    expect(() => applySettings(DEFAULT_POLICY, settings({ softPercent: 90, hardPercent: 20 }))).toThrow(
      /softPercent/,
    );
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
    expect(atDefaults.mode).toBe("advisor");
    expect(atDefaults.window.softPercent).toBe(35);

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
});
