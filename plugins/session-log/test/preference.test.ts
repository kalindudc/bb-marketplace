import { afterEach, describe, expect, it, vi } from "vitest";
import { EXPANDED_STORAGE_KEY, createPreference } from "../src/preference";

afterEach(() => { window.localStorage.clear(); });

function changeFromAnotherWindow(value: "true" | "false") {
  window.localStorage.setItem(EXPANDED_STORAGE_KEY, value);
  window.dispatchEvent(new StorageEvent("storage", { key: EXPANDED_STORAGE_KEY, newValue: value }));
}

describe("createPreference", () => {
  it("defaults to previews when nothing is stored", () => {
    expect(createPreference(window).isExpanded()).toBe(false);
  });

  it("persists expansion and notifies subscribers", () => {
    const preference = createPreference(window);
    const listener = vi.fn();
    preference.subscribe(listener);
    preference.setExpanded(true);
    expect(preference.isExpanded()).toBe(true);
    expect(window.localStorage.getItem(EXPANDED_STORAGE_KEY)).toBe("true");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(createPreference(window).isExpanded()).toBe(true);
  });

  it("does not notify when its value does not change", () => {
    const preference = createPreference(window);
    const listener = vi.fn();
    preference.subscribe(listener);
    preference.setExpanded(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("toggles and returns the new value", () => {
    const preference = createPreference(window);
    expect(preference.toggle()).toBe(true);
    expect(preference.toggle()).toBe(false);
    expect(window.localStorage.getItem(EXPANDED_STORAGE_KEY)).toBe("false");
  });

  it("follows storage changes from another window, including a clear", () => {
    const preference = createPreference(window);
    const listener = vi.fn();
    preference.subscribe(listener);
    changeFromAnotherWindow("true");
    expect(preference.isExpanded()).toBe(true);
    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(preference.isExpanded()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("stops notifying after unsubscribe", () => {
    const preference = createPreference(window);
    const listener = vi.fn();
    const unsubscribe = preference.subscribe(listener);
    unsubscribe();
    preference.setExpanded(true);
    changeFromAnotherWindow("false");
    expect(listener).not.toHaveBeenCalled();
  });
});
