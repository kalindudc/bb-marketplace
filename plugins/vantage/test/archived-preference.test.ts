import { afterEach, describe, expect, it, vi } from "vitest";
import { ARCHIVED_STORAGE_KEYS, createArchivedPreference, type ArchivedSurface } from "../src/archived-preference";

afterEach(() => { window.localStorage.clear(); });

const change = (key: string, value: string) => {
  window.localStorage.setItem(key, value);
  window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));
};

describe("createArchivedPreference", () => {
  it("hides archived threads on the page and shows them in the side tab by default", () => {
    expect(createArchivedPreference(window, "page").get()).toBe(false);
    expect(createArchivedPreference(window, "panel").get()).toBe(true);
    expect(ARCHIVED_STORAGE_KEYS).toEqual({ page: "bb-plugin-vantage:page-archived", panel: "bb-plugin-vantage:panel-archived" });
  });

  it.each<[ArchivedSurface, boolean]>([["page", true], ["panel", false]])("remembers a choice made on the %s", (surface, value) => {
    const preference = createArchivedPreference(window, surface);
    const listener = vi.fn();
    preference.subscribe(listener);
    preference.set(value);
    expect(preference.get()).toBe(value);
    expect(window.localStorage.getItem(ARCHIVED_STORAGE_KEYS[surface])).toBe(String(value));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(createArchivedPreference(window, surface).get()).toBe(value);
  });

  it("keeps the page and the side tab apart", () => {
    createArchivedPreference(window, "page").set(true);
    expect(createArchivedPreference(window, "panel").get()).toBe(true);
    createArchivedPreference(window, "panel").set(false);
    expect(createArchivedPreference(window, "page").get()).toBe(true);
    expect(createArchivedPreference(window, "panel").get()).toBe(false);
  });

  it("can go back to a surface's default after a change", () => {
    const page = createArchivedPreference(window, "page");
    page.set(true);
    page.set(false);
    expect(page.get()).toBe(false);
    expect(window.localStorage.getItem(ARCHIVED_STORAGE_KEYS.page)).toBe("false");
  });

  it("does not notify when the value does not change", () => {
    const preference = createArchivedPreference(window, "page");
    const listener = vi.fn();
    preference.subscribe(listener);
    preference.set(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("reads any stored value other than true or false as the default", () => {
    window.localStorage.setItem(ARCHIVED_STORAGE_KEYS.page, "yes");
    window.localStorage.setItem(ARCHIVED_STORAGE_KEYS.panel, "1");
    expect(createArchivedPreference(window, "page").get()).toBe(false);
    expect(createArchivedPreference(window, "panel").get()).toBe(true);
  });

  it("follows storage changes from another window to its own key, including a clear", () => {
    const preference = createArchivedPreference(window, "page");
    const listener = vi.fn();
    preference.subscribe(listener);
    change(ARCHIVED_STORAGE_KEYS.page, "true");
    expect(preference.get()).toBe(true);
    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(preference.get()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("ignores another surface's key and stops notifying after unsubscribe", () => {
    const preference = createArchivedPreference(window, "page");
    const listener = vi.fn();
    const unsubscribe = preference.subscribe(listener);
    change(ARCHIVED_STORAGE_KEYS.panel, "false");
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    preference.set(true);
    change(ARCHIVED_STORAGE_KEYS.page, "false");
    expect(listener).not.toHaveBeenCalled();
  });
});
