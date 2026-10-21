import { beforeEach, describe, expect, it } from "vitest";
import { badgeOf, registerBadge, type Badge } from "../src/badge";
import { SpawnRefusedError } from "../src/ports";
import { FakePort, makeEngine, makeHost, specToml } from "./helpers";

let host: ReturnType<typeof makeHost>;
let fake: FakePort;

beforeEach(() => {
  fake = new FakePort();
  host = makeHost({ port: fake });
  registerBadge(host.bb, { projects: host.projects, store: host.store, port: fake, now: Date.now });
});

const badge = async () => (await (await host.harness.behavior.fetchHttp("GET", "/badge")).json()) as Badge;
const propose = () => host.projects.propose({ toml: specToml(), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_env" });

describe("GET /badge", () => {
  it("is registered for bb's own app only", () => {
    expect(host.harness.inspection.registrations.httpRoutes.map(({ method, path, auth }) => ({ method, path, auth }))).toEqual([{ method: "GET", path: "/badge", auth: "local" }]);
  });

  it("counts nothing when there are no projects", async () => {
    expect(await badge()).toEqual({ count: 0, label: "Nothing needs you in Loom" });
  });

  it("counts what needs you on the home page, and a waiting Loom thread once", async () => {
    await propose();
    expect(await badge()).toEqual({ count: 1, label: "1 thing needs you in Loom" });

    host.store.addPlanning({ thread_id: "thr_plan", bb_project_id: "proj_1", title: "Plan" });
    fake.waiting.add("thr_plan");
    expect(await badge()).toEqual({ count: 2, label: "2 things need you in Loom" });
    expect(fake.callsTo("waitingOnUser").at(-1)).toEqual([["thr_plan"]]);
  });
});

describe("badgeOf", () => {
  it("counts a revised draft once, a refused ticket and a pending version, and drops the ticket that approving requeues", async () => {
    const h = makeEngine();
    const count = async () => (await badgeOf({ store: h.store, projects: h.projects, bb: h.bb, now: h.clock.now() })).count;
    const propose = (goal: string) => h.projects.propose({ toml: specToml((doc) => void (doc.project.goal = goal)), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_1" });
    await propose("Export the orders as a CSV file, first draft.");
    await propose("Export the orders as a CSV file, second draft.");
    expect(h.projects.spec("csv").version).toBe(2);
    expect(await count()).toBe(1);

    await h.engine.approve("csv", "human");
    await h.engine.start("csv", "human");
    h.bb.spawnError = (args) => (args.metadata.ticket === "CSV-1" ? new SpawnRefusedError(400, "HTTP 400: Provider pi only supports full permission mode.") : null);
    await h.engine.tick();
    h.bb.spawnError = null;
    expect(h.store.ticketByKey("CSV-1")!.state).toBe("blocked");
    expect(await count()).toBe(1);

    await propose("Export the orders as a CSV file, with the fixed spec.");
    expect(await count()).toBe(2);
    expect(await h.engine.approve("csv", "human", 3)).toMatchObject({ requeued: ["CSV-1"] });
    expect(await count()).toBe(0);
  });
});
