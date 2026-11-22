// @vitest-environment node
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightMemory, runMemory } from "../../src/host/memory";

let root: string;
let command: string;
let blocked: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "tavern-memory-")));
  command = join(root, "notes with spaces");
  blocked = join(root, "agent");
  await mkdir(blocked);
  await writeFile(command, `#!/bin/sh
if [ "$1" = --help ]; then
  test "$#" = 1 && ! IFS= read -r unused
  exit $?
fi
cat
`, { mode: 0o700 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const signal = () => new AbortController().signal;
const preflight = () => ({ save: command, find: command, curate: command, blockedRoots: [blocked], timeoutSeconds: 5 });
const input = (op: "save" | "find", content: string) => ({ op, content, path: command, blockedRoots: [blocked], timeoutSeconds: 5 });

it("preflights three commands and sends input literally with no shell", async () => {
  expect(await preflightMemory(preflight(), signal())).toEqual({ save: command, find: command, curate: command });
  expect(await runMemory(input("find", '{"text":"$(echo bad); qs"}'), signal())).toEqual({ outcome: "ok", output: '{"text":"$(echo bad); qs"}' });
});
it("refuses blocked and retargeted paths", async () => {
  const script = join(blocked, "notes");
  await writeFile(script, "#!/bin/sh\nexit 0", { mode: 0o700 });
  const alias = join(root, "alias");
  await symlink(script, alias);
  await expect(preflightMemory({ ...preflight(), curate: alias }, signal())).rejects.toThrow("outside agent checkouts");
  expect(await runMemory({ ...input("save", "{}"), path: alias }, signal())).toMatchObject({ outcome: "failed", code: "path" });
});
it("reports failed help, timeout, malformed reference and empty search", async () => {
  await writeFile(command, "#!/bin/sh\nexit 7");
  await expect(preflightMemory(preflight(), signal())).rejects.toThrow("exit code 7");
  expect(await runMemory(input("save", "{}"), signal())).toMatchObject({ outcome: "failed", code: "exit" });
  await writeFile(command, "#!/bin/sh\nexit 0");
  expect(await runMemory(input("save", "{}"), signal())).toMatchObject({ outcome: "failed", code: "contract" });
  expect(await runMemory(input("find", "{}"), signal())).toEqual({ outcome: "ok", output: "" });
  await writeFile(command, "#!/bin/sh\nsleep 10");
  expect(await runMemory({ ...input("find", "{}"), timeoutSeconds: 1 }, signal())).toMatchObject({ outcome: "failed", code: "timeout" });
});
