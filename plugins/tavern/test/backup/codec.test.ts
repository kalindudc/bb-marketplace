// @vitest-environment node
import { expect, it } from "vitest";
import { sealBundle, validateBundle } from "../../src/server/backup/codec";
import { fileHash } from "../../src/server/settings/files";

function bundle() {
  return sealBundle({ format: "tavern-backup/1", tavernVersion: "test", createdAt: 0, schemaVersion: 1, migrations: [fileHash("migration")], machine: { hostname: "fixture", platform: "test", arch: "test" }, parts: ["settings"], counts: { classes: 0, characters: 0, records: null }, projects: [], problems: [] }, [{ path: "settings.toml", kind: "settings", effective: false, source: "global", projectId: null, id: null, text: "# A portable setting\n[tavern]\nvoice = \"plain\"\n" }]);
}
it("round trips the manifest and verifies UTF-8 file hashes", () => {
  const value = bundle();
  expect(validateBundle(JSON.stringify(value))).toEqual(value);
  expect(value.manifest.data).toEqual({ included: false, bytes: 0 });
  expect(value.manifest.files[0]!.bytes).toBe(Buffer.byteLength(value.files["settings.toml"]!));
});
it("rejects changed content, missing files, unlisted files and forged byte counts", () => {
  for (const mutate of [
    (v: ReturnType<typeof bundle>) => { v.files["settings.toml"] += "changed"; },
    (v: ReturnType<typeof bundle>) => { delete v.files["settings.toml"]; },
    (v: ReturnType<typeof bundle>) => { v.files["extra"] = "unlisted"; },
    (v: ReturnType<typeof bundle>) => { v.manifest.files[0]!.bytes++; },
  ]) { const value = bundle(); mutate(value); expect(() => validateBundle(value)).toThrow(); }
});
it("refuses traversal, absolute paths and undeclared project destinations", () => {
  for (const path of ["../settings.toml", "/settings.toml", "classes/../../settings.toml", "classes\\smith.md", "projects/unknown/classes/smith.md"]) {
    const value = bundle(), file = value.manifest.files[0]!;
    value.files[path] = value.files[file.path]!; delete value.files[file.path]; file.path = path;
    expect(() => validateBundle(value)).toThrow("path");
  }
});
it("checks that each file belongs to a declared bundle part", () => {
  const value = bundle(); value.manifest.parts = ["classes"];
  expect(() => validateBundle(value)).toThrow("part");
});
it("refuses a data declaration without its records file", () => {
  const value = bundle(); value.manifest.data = { included: true, bytes: 123 }; value.manifest.counts.records = 10;
  expect(() => validateBundle(value)).toThrow("data declaration");
});
