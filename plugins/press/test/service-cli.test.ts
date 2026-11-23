import type { BbPluginApi, PluginCliContext } from "@get-bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { leafPaths, registerCli } from "../src/cli";
import { emptyLedger, ledgerPath } from "../src/ledger";
import { harness, root, threadId } from "./service-fake";

type Registration = Parameters<BbPluginApi["cli"]["register"]>[0];

function cli() {
  const h = harness();
  let registration: Registration | null = null;
  const bb = { ...h.bb, cli: { register: vi.fn((value: Registration) => { registration = value; }) } } as unknown as BbPluginApi;
  registerCli(bb, h.store, h.service);
  const run = async (argv: string[]) => {
    if (registration === null) throw new Error("not registered");
    try {
      return await (registration as Registration).run(argv, { threadId } as PluginCliContext);
    } catch (error) {
      return { exitCode: 1, stdout: "", stderr: String(error), error };
    }
  };
  return { h, run };
}

describe("bb press CLI", () => {
  it("lists every leaf a policy layer sets", () => {
    expect(leafPaths({ mode: "auto", window: { softPercent: 50, extra: { deep: 1 } }, points: [] })).toEqual([
      "mode", "window.softPercent", "window.extra.deep", "points",
    ]);
    expect(leafPaths({})).toEqual([]);
  });

  it("refuses a workspace policy that only sets fields the plugin settings own", async () => {
    const { h, run } = cli();
    const result = await run(["policy", "set", '{"mode":"auto","window":{"softPercent":40}}']);
    expect(result.exitCode).not.toBe(0);
    expect(JSON.stringify(result)).toMatch(/bb plugin config press set/);
    expect(h.files.has(`${root}/.bb/press/policy.json`)).toBe(false);
  });

  it("saves a mixed workspace policy and says which fields have no effect", async () => {
    const { h, run } = cli();
    const result = await run(["policy", "set", '{"mode":"auto","providers":{"pi":{"enabled":false}}}']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/plugin settings own mode/);
    expect(JSON.parse(h.files.get(`${root}/.bb/press/policy.json`) ?? "null")).toMatchObject({ providers: { pi: { enabled: false } } });
  });

  it("still takes settings-owned fields as a per-thread override", async () => {
    const { h, run } = cli();
    const result = await run(["policy", "set", '{"mode":"observe"}', "--thread", threadId]);
    expect(result.exitCode).toBe(0);
    expect(h.store.threadPolicyOverride(threadId)).toBe('{"mode":"observe"}');
  });

  it("a per-thread override or reset from the CLI reaches the hook and the panel at once", async () => {
    const { h, run } = cli();
    h.usage.usedTokens = 850_000;
    await h.service.buildThreadStatus(threadId);
    const invalidations = h.statusInvalidations();
    expect((await run(["policy", "set", '{"mode":"observe"}', "--thread", threadId])).exitCode).toBe(0);
    expect(h.statusInvalidations()).toBeGreaterThan(invalidations);
    expect(await h.dispatch()).toEqual({ action: "proceed" });
    expect(h.compact).not.toHaveBeenCalled();
    expect((await run(["policy", "reset", "--thread", threadId])).exitCode).toBe(0);
    expect(h.store.threadPolicyOverride(threadId)).toBeNull();
    expect(await h.dispatch()).toMatchObject({ action: "wait" });
  });

  it("a workspace policy written from the CLI drops every cached policy", async () => {
    const { h, run } = cli();
    h.usage.usedTokens = 850_000;
    await h.service.buildThreadStatus(threadId);
    expect((await run(["policy", "set", '{"providers":{"pi":{"enabled":false}}}'])).exitCode).toBe(0);
    expect(h.invalidateAll).toHaveBeenCalled();
    expect(await h.dispatch()).toEqual({ action: "proceed" });
    expect((await run(["policy", "reset"])).exitCode).toBe(0);
    expect(await h.dispatch()).toMatchObject({ action: "wait" });
  });

  it("names the setting that owns a built-in point's switch or threshold", async () => {
    const { run } = cli();
    const result = await run(["policy", "set", '{"points":[{"id":"volume","when":"toolResultBytes","value":500000}]}']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/points\[volume\]\.value \(volumeBytes\)/);
  });

  it("lists duplicate composer copies in the plain status", async () => {
    const { run } = cli();
    const result = await run(["composer", "--status"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^duplicates  /m);
  });

  it("reads the thread's own ledger", async () => {
    const { h, run } = cli();
    const ledger = emptyLedger(threadId, "2026-11-22T00:00:00.000Z");
    ledger.constraints.push({ id: "c1", text: "Never push", source: "user", at: "2026-11-22T00:00:00.000Z" });
    h.files.set(ledgerPath(root, threadId), JSON.stringify(ledger));
    const result = await run(["ledger"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[c1] Never push");
    expect(result.stdout).toContain(ledgerPath(root, threadId));
    h.files.set(`${root}/.bb/press/ledger.json`, JSON.stringify(emptyLedger("thr_legacy")));
    h.files.delete(ledgerPath(root, threadId));
    expect((await run(["ledger"])).stdout).toMatch(/No ledger yet/);
  });
});
