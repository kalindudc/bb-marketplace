// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { registerRpc } from "../../src/server/rpc";
import { threadDecorSchema } from "../../src/shared/contract";
import { briefSchema } from "../../src/shared/schema";
import { setup } from "./runtime-fixture";
const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
it("sends typed brief fields and retains the legacy text", async () => {
  const f = setup(); databases.push(f.k.store.db); registerRpc(f.bb, f.runtime);
  const brief = briefSchema.parse({ outcome: "Repair the parser", mode: "make-it-work", doneWhen: "Tests pass" });
  f.k.store.patch("lead", { brief });
  const decor = threadDecorSchema.parse(await f.harness.invokeRpc("decor", { threadId: "lead" }));
  expect("briefFields" in decor && decor.briefFields).toEqual(brief);
  expect(decor.brief).toBe(JSON.stringify(brief, null, 2));
});
it("sends null when no brief is stored", async () => {
  const f = setup(); databases.push(f.k.store.db); registerRpc(f.bb, f.runtime);
  const decor = threadDecorSchema.parse(await f.harness.invokeRpc("decor", { threadId: "lead" }));
  expect("briefFields" in decor && decor.briefFields).toBeNull();
});
