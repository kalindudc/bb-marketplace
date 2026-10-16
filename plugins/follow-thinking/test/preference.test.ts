import { afterEach, describe, expect, it, vi } from "vitest";
import { ENABLED_STORAGE_KEY, createPreference } from "../src/preference";

afterEach(() => {
  window.localStorage.clear();
});

// Browsers fire `storage` only in other windows, so the test dispatches it by hand.
function changeFromAnotherWindow(value: "true" | "false") {
  window.localStorage.setItem(ENABLED_STORAGE_KEY, value);
  window.dispatchEvent(
    new StorageEvent("storage", { key: ENABLED_STORAGE_KEY, newValue: value }),
  );
}

describe("createPreference", () => {
  it("is enabled when nothing is stored", () => {
    expect(createPreference(window).isEnabled()).toBe(true);
  });

  it("persists a change and notifies subscribers", () => {
    const preference = createPreference(window);
    const listener = vi.fn();
    preference.subscribe(listener);

    preference.setEnabled(false);

    expect(preference.isEnabled()).toBe(false);
    expect(window.localStorage.getItem(ENABLED_STORAGE_KEY)).toBe("false");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(createPreference(window).isEnabled()).toBe(false);
  });

  it("does not notify when the value does not change", () => {
    const preference = createPreference(window);
    const listener = vi.fn();
    preference.subscribe(listener);

    preference.setEnabled(true);

    expect(listener).not.toHaveBeenCalled();
  });

  it("toggles and returns the new value", () => {
    const preference = createPreference(window);

    expect(preference.toggle()).toBe(false);
    expect(preference.isEnabled()).toBe(false);
    expect(preference.toggle()).toBe(true);
    expect(preference.isEnabled()).toBe(true);
  });

  it("follows changes made in another window", () => {
    const preference = createPreference(window);
    const listener = vi.fn();
    preference.subscribe(listener);

    changeFromAnotherWindow("false");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(preference.isEnabled()).toBe(false);
  });

  it("stops notifying after unsubscribe", () => {
    const preference = createPreference(window);
    const listener = vi.fn();
    const unsubscribe = preference.subscribe(listener);

    unsubscribe();
    preference.setEnabled(false);
    changeFromAnotherWindow("true");

    expect(listener).not.toHaveBeenCalled();
  });
});
