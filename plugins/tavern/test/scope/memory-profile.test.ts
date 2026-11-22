// @vitest-environment node
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { evaluate, registerScopes } from "../../src/scope";
import { prepareCall } from "../../src/scope/prepare";

it("refuses direct profile commands in a scoped shell and refreshes their prefixes on change", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tavern-memory-scope-")));
  const bb = { providers: { experimental_contributeEnv: vi.fn() }, events: { on: vi.fn() }, onDispose: vi.fn(), log: { warn: vi.fn() } } as unknown as BbPluginApi;
  const save = join(root, "save note"), find = join(root, "find"), curate = join(root, "curate");
  const alias = join(root, "fixture-alias");
  let memoryCommands = [save, find, curate];
  try {
    writeFileSync(save, "#!/bin/sh\nexit 0", { mode: 0o700 });
    writeFileSync(find, "#!/bin/sh\nexit 0", { mode: 0o700 });
    symlinkSync(save, alias);
    const api = registerScopes(bb, { dataDir: root, policyOptions: { home: root }, installGuard: false,
      pathsForThread: () => ({}), onViolation: vi.fn(), memoryCommandPaths: () => memoryCommands });
    const base = api.resolve("keeper", {}).scope;
    base.env.variables.PATH = root;
    const scope = await api.writeScope("keeper", base);
    const raw = (command: string) => ({ kind: "bash" as const, toolName: "bash", input: { command }, cwd: root });
    for (const command of [`"${save}"`, './"save note"', `env MODE=fixture "${find}"`, `bash "${curate}"`, `"${alias}"`, "find"])
      expect(evaluate(scope, prepareCall(raw(command), { scope })), command).toMatchObject({ allow: false, ruleId: "memory-profile-command" });
    expect(evaluate(scope, raw('"/elsewhere/save note"'))).toMatchObject({ allow: true });
    const traditionalPath = { ...scope, env: { ...scope.env, variables: { PATH: "/usr/bin:/bin" } } };
    expect(evaluate(traditionalPath, prepareCall(raw("find ."), { scope: traditionalPath }))).toMatchObject({ allow: true });
    expect(evaluate(scope, raw("bb plugin rpc call tavern memoryPrevious"))).toMatchObject({ allow: false, ruleId: "tavern-control" });
    memoryCommands = [join(root, "replacement")];
    api.refreshMemoryPolicy("keeper");
    const changed = api.status().threads[0]!.scope!;
    expect(evaluate(changed, raw(`"${save}"`))).toMatchObject({ allow: true });
    expect(evaluate(changed, raw("./replacement"))).toMatchObject({ allow: false, ruleId: "memory-profile-command" });
    memoryCommands = [];
    api.refreshMemoryPolicy("keeper");
    expect(evaluate(api.status().threads[0]!.scope!, raw("./replacement"))).toMatchObject({ allow: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
