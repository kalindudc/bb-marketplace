// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { deriveLinuxKey, deriveMacKey, decryptValue, encryptValue, encryptedSamples, needsKey, workingKey } from "../src/chromium";

function databaseWith(encrypted: Uint8Array, host = ".example.com"): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`create table meta (key text primary key, value text); insert into meta values ('version', '24');
    create table cookies (host_key text, top_frame_site_key text, name text, value text, encrypted_value blob, path text,
      expires_utc integer, is_secure integer, is_httponly integer, is_persistent integer, samesite integer);
    insert into cookies values ('${host}', '', 'secret', '', x'${Buffer.from(encrypted).toString("hex")}', '/', 0, 1, 1, 0, 1);`);
  return database;
}

describe("Linux Chromium keys", () => {
  it("derive the key with one PBKDF2 round, not macOS's 1003", () => {
    expect(deriveLinuxKey("peanuts")).not.toEqual(deriveMacKey("peanuts"));
  });

  it("decrypts a v10 value from the basic password store", () => {
    const key = deriveLinuxKey("peanuts");
    const encrypted = encryptValue("cookie value", key, ".example.com", 24);
    expect(decryptValue(encrypted, key, ".example.com", 24)).toBe("cookie value");
    expect(decryptValue(encrypted, deriveMacKey("peanuts"), ".example.com", 24)).toBeNull();
  });

  it("decrypts a v11 value from a keyring password with the same cipher", () => {
    const key = deriveLinuxKey("correct horse battery staple");
    const encrypted = encryptValue("cookie value", key, ".example.com", 24, "v11");
    expect(decryptValue(encrypted, key, ".example.com", 24)).toBe("cookie value");
    expect(decryptValue(encrypted, deriveLinuxKey("peanuts"), ".example.com", 24)).toBeNull();
  });

  it("needs the key for v10 and v11 values alike", () => {
    const key = deriveLinuxKey("peanuts");
    expect(needsKey(databaseWith(encryptValue("v", key, ".example.com", 24)))).toBe(true);
    expect(needsKey(databaseWith(encryptValue("v", key, ".example.com", 24, "v11")))).toBe(true);
  });

  it("samples only ciphertexts a key can open, so unsupported rows first do not hide the readable ones", () => {
    const right = deriveLinuxKey("keyring secret");
    const readable = encryptValue("v", right, ".other.test", 24);
    const portal = new Uint8Array([...Buffer.from("v12"), ...Buffer.from("portal-encrypted-value")]);
    const database = databaseWith(portal);
    database.exec(`insert into cookies values ('.other.test', '', 'second', '', x'${Buffer.from(readable).toString("hex")}', '/', 0, 1, 1, 0, 1);`);
    const samples = encryptedSamples(database);
    expect(samples).toHaveLength(1);
    expect(Buffer.from(samples[0].encrypted).equals(readable)).toBe(true);
    expect(workingKey(samples, 24, [deriveLinuxKey("peanuts"), right])).toEqual(right);
  });

  it("picks the candidate that decrypts a real sample and refuses when none does", () => {
    const right = deriveLinuxKey("keyring secret");
    const encrypted = encryptValue("v", right, ".example.com", 24);
    const samples = encryptedSamples(databaseWith(encrypted));
    expect(samples).toHaveLength(1);
    expect(samples[0].host).toBe(".example.com");
    expect(Buffer.from(samples[0].encrypted).equals(encrypted)).toBe(true);
    expect(workingKey(samples, 24, [deriveLinuxKey("peanuts"), right, deriveMacKey("peanuts")])).toEqual(right);
    expect(workingKey(samples, 24, [deriveLinuxKey("peanuts")])).toBeNull();
  });
});
