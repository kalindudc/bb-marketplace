// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Agent instructions, briefs and journal reminders never receive levels; only the user-facing registry, tale and Insights RPCs do.
const root = process.cwd();
const sources = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? sources(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : []);
const backEnd = [...sources("src/server"), ...sources("src/shared")].map(f => ({ file: f, text: readFileSync(join(root, f), "utf8") }));

describe("levels stay out of what agents see", () => {
  it("no server or shared file imports the UI, the level rule included", () => {
    const imports = backEnd.filter(({ text }) => /from\s+["'][^"']*\/ui\//.test(text) || /import\(\s*["'][^"']*\/ui\//.test(text)).map(s => s.file);
    expect(imports).toEqual([]);
  });

  it("only the registry and approved Insights view read the character records", () => {
    const factory = readFileSync(join(root, "server.ts"), "utf8");
    const reads = [...backEnd, { file: "server.ts", text: factory }].flatMap(({ file, text }) => [...text.matchAll(/serviceRecords\.read\(/g)].map(m => ({ file, line: text.slice(0, m.index).split("\n").length })));
    expect(reads.map(r => r.file)).toEqual(["src/server/rpc.ts", "server.ts"]);
    const insightConstructor = factory.split("\n").findIndex(line => line.includes("const insights = new InsightsReader"));
    expect(reads[1]!.line - 1).toBe(insightConstructor);
    const insightView = readFileSync(join(root, "src/server/insights/index.ts"), "utf8");
    expect(insightView.match(/this\.readCharacters\?\.\(/g)).toHaveLength(1);
    expect(insightView.indexOf("this.readCharacters?.()")).toBeGreaterThan(insightView.indexOf("async view("));
    const rpc = readFileSync(join(root, "src/server/rpc.ts"), "utf8").split("\n");
    // The read sits inside the `registry:` handler, a few lines below it.
    const handler = rpc.findIndex(l => /^\s*registry:\s*async/.test(l));
    expect(handler).toBeGreaterThanOrEqual(0);
    expect(reads[0]!.line - 1 - handler).toBeGreaterThan(0);
    expect(reads[0]!.line - 1 - handler).toBeLessThanOrEqual(3);
  });

  it("names every server file that touches the records, so a new one is reviewed", () => {
    const touching = backEnd.filter(({ text }) => /serviceRecords|shared\/service-record|\.\/service-record/.test(text)).map(s => relative(root, join(root, s.file))).sort();
    expect(touching).toEqual([
      "src/server/backup/records.ts", // backs the rows up and restores them
      "src/server/insights/aggregate.ts", // uses role-specific recorded counts only in the user-facing Insights view
      "src/server/keeper/store.ts", // the table's type
      "src/server/rpc.ts", // the registry handler
      "src/server/runtime.ts", // records a quest when it ends, drops thread links, backfills
      "src/server/service-record.ts", // the record itself
      "src/server/tale.ts", // projects frozen levels only into the user-facing boardQuest RPC
      "src/shared/contract.ts", // the registry RPC's schema
      "src/shared/level.ts", // shared role-to-count rule for user-facing levels and terminal snapshots
    ]);
  });
});
