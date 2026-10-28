// @vitest-environment node
import { describe, expect, it } from "vitest";
import { dataDirectory, findBrowser, linuxDefaultBrowser, parseLocalState, parseProfilesIni, profileRoot } from "../src/browsers";
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
    expect(profileRoot(chrome, "/Users/me", "darwin", "Profile 2")).toBe("/Users/me/Library/Application Support/Google/Chrome/Profile 2");
    expect(profileRoot(chrome, "/Users/me", "darwin", "../../Secrets")).toBeUndefined();
    expect(profileRoot(chrome, "/Users/me", "darwin", ".")).toBeUndefined();
    expect(profileRoot(findBrowser("safari")!, "/Users/me", "darwin", "Default")).toBeUndefined();
    expect(profileRoot(chrome, "/home/me", "linux", "Profile 2")).toBe("/home/me/.config/google-chrome/Profile 2");
    expect(profileRoot(chrome, "/home/me", "linux", "../Secrets")).toBeUndefined();
    expect(dataDirectory(findBrowser("firefox")!, "/home/me", "linux")).toBe("/home/me/.mozilla/firefox");
    expect(dataDirectory(findBrowser("chrome")!, "/home/me", "linux")).toBe("/home/me/.config/google-chrome");
    expect(dataDirectory(findBrowser("safari")!, "/home/me", "linux")).toBeUndefined();
  });
});

describe("opening links", () => {
  it("relaunches a Chrome-style browser into the synced profile and opens others by bundle id", () => {
    expect(openCommand("darwin", findBrowser("chrome")!, "https://a.test/", { profile: "Profile 1" })).toEqual({
      file: "/usr/bin/open", args: ["-n", "-b", "com.google.Chrome", "--args", "--profile-directory=Profile 1", "https://a.test/"],
    });
    expect(openCommand("darwin", findBrowser("arc")!, "https://a.test/", { profile: "Default" })).toEqual({
      file: "/usr/bin/open", args: ["-b", "company.thebrowser.Browser", "https://a.test/"],
    });
    expect(openCommand("win32", findBrowser("chrome")!, "https://a.test/")).toBeNull();
  });

  it("on Linux launches the browser binary with the synced profile", () => {
    expect(openCommand("linux", findBrowser("chrome")!, "https://a.test/", { executable: "/usr/bin/google-chrome-stable", profile: "Profile 1" })).toEqual({
      file: "/usr/bin/google-chrome-stable", args: ["--profile-directory=Profile 1", "https://a.test/"],
    });
    expect(openCommand("linux", findBrowser("brave")!, "https://a.test/", { executable: "/usr/bin/brave-browser" })).toEqual({
      file: "/usr/bin/brave-browser", args: ["https://a.test/"],
    });
    expect(openCommand("linux", findBrowser("firefox")!, "https://a.test/", { executable: "/usr/bin/firefox", profile: "Profiles/abc.default-release" })).toEqual({
      file: "/usr/bin/firefox", args: ["https://a.test/"],
    });
    expect(openCommand("linux", findBrowser("chrome")!, "https://a.test/")).toEqual({ file: "xdg-open", args: ["https://a.test/"] });
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

  it("names the browser xdg-settings reports as Linux's default", () => {
    expect(linuxDefaultBrowser("google-chrome.desktop\n")).toBe("chrome");
    expect(linuxDefaultBrowser("Brave-browser.desktop")).toBe("brave");
    expect(linuxDefaultBrowser("vivaldi-stable.desktop")).toBe("vivaldi");
    expect(linuxDefaultBrowser("org.mozilla.firefox.desktop")).toBe("firefox");
    expect(linuxDefaultBrowser("org.gnome.Epiphany.desktop")).toBeNull();
    expect(linuxDefaultBrowser("\n")).toBeNull();
  });
});
