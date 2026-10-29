// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deriveMacKey, encryptValue, needsKey, readChromiumCookies } from "../src/chromium";
import { readFirefoxCookies } from "../src/firefox";
import { withSnapshot } from "../src/snapshot";

const WEBKIT_OFFSET = 11_644_473_600;
const key = deriveMacKey("peanut butter");

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "better-browser-test-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function chromiumDatabase(path: string, version: number) {
  const database = new DatabaseSync(path);
  database.exec(`
    create table meta (key text primary key, value text);
    create table cookies (creation_utc integer, host_key text, top_frame_site_key text, name text, value text, encrypted_value blob,
      path text, expires_utc integer, is_secure integer, is_httponly integer, last_access_utc integer, has_expires integer,
      is_persistent integer, priority integer, samesite integer, source_scheme integer, source_port integer);
  `);
  database.prepare("insert into meta values ('version', ?)").run(String(version));
  const insert = database.prepare(`insert into cookies values (0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, 1, ?, 2, 443)`);
  return {
    add(row: { host: string; name: string; value?: string; plain?: string; partition?: string; expires?: number; persistent?: boolean; secure?: boolean; httpOnly?: boolean; sameSite?: number; useKey?: Buffer }) {
      const encrypted = row.value === undefined ? Buffer.alloc(0) : encryptValue(row.value, row.useKey ?? key, row.host, version);
      const expires = row.expires === undefined ? 0 : (BigInt(row.expires + WEBKIT_OFFSET) * 1_000_000n);
      insert.run(row.host, row.partition ?? "", row.name, row.plain ?? "", encrypted, "/", expires, row.secure === false ? 0 : 1, row.httpOnly ? 1 : 0,
        row.persistent === false ? 0 : 1, row.sameSite ?? 1);
    },
    close: () => database.close(),
  };
}

describe("Chromium cookie stores", () => {
  it("decrypts each value, checks its host binding and converts the expiry from 1601 microseconds", () => {
    const path = join(scratch, "Cookies");
    const store = chromiumDatabase(path, 24);
    store.add({ host: ".example.com", name: "sid", value: "secret", expires: 1_900_000_000, httpOnly: true });
    store.add({ host: "app.example.com", name: "session", value: "temp", persistent: false, sameSite: -1 });
    store.add({ host: "plain.example.com", name: "legacy", plain: "unencrypted" });
    store.add({ host: ".embed.com", name: "chips", value: "x", partition: "https://top.com" });
    store.add({ host: ".example.com", name: "foreign", value: "y", useKey: deriveMacKey("other") });
    store.close();
    const database = new DatabaseSync(path, { readOnly: true });
    expect(needsKey(database)).toBe(true);
    const read = readChromiumCookies(database, key);
    database.close();
    expect(read.partitioned).toBe(1);
    expect(read.undecryptable).toBe(1);
    expect(read.cookies).toEqual([
      { name: "sid", value: "secret", host: ".example.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax", expires: 1_900_000_000, priority: "Medium", sourceScheme: "Secure", sourcePort: 443 },
      { name: "session", value: "temp", host: "app.example.com", path: "/", secure: true, httpOnly: false, priority: "Medium", sourceScheme: "Secure", sourcePort: 443 },
      { name: "legacy", value: "unencrypted", host: "plain.example.com", path: "/", secure: true, httpOnly: false, sameSite: "Lax", priority: "Medium", sourceScheme: "Secure", sourcePort: 443 },
    ]);
  });

  it("reads stores from before the host binding", () => {
    const path = join(scratch, "Cookies");
    const store = chromiumDatabase(path, 23);
    store.add({ host: ".example.com", name: "sid", value: "old-format" });
    store.close();
    const database = new DatabaseSync(path, { readOnly: true });
    expect(readChromiumCookies(database, key).cookies[0]?.value).toBe("old-format");
    database.close();
  });

  it("counts every encrypted value as unreadable without a key", () => {
    const path = join(scratch, "Cookies");
    const store = chromiumDatabase(path, 24);
    store.add({ host: ".example.com", name: "sid", value: "secret" });
    store.close();
    const database = new DatabaseSync(path, { readOnly: true });
    expect(readChromiumCookies(database, null)).toMatchObject({ cookies: [], undecryptable: 1 });
    database.close();
  });
});

describe("Firefox cookie stores", () => {
  it("reads expiry in milliseconds from schema 16 and skips container cookies", () => {
    const path = join(scratch, "cookies.sqlite");
    const database = new DatabaseSync(path);
    database.exec(`create table moz_cookies (id integer primary key, originAttributes text, name text, value text, host text, path text,
      expiry integer, isSecure integer, isHttpOnly integer, sameSite integer); pragma user_version = 16;`);
    const insert = database.prepare("insert into moz_cookies (originAttributes, name, value, host, path, expiry, isSecure, isHttpOnly, sameSite) values (?, ?, ?, ?, '/', ?, 1, 1, ?)");
    insert.run("", "sid", "v", ".example.com", 1_900_000_000_123, 2);
    insert.run("^userContextId=1", "work", "w", ".example.com", 1_900_000_000_000, 0);
    expect(readFirefoxCookies(database)).toEqual([
      { name: "sid", value: "v", host: ".example.com", path: "/", secure: true, httpOnly: true, sameSite: "Strict", expires: 1_900_000_000 },
    ]);
    database.close();
  });

  it("reads seconds even when a profile reports schema 16, so an intermediate migration cannot expire cookies", () => {
    const path = join(scratch, "cookies.sqlite");
    const database = new DatabaseSync(path);
    database.exec(`create table moz_cookies (id integer primary key, originAttributes text, name text, value text, host text, path text,
      expiry integer, isSecure integer, isHttpOnly integer, sameSite integer); pragma user_version = 16;`);
    database.prepare("insert into moz_cookies (originAttributes, name, value, host, path, expiry, isSecure, isHttpOnly, sameSite) values ('', 'sid', 'v', '.example.com', '/', 1900000000, 1, 1, 0)").run();
    expect(readFirefoxCookies(database)).toEqual([{ name: "sid", value: "v", host: ".example.com", path: "/", secure: true, httpOnly: true, sameSite: "None", expires: 1_900_000_000 }]);
    database.close();
  });

  it("reads older schemas in seconds and treats Lax-by-default as unset", () => {
    const path = join(scratch, "cookies.sqlite");
    const database = new DatabaseSync(path);
    database.exec(`create table moz_cookies (id integer primary key, originAttributes text, name text, value text, host text, path text,
      expiry integer, isSecure integer, isHttpOnly integer, sameSite integer, rawSameSite integer); pragma user_version = 12;`);
    database.prepare("insert into moz_cookies (originAttributes, name, value, host, path, expiry, isSecure, isHttpOnly, sameSite, rawSameSite) values ('', 'a', 'b', 'example.com', '/', 1900000000, 0, 0, 1, 0)").run();
    expect(readFirefoxCookies(database)).toEqual([{ name: "a", value: "b", host: "example.com", path: "/", secure: false, httpOnly: false, expires: 1_900_000_000 }]);
    database.close();
  });
});

describe("withSnapshot", () => {
  it("reads a copy while another connection holds the database open and leaves nothing behind", async () => {
    const path = join(scratch, "Cookies");
    const store = chromiumDatabase(path, 24);
    store.add({ host: ".example.com", name: "sid", value: "secret" });
    const temp = join(scratch, "temp");
    rmSync(temp, { force: true, recursive: true });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(temp);
    const count = await withSnapshot(path, temp, (database, method) => {
      expect(method).toBe("vacuum");
      return (database.prepare("select count(*) as count from cookies").get() as { count: number }).count;
    });
    store.close();
    expect(count).toBe(1);
    expect(readdirSync(temp)).toEqual([]);
  });

  it("falls back to copying the files when the browser holds an exclusive lock", async () => {
    const path = join(scratch, "cookies.sqlite");
    const holder = new DatabaseSync(path);
    holder.exec("create table moz_cookies (id integer); insert into moz_cookies values (1); pragma locking_mode = exclusive; begin exclusive; insert into moz_cookies values (2);");
    const { mkdirSync } = await import("node:fs");
    const temp = join(scratch, "temp");
    mkdirSync(temp);
    const count = await withSnapshot(path, temp, (database, method) => {
      expect(method).toBe("copy");
      return (database.prepare("select count(*) as count from moz_cookies").get() as { count: number }).count;
    });
    holder.exec("rollback");
    holder.close();
    expect(count).toBe(1);
    expect(readdirSync(temp)).toEqual([]);
  }, 10_000);
});
