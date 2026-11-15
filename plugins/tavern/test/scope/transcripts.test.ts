// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { evaluate } from "../../src/scope/engine";
import { prepareCall } from "../../src/scope/prepare";
import { bindPaths, realPath, within } from "../../src/scope/paths";
import { bindWorktree } from "../../src/scope/worktree";
import { scopeForClass } from "../../src/scope/presets";
import { linkedWorktree } from "./git-fixture";

const source = JSON.parse(readFileSync(new URL("./fixtures/round2-transcripts.json", import.meta.url), "utf8"));
it("replays Billy's exact 88 Ranger, 79 Smith, 11 Keeper and 8 regression commands", () => {
  const base = realPath(mkdtempSync(join(process.env.TAVERN_TEST_FIXTURES!, "transcript-")));
  try {
    const scratch = process.platform === "darwin" ? ["/private/tmp", realPath(tmpdir())] : [realPath(tmpdir())];
    expect(scratch.some(path => within(base, path)), "The fixture must be outside every allowed scratch root").toBe(false);
    const { main, worktree, git } = linkedWorktree(base);
    git(worktree, "branch", "-m", "feature"); git(main, "remote", "add", "origin", "git@github.com:kalindudc/world.git"); git(main, "remote", "add", "upstream", "https://github.com/Shopify/world.git");
    for (const path of ["src", "packages/a"]) mkdirSync(join(worktree, path), { recursive: true });
    writeFileSync(join(worktree, "src/a.ts"), "a\n"); writeFileSync(join(worktree, "package.json"), '{"version":"1"}');
    const scopes = Object.fromEntries(["ranger", "smith", "keeper"].map(role => {
      let scope = { ...scopeForClass(role, undefined, role === "keeper" ? "keeper" : undefined), threadId: "t1", issuedAt: 1 };
      if (scope.writes.mode === "worktree") scope = bindWorktree(scope, worktree);
      return [role, bindPaths(scope, { home: homedir(), tmp: scratch, scopesDir: join(base, "scopes"), threadStorage: join(base, "storage") }, realPath)];
    }));
    const report: Record<string, unknown> = {};
    for (const group of ["ranger", "smith", "keeper", "regressions"]) {
      const rows = source[group].map((row: { command: string; expected: string; preset?: string }) => {
        const command = row.command.replaceAll("${threadStorage}", join(base, "storage"));
        const call = prepareCall({ kind: "tool", toolName: "bash", input: { command }, cwd: worktree }, {
          scope: scopes[row.preset ?? group],
          readCommand: (program, args, cwd) => {
            if (program !== "gh") return execFileSync(program, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
            // The own-draft case has verified GitHub facts; no transcript calls contact GitHub.
            if (args[0] === "pr" && args[1] === "view" && args[2] === "1") return JSON.stringify({ isDraft: true, author: { login: "tester" }, headRefName: "feature", headRepositoryOwner: { login: "kalindudc" }, headRepository: { name: "world" } });
            if (args[0] === "api" && args[1] === "user") return '{"login":"tester"}';
            throw new Error("Unexpected GitHub fact lookup: " + args.join(" "));
          },
        });
        const decision = evaluate(scopes[row.preset ?? group], call);
        return { command, expected: row.expected, actual: decision.allow ? "allow" : "block", rule: decision.allow ? undefined : decision.ruleId };
      });
      const falseBlocks = rows.filter((row: any) => row.expected === "allow" && row.actual === "block");
      const falseAllows = rows.filter((row: any) => row.expected === "block" && row.actual === "allow");
      report[group] = { total: rows.length, falseBlocks, falseAllows, trueBlocks: rows.filter((row: any) => row.expected === "block" && row.actual === "block").length };
      expect(falseBlocks, group + " false blocks").toEqual([]); expect(falseAllows, group + " false allows").toEqual([]);
    }
    if (process.env.TAVERN_TRANSCRIPT_REPORT) writeFileSync(process.env.TAVERN_TRANSCRIPT_REPORT, JSON.stringify(report, null, 2));
  } finally { rmSync(base, { recursive: true, force: true }); }
});
