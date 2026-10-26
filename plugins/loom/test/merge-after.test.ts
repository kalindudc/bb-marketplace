import { describe, expect, it } from "vitest";
import type { TicketRow } from "../src/db/store";
import { dependsOnLines } from "../src/prompts";
import { parseSpec } from "../src/spec";
import type { TicketState } from "../src/states";
import { specToml } from "./helpers";

const spec = parseSpec(specToml((doc) => (doc.merge = { strategy: "pr" }))).spec!;

const row = (key: string, state: TicketState, over: Partial<TicketRow> = {}): TicketRow =>
  ({
    id: Number(key.split("-")[1]),
    project_id: 1,
    key,
    state,
    repo: null,
    deps_json: "[]",
    merge_after_json: "[]",
    pr_url: null,
    pr_branch: null,
    pushed_sha: null,
    stack_json: null,
    ...over,
  }) as TicketRow;

describe("dependsOnLines and merge_after", () => {
  it("asks for each open ticket the pull request merges after, with its pull request when it has one", () => {
    const proxy = row("CSV-1", "pr_open", { pr_url: "https://github.com/acme/shop/pull/7" });
    const core = row("CSV-2", "working");
    const merged = row("CSV-3", "done", { pr_url: "https://github.com/acme/shop/pull/5" });
    const client = row("CSV-4", "approved", { merge_after_json: JSON.stringify(["CSV-1", "CSV-2", "CSV-3"]) });
    expect(dependsOnLines(spec, [proxy, core, merged, client], client)).toEqual(["Merge after https://github.com/acme/shop/pull/7 (CSV-1).", "Merge after CSV-2, which has no pull request yet."]);
  });

  it("adds nothing for a ticket with no merge_after", () => {
    expect(dependsOnLines(spec, [row("CSV-1", "approved")], row("CSV-1", "approved"))).toEqual([]);
  });
});
