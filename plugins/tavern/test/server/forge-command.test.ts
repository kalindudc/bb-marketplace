import { mkdtempSync, writeFileSync, rmSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openDraft, pushArguments } from "../../src/host/forge";
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); vi.unstubAllEnvs(); });
const input = { remote: "https://forge.example/repo", base: "main", head: "member-work", title: "A title", body: "A body\nwith lines" };
it.each([false, true])("runs the GitHub kind literally and reuses an existing draft (existing: %s)", async existing => {
  const root = mkdtempSync(join(tmpdir(), "forge-gh-")); dirs.push(root);
  const log = join(root, "calls.jsonl"), gh = join(root, "gh");
  writeFileSync(gh, `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); const body = args[1] === 'create' ? fs.readFileSync(0, 'utf8') : ''; fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({args, body, base: process.env.LOOM_BASE, title: process.env.LOOM_TITLE}) + '\\n'); if (args[1] === 'list') { if (process.env.STUB_EXISTING === '1') console.log('https://forge.example/pr/23'); } else console.log('https://forge.example/pr/23');\n`);
  chmodSync(gh, 0o700); vi.stubEnv("PATH", root + ":" + process.env.PATH); vi.stubEnv("STUB_LOG", log); vi.stubEnv("STUB_EXISTING", existing ? "1" : "0");
  const hostile = { ...input, title: '$(touch sentinel) `id` "quotes"', base: '$(touch sentinel); release', body: '$(touch sentinel)\n`id`\n"body"' };
  expect(await openDraft(root, { id: "gh", name: "GitHub", enabled: true, kind: "github" }, hostile)).toMatchObject({ ok: true, url: "https://forge.example/pr/23" });
  const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls).toHaveLength(existing ? 1 : 2);
  expect(calls[0].args).toEqual(["pr", "list", "--repo", input.remote, "--head", input.head, "--state", "open", "--json", "url", "--jq", ".[0].url // empty"]);
  if (!existing) { expect(calls[1].args).toEqual(["pr", "create", "--repo", input.remote, "--base", hostile.base, "--head", input.head, "--title", hostile.title, "--body-file", "-", "--draft"]); expect(calls[1].body).toBe(hostile.body); expect(calls[1].base).toBe(hostile.base); expect(calls[1].title).toBe(hostile.title); }
  expect(existsSync(join(root, "sentinel"))).toBe(false);
});
it("runs a stub with both variable sets and stdin, taking the last URL", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-")); dirs.push(root);
  const script = join(root, "open.sh");
  writeFileSync(script, `set -eu\n[ "$FORGE_REMOTE" = "$LOOM_REMOTE" ]\n[ "$FORGE_BASE" = "$LOOM_BASE" ]\n[ "$FORGE_HEAD" = "$LOOM_HEAD" ]\n[ "$FORGE_TITLE" = "$LOOM_TITLE" ]\n[ "$FORGE_DRAFT" = 1 ]\n[ "$LOOM_DRAFT" = 1 ]\n[ "$(cat)" = 'A body\nwith lines' ]\necho https://forge.example/old/1\necho https://forge.example/pr/23\n`);
  const profile = { id: "forge", name: "Forge", enabled: true, kind: "command" as const, open: `sh '${script}'` };
  expect(await openDraft(root, profile, input)).toMatchObject({ ok: true, url: "https://forge.example/pr/23" });
  expect(await openDraft(root, profile, input)).toMatchObject({ ok: true, url: "https://forge.example/pr/23" });
});
it.each([["echo 'HTTP 503 unavailable' >&2; exit 1", "temporary"], ["echo denied >&2; exit 2", "lasting"], ["echo missing", "broken contract"]])("classifies %s without retry", async (open, failureClass) => {
  expect(await openDraft(tmpdir(), { id: "forge", name: "Forge", enabled: true, kind: "command", open }, input)).toMatchObject({ ok: false, failureClass });
});
it.each(["open", "merged", "closed"])("reads optional state %s with both variable sets", async state => {
  const profile = { id: "forge", name: "Forge", enabled: true, kind: "command" as const, open: "echo https://forge.example/pr/23", state: `test "$FORGE_URL" = "$LOOM_URL" && test "$FORGE_PR_NUMBER" = 23 && test "$LOOM_PR_NUMBER" = 23 && test -z "$(cat)" && echo "${state} details"` };
  expect(await openDraft(tmpdir(), profile, input)).toMatchObject({ ok: true, state });
});
it("trims URL punctuation", async () => {
  expect(await openDraft(tmpdir(), { id: "forge", name: "Forge", enabled: true, kind: "command", open: "echo 'Created (https://forge.example/pr/12).'" }, input)).toMatchObject({ ok: true, url: "https://forge.example/pr/12" });
});
it("rejects an unreadable optional state", async () => {
  expect(await openDraft(tmpdir(), { id: "forge", name: "Forge", enabled: true, kind: "command", open: "echo https://forge.example/pr/23", state: "echo unknown" }, input)).toMatchObject({ ok: false, failureClass: "broken contract" });
});
it("uses a plain push first and a precise lease after its own push", () => {
  expect(pushArguments("topic", "main", "a".repeat(40), "origin", null)).toEqual(["push", "--", "origin", `${"a".repeat(40)}:refs/heads/topic`]);
  expect(pushArguments("topic", "main", "a".repeat(40), "origin", "b".repeat(40))).toContain(`--force-with-lease=refs/heads/topic:${"b".repeat(40)}`);
  expect(() => pushArguments("main", "main", "a".repeat(40), "origin", null)).toThrow();
  expect(() => pushArguments("main", "feature", "a".repeat(40), "origin", null, ["main"])).toThrow();
});
