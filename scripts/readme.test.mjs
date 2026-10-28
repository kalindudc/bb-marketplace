import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";

it("lists the root README plugins alphabetically by display name", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const table = readme.split("## Plugins\n\n")[1].split("\n\n")[0];
  const names = table.split("\n").slice(2).map((row) => /^\| \[([^\]]+)\]/u.exec(row)[1]);
  assert.ok(names.length > 0);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })));
});
