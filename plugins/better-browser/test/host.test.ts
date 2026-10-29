// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deriveLinuxKey, encryptValue } from "../src/chromium";

/**
 * Keyring commands are intercepted so tests never touch a real Secret Service: a test stores the password a fake
 * secret-tool should answer under its exact command line, and every other keyring or desktop query fails like a
 * machine without the tool would.
 */
const secretResponses = new Map<string, string>();
vi.mock("../src/keychain", async (original) => {
  const actual = await original<typeof import("../src/keychain")>();
  return {
    ...actual,
    runCommand: (file: string, args: readonly string[]) => {
      if (file === "secret-tool" || file === "kwallet-query" || file === "xdg-settings") {
        const password = secretResponses.get([file, ...args].join(" "));
        return Promise.resolve({ code: password === undefined ? 1 : 0, stdout: password ?? "", stderr: "" });
      }
      return actual.runCommand(file, args);
    },
  };
});
import type { ExperimentalHostWatchListener, ExperimentalHostWatchOptions } from "@get-bb/plugin-sdk";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";

const savedHome = process.env.HOME;
let home: string;
const watches: { options: ExperimentalHostWatchOptions; listener: ExperimentalHostWatchListener }[] = [];
const createHarness = (entry: typeof import("../host").default, root: string) =>
  experimental_createHostEntryHarness(entry, {
    experimental_paths: { dataDir: join(root, "data"), tempDir: join(root, "temp") },
    experimental_watch: (options, listener) => {
      watches.push({ options, listener });
      return { dispose: async () => undefined };
    },
  });
let harness: ReturnType<typeof createHarness>;

function writeCookies(path: string) {
  const database = new DatabaseSync(path);
  database.exec(`create table meta (key text primary key, value text); insert into meta values ('version', '24');
    create table cookies (host_key text, top_frame_site_key text, name text, value text, encrypted_value blob, path text,
      expires_utc integer, is_secure integer, is_httponly integer, is_persistent integer, samesite integer);
    insert into cookies values ('.example.com', '', 'plain', 'v', x'', '/', 0, 1, 1, 0, 1);`);
  database.close();
}

/** A Linux fixture writes its cookie encrypted the way Chromium's basic password store does. */
function writeEncryptedCookies(path: string) {
  const database = new DatabaseSync(path);
  database.exec(`create table meta (key text primary key, value text); insert into meta values ('version', '24');
    create table cookies (host_key text, top_frame_site_key text, name text, value text, encrypted_value blob, path text,
      expires_utc integer, is_secure integer, is_httponly integer, is_persistent integer, samesite integer);
    insert into cookies values ('.example.com', '', 'secret', '', x'${
      Buffer.from(encryptValue("v", deriveLinuxKey("peanuts"), ".example.com", 24)).toString("hex")
    }', '/', 0, 1, 1, 0, 1);`);
  database.close();
}

function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  return run().finally(() => Object.defineProperty(process, "platform", original));
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "better-browser-home-"));
  const chrome = join(home, "Library", "Application Support", "Google", "Chrome");
  mkdirSync(join(chrome, "Default"), { recursive: true });
  mkdirSync(join(chrome, "Profile 1"), { recursive: true });
  writeFileSync(join(chrome, "Local State"), JSON.stringify({
    profile: { last_used: "Default", info_cache: { Default: { name: "Me", user_name: "me@example.com" }, "Profile 1": { name: "Empty" } } },
  }));
  writeCookies(join(chrome, "Default", "Cookies"));
  process.env.HOME = home;
  const plugin = mkdtempSync(join(tmpdir(), "better-browser-plugin-"));
  mkdirSync(join(plugin, "data"));
  mkdirSync(join(plugin, "temp"));
  const { default: hostEntry } = await import("../host");
  harness = createHarness(hostEntry, plugin);
});

afterAll(() => {
  process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "darwin")("the host entry", () => {
  it("lists the profiles that hold cookies", async () => {
    const { browsers } = await harness.experimental_call("browsers", {});
    expect(browsers.find((browser) => browser.id === "chrome")).toEqual({
      id: "chrome", name: "Google Chrome", engine: "chromium", installed: true, syncable: true,
      profiles: [{ directory: "Default", name: "Me", account: "me@example.com" }], lastUsedProfile: "Default",
    });
  });

  it("reads a profile while reporting whether it changed since the last sync", async () => {
    expect(await harness.experimental_call("inspect", { browserId: "chrome" })).toEqual({
      ok: true, changed: true, profile: "Default", cookies: 1, undecryptable: 0, partitioned: 0,
    });
  });

  it("watches the folder holding the cookie store and signals only cookie writes", async () => {
    expect(await harness.experimental_call("watch", { browserId: "chrome" })).toEqual({ ok: true, profile: "Default" });
    const [watch] = watches;
    expect(watch?.options.rootPath).toBe(join(home, "Library", "Application Support", "Google", "Chrome", "Default"));
    await watch!.listener({ kind: "changed", changes: [{ path: join(watch!.options.rootPath, "History"), type: "update" }] });
    expect(harness.experimental_getSignals()).toEqual([]);
    await watch!.listener({ kind: "changed", changes: [{ path: join(watch!.options.rootPath, "Cookies-journal"), type: "create" }] });
    expect(harness.experimental_getSignals()).toEqual([{ signal: "changed", payload: { browserId: "chrome", profile: "Default" } }]);
    expect(await harness.experimental_call("watch", { browserId: "chrome" })).toEqual({ ok: true, profile: "Default" });
    expect(watches).toHaveLength(1);
  });

  it("explains a missing profile or an unknown browser", async () => {
    expect(await harness.experimental_call("inspect", { browserId: "chrome", profile: "Profile 1" })).toMatchObject({ ok: false, code: "noProfile" });
    expect(await harness.experimental_call("inspect", { browserId: "netscape" })).toMatchObject({ ok: false, code: "unsupportedBrowser" });
    expect(await harness.experimental_call("inspect", { browserId: "safari" })).toMatchObject({ ok: false, code: "unsupportedBrowser" });
  });
});

describe("the host entry on Linux", () => {
  it("finds, reads and watches the same profile under ~/.config", async () => {
    await withPlatform("linux", async () => {
      const config = join(home, ".config", "google-chrome");
      mkdirSync(join(config, "Default"), { recursive: true });
      mkdirSync(join(config, "Profile 1"), { recursive: true });
      writeFileSync(join(config, "Local State"), JSON.stringify({
        profile: { last_used: "Default", info_cache: { Default: { name: "Me" }, "Profile 1": { name: "Empty" } } },
      }));
      writeEncryptedCookies(join(config, "Default", "Cookies"));

      const { browsers } = await harness.experimental_call("browsers", {});
      expect(browsers.find((browser) => browser.id === "chrome")).toEqual({
        id: "chrome", name: "Google Chrome", engine: "chromium", installed: true, syncable: true,
        profiles: [{ directory: "Default", name: "Me" }], lastUsedProfile: "Default",
      });
      expect(await harness.experimental_call("inspect", { browserId: "chrome" })).toEqual({
        ok: true, changed: true, profile: "Default", cookies: 1, undecryptable: 0, partitioned: 0,
      });
      expect(await harness.experimental_call("watch", { browserId: "chrome" })).toEqual({ ok: true, profile: "Default" });
      const watch = watches[watches.length - 1];
      expect(watch?.options.rootPath).toBe(join(config, "Default"));
      const signalsBefore = harness.experimental_getSignals().length;
      await watch!.listener({ kind: "changed", changes: [{ path: join(watch!.options.rootPath, "Cookies-journal"), type: "create" }] });
      expect(harness.experimental_getSignals().slice(signalsBefore)).toEqual([{ signal: "changed", payload: { browserId: "chrome", profile: "Default" } }]);
    });
  });

  it("decrypts a keyring-encrypted cookie by proving the key against real ciphertext", async () => {
    await withPlatform("linux", async () => {
      // Brave, not the chrome fixture above: the host caches each browser's keyring answers per worker.
      const config = join(home, ".config", "BraveSoftware", "Brave-Browser");
      mkdirSync(join(config, "Default"), { recursive: true });
      writeFileSync(join(config, "Local State"), JSON.stringify({ profile: { last_used: "Default", info_cache: { Default: { name: "Me" } } } }));
      const key = deriveLinuxKey("correct horse battery staple");
      const database = new DatabaseSync(join(config, "Default", "Cookies"));
      database.exec(`create table meta (key text primary key, value text); insert into meta values ('version', '24');
        create table cookies (host_key text, top_frame_site_key text, name text, value text, encrypted_value blob, path text,
          expires_utc integer, is_secure integer, is_httponly integer, is_persistent integer, samesite integer);
        insert into cookies values ('.example.com', '', 'secret', '', x'${
          Buffer.from(encryptValue("v", key, ".example.com", 24, "v11")).toString("hex")
        }', '/', 0, 1, 1, 0, 1);`);
      database.close();

      secretResponses.set("secret-tool lookup application brave xdg:schema chrome_libsecret_os_crypt_password_v2", "correct horse battery staple");
      try {
        expect(await harness.experimental_call("inspect", { browserId: "brave" })).toEqual({
          ok: true, changed: true, profile: "Default", cookies: 1, undecryptable: 0, partitioned: 0,
        });
      } finally {
        secretResponses.clear();
      }
    });
  });
});
