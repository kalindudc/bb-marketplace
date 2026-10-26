import { beforeEach, describe, expect, it } from "vitest";
import { badgeView } from "../src/badge";
import type { BadgeView } from "../src/contract";
import { SpawnRefusedError } from "../src/ports";
import { registerRpc } from "../src/rpc";
import { badgeOf } from "../src/ui/badge";
import { FakePort, makeEngine, makeHost, specToml } from "./helpers";

let host: ReturnType<typeof makeHost>;

beforeEach(() => {
  host = makeHost({ port: new FakePort() });
  registerRpc(host.bb, { projects: host.projects, engine: host.engine, store: host.store, now: Date.now });
});

const badge = () => host.harness.behavior.callRpc("badge", null) as Promise<BadgeView>;
const propose = () => host.projects.propose({ toml: specToml(), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_env" });

describe("the badge read", () => {
  it("counts nothing when there are no projects", async () => {
    expect(await badge()).toEqual({ needsYou: 0, blocked: false, threadIds: [] });
  });

  it("counts what needs you on the home page, and lists a thread that is both a live planner and a planning conversation once", async () => {
    await propose();
    expect(await badge()).toEqual({ needsYou: 1, blocked: false, threadIds: ["thr_plan"] });
    host.store.addPlanning({ thread_id: "thr_plan", bb_project_id: "proj_1", title: "Plan" });
    expect(await badge()).toEqual({ needsYou: 1, blocked: false, threadIds: ["thr_plan"] });
  });

  it("no longer serves the badge over HTTP", () => {
    expect(host.harness.inspection.registrations.httpRoutes).toEqual([]);
  });
});

describe("badgeView", () => {
  it("counts a revised draft once, a refused ticket and a pending version, says when a ticket is blocked, and drops the ticket that approving requeues", async () => {
    const h = makeEngine();
    const view = () => badgeView({ store: h.store, projects: h.projects, now: h.clock.now() });
    const propose = (goal: string) => h.projects.propose({ toml: specToml((doc) => void (doc.project.goal = goal)), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_1" });
    await propose("Export the orders as a CSV file, first draft.");
    await propose("Export the orders as a CSV file, second draft.");
    expect(h.projects.spec("csv").version).toBe(2);
    expect(view()).toMatchObject({ needsYou: 1, blocked: false });

    await h.engine.approve("csv", "human");
    await h.engine.start("csv", "human");
    h.bb.spawnError = (args) => (args.metadata.ticket === "CSV-1" ? new SpawnRefusedError(400, "HTTP 400: Provider pi only supports full permission mode.") : null);
    await h.engine.tick();
    h.bb.spawnError = null;
    expect(h.store.ticketByKey("CSV-1")!.state).toBe("blocked");
    expect(view()).toMatchObject({ needsYou: 1, blocked: true });

    await propose("Export the orders as a CSV file, with the fixed spec.");
    expect(view()).toMatchObject({ needsYou: 2, blocked: true });
    expect(await h.engine.approve("csv", "human", 3)).toMatchObject({ requeued: ["CSV-1"] });
    expect(view()).toMatchObject({ needsYou: 0, blocked: false });
  });
});

describe("badgeOf", () => {
  const view = (over: Partial<BadgeView> = {}): BadgeView => ({ needsYou: 0, blocked: false, threadIds: [], ...over });

  it("draws nothing when nothing needs you", () => {
    expect(badgeOf(view(), 0)).toBeNull();
  });

  it("adds the waiting threads to the Needs you items, in amber", () => {
    expect(badgeOf(view({ needsYou: 1 }), 0)).toEqual({ count: 1, tone: "warning", label: "1 thing needs you" });
    expect(badgeOf(view({ needsYou: 1 }), 2)).toEqual({ count: 3, tone: "warning", label: "3 things need you" });
  });

  it("turns red while a ticket is blocked", () => {
    expect(badgeOf(view({ needsYou: 2, blocked: true }), 0)).toEqual({ count: 2, tone: "critical", label: "2 things need you" });
  });
});
