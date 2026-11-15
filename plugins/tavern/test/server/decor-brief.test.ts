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
it("sends a brief whose follow-ups outgrew the hire-time limits, so the widget still loads", async () => {
  const f = setup(); databases.push(f.k.store.db); registerRpc(f.bb, f.runtime);
  const hired = briefSchema.parse({ outcome: "Check the report", mode: "make-it-work", doneWhen: "Verdict written", context: ["Read the report first"] });
  const followUps = Array.from({ length: 240 }, (_, i) => `Follow-up v${i + 2}: ${"x".repeat(i === 239 ? 8000 : 600)}`);
  f.k.store.patch("lead", { brief: { ...hired, context: [...hired.context, ...followUps] } });
  const decor = threadDecorSchema.parse(await f.harness.invokeRpc("decor", { threadId: "lead" }));
  const context = "briefFields" in decor ? decor.briefFields?.context ?? [] : [];
  expect(context).toHaveLength(200);
  expect(context.at(-1)).toBe(followUps.at(-1));
  expect(context[0]).toBe("Read the report first");
  expect(context[1]).toBe(followUps[41]);
});
