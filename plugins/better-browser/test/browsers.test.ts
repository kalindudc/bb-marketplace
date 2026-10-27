// @vitest-environment node
import { describe, expect, it } from "vitest";
import { findBrowser, parseLocalState, parseProfilesIni, profileRoot } from "../src/browsers";
import { defaultHttpsHandler, openCommand } from "../src/open-url";

describe("Chromium Local State", () => {
  it("lists each profile with its name and account and names the one used last", () => {
    const text = JSON.stringify({
      profile: {
        last_used: "Profile 1",
        info_cache: {
          Default: { name: "Person 1", user_name: "me@example.com" },
          "Profile 1": { name: "Work", user_name: "" },
          "../escape": { name: "Nope" },
        },
      },
    });
    expect(parseLocalState(text)).toEqual({
      profiles: [{ directory: "Default", name: "Person 1", account: "me@example.com" }, { directory: "Profile 1", name: "Work" }],
      lastUsed: "Profile 1",
    });
  });

  it("reads nothing from a broken file", () => {
    expect(parseLocalState("{nope")).toEqual({ profiles: [] });
  });
});

describe("Firefox profiles.ini", () => {
  it("prefers the profile an install opens over the one flagged default", () => {
    const ini = [
      "[Profile1]", "Name=old", "IsRelative=1", "Path=Profiles/old.default", "Default=1",
      "[Profile0]", "Name=default-release", "IsRelative=1", "Path=Profiles/abc.default-release",
      "[Profile2]", "Name=escape", "IsRelative=1", "Path=../../etc",
      "[Install4F96D1932A9F858E]", "Default=Profiles/abc.default-release", "Locked=1",
    ].join("\n");
    expect(parseProfilesIni(ini, "/home/me/Firefox")).toEqual({
      profiles: [{ directory: "Profiles/old.default", name: "old" }, { directory: "Profiles/abc.default-release", name: "default-release" }],
      lastUsed: "Profiles/abc.default-release",
    });
  });
});

describe("profileRoot", () => {
  it("resolves a profile inside the browser's data directory and refuses one outside it", () => {
    const chrome = findBrowser("chrome")!;
    expect(profileRoot(chrome, "/Users/me", "Profile 2")).toBe("/Users/me/Library/Application Support/Google/Chrome/Profile 2");
    expect(profileRoot(chrome, "/Users/me", "../../Secrets")).toBeUndefined();
    expect(profileRoot(chrome, "/Users/me", ".")).toBeUndefined();
    expect(profileRoot(findBrowser("safari")!, "/Users/me", "Default")).toBeUndefined();
  });
});

describe("opening links", () => {
  it("relaunches a Chrome-style browser into the synced profile and opens others by bundle id", () => {
    expect(openCommand("darwin", findBrowser("chrome")!, "https://a.test/", "Profile 1")).toEqual({
      file: "/usr/bin/open", args: ["-n", "-b", "com.google.Chrome", "--args", "--profile-directory=Profile 1", "https://a.test/"],
    });
    expect(openCommand("darwin", findBrowser("arc")!, "https://a.test/", "Default")).toEqual({
      file: "/usr/bin/open", args: ["-b", "company.thebrowser.Browser", "https://a.test/"],
    });
    expect(openCommand("linux", findBrowser("chrome")!, "https://a.test/")).toEqual({ file: "xdg-open", args: ["https://a.test/"] });
    expect(openCommand("win32", findBrowser("chrome")!, "https://a.test/")).toBeNull();
  });

  it("finds the https handler in LaunchServices' list", () => {
    const json = JSON.stringify({
      LSHandlers: [
        { LSHandlerContentType: "public.html", LSHandlerRoleAll: "com.apple.safari" },
        { LSHandlerURLScheme: "https", LSHandlerRoleAll: "com.google.chrome" },
      ],
    });
    expect(defaultHttpsHandler(json)).toBe("com.google.chrome");
    expect(defaultHttpsHandler("[]")).toBeNull();
  });
});
