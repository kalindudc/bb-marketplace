import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import sessionLog from "../server";
import { DEFAULT_SETTINGS, SETTINGS_CHANNEL, SETTING_DESCRIPTORS, parseSettings } from "../src/settings";

function validate(key: "outputHeadLines" | "outputTailLines" | "thinkingLines", value: unknown) {
  return SETTING_DESCRIPTORS[key].experimental_schema["~standard"].validate(value);
}

describe("settings", () => {
  it("declares a default for every setting that matches the built-in defaults", () => {
    const defaults = Object.fromEntries(Object.entries(SETTING_DESCRIPTORS).map(([key, descriptor]) => [key, descriptor.default]));
    expect(defaults).toEqual(DEFAULT_SETTINGS);
    expect(SETTING_DESCRIPTORS.timeFormat.options).toEqual(["24h", "12h"]);
  });

  it("accepts whole line counts within range and explains anything else", () => {
    expect(validate("outputHeadLines", 0)).toEqual({ value: 0 });
    expect(validate("outputTailLines", 50)).toEqual({ value: 50 });
    expect(validate("thinkingLines", 20)).toEqual({ value: 20 });
    for (const bad of [-1, 4.5, 51, "4", Number.NaN]) {
      expect(validate("outputHeadLines", bad)).toEqual({ issues: [{ message: "Enter a whole number from 0 to 50." }] });
    }
    expect(validate("thinkingLines", 21)).toEqual({ issues: [{ message: "Enter a whole number from 0 to 20." }] });
  });

  it("reads stored values and keeps the default for any missing or invalid one", () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({
      outputHeadLines: 2, outputTailLines: 0, thinkingLines: 0, expandFailures: false,
      showMessages: false, showThinking: false, showTools: false, timeFormat: "12h",
    })).toEqual({
      outputHeadLines: 2, outputTailLines: 0, thinkingLines: 0, expandFailures: false,
      showMessages: false, showThinking: false, showTools: false, timeFormat: "12h",
    });
    expect(parseSettings({ outputHeadLines: 3.5, thinkingLines: 99, expandFailures: "yes", timeFormat: "auto" }))
      .toEqual(DEFAULT_SETTINGS);
  });
});

describe("server", () => {
  it("defines the settings and tells open panels when they change", () => {
    let listener: (() => void) | undefined;
    const define = vi.fn(() => ({ onChange: (next: () => void) => { listener = next; } }));
    const publish = vi.fn();
    const bb = { settings: { define }, realtime: { publish }, log: { info: vi.fn() } } as unknown as BbPluginApi;
    sessionLog(bb);
    expect(define).toHaveBeenCalledWith(SETTING_DESCRIPTORS);
    expect(publish).not.toHaveBeenCalled();
    listener?.();
    expect(publish).toHaveBeenCalledWith(SETTINGS_CHANNEL, {});
  });
});
