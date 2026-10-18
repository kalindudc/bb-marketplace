import { afterEach, describe, expect, it, vi } from "vitest";
import { VIEW_STORAGE_KEY, createViewPreference } from "../src/view-preference";

afterEach(() => { window.localStorage.clear(); });

function changeFromAnotherWindow(value: string) {
  window.localStorage.setItem(VIEW_STORAGE_KEY, value);
  window.dispatchEvent(new StorageEvent("storage", { key: VIEW_STORAGE_KEY, newValue: value }));
}

describe("createViewPreference", () => {
  it("opens on the worktrees view when nothing is stored", () => {
    expect(createViewPreference(window).get()).toBe("worktrees");
    expect(VIEW_STORAGE_KEY).toBe("bb-plugin-vantage:view");
  });

  it("persists the choice and notifies subscribers", () => {
    const preference = createViewPreference(window);
    const listener = vi.fn();
    preference.subscribe(listener);
    preference.set("repositories");
    expect(preference.get()).toBe("repositories");
    expect(window.localStorage.getItem(VIEW_STORAGE_KEY)).toBe("repositories");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(createViewPreference(window).get()).toBe("repositories");
  });

  it("does not notify when the view does not change", () => {
    const preference = createViewPreference(window);
    const listener = vi.fn();
    preference.subscribe(listener);
    preference.set("worktrees");
    expect(listener).not.toHaveBeenCalled();
  });

  it("reads an unknown stored value as the default", () => {
    window.localStorage.setItem(VIEW_STORAGE_KEY, "grid");
    expect(createViewPreference(window).get()).toBe("worktrees");
  });

  it("follows storage changes from another window, including a clear", () => {
    const preference = createViewPreference(window);
    const listener = vi.fn();
    preference.subscribe(listener);
    changeFromAnotherWindow("repositories");
    expect(preference.get()).toBe("repositories");
    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(preference.get()).toBe("worktrees");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("ignores storage changes to other keys and stops notifying after unsubscribe", () => {
    const preference = createViewPreference(window);
    const listener = vi.fn();
    const unsubscribe = preference.subscribe(listener);
    window.dispatchEvent(new StorageEvent("storage", { key: "something-else", newValue: "x" }));
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    preference.set("repositories");
    changeFromAnotherWindow("worktrees");
    expect(listener).not.toHaveBeenCalled();
  });
});
