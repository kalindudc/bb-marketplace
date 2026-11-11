import { beforeEach, describe, expect, it } from "vitest";
import type { InsightsAllView } from "../src/contract";
import { registerRpc } from "../src/rpc";
import { FakePort, makeHost, specToml } from "./helpers";

let host: ReturnType<typeof makeHost>;

beforeEach(() => {
  host = makeHost({ port: new FakePort() });
  registerRpc(host.bb, { projects: host.projects, engine: host.engine, store: host.store, now: Date.now });
});

const call = <T>(method: string, input?: unknown) => host.harness.behavior.callRpc(method, input) as Promise<T>;

describe("insightsAll", () => {
  it("reads every project, or the ones named, over 4 or 12 weeks, and refuses any other window", async () => {
    await host.projects.propose({ toml: specToml(), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_env" });
    await host.projects.approve("csv", "human");
    const view = await call<InsightsAllView>("insightsAll", { weeks: 4 });
    expect(view).toMatchObject({ weeks: 4, range: null, cost: null, finished: null });
    expect(view.dayStarts).toHaveLength(28);
    expect(view.choices.map((choice) => choice.slug)).toEqual(["csv"]);
    expect(view.projects.map((row) => row.slug)).toEqual(["csv"]);
    expect((await call<InsightsAllView>("insightsAll", { weeks: 12, slugs: ["nope"] })).projects).toEqual([]);
    const ranged = await call<InsightsAllView>("insightsAll", { weeks: 4, from: view.dayStarts[20], to: view.now });
    expect(ranged.range).toEqual({ from: view.dayStarts[20], to: view.now });
    await expect(call("insightsAll", { weeks: 6 })).rejects.toThrow();
    await expect(call("insightsAll", { weeks: 4, window: "all" })).rejects.toThrow();
  });
});
