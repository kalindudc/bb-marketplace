import { beforeEach, describe, expect, it } from "vitest";
import { projectFeed } from "../src/reports";
import { makeCtx, seedProject, type EngineHarness } from "./helpers";

let h: EngineHarness;
beforeEach(() => {
  h = makeCtx();
});

const project = () => h.store.projectBySlug("csv")!;
const ids = (rows: Array<{ id: number }>) => rows.map((row) => row.id);

describe("projectFeed", () => {
  it("pages forward from --after, 200 events at a time and oldest first, so every older event can be read", async () => {
    await seedProject(h);
    for (let n = 0; n < 450; n += 1) h.store.event(project().id, null, "custom", "loom", { n });
    const all = ids(h.store.projectEvents(project().id));

    const first = projectFeed(h.store, project(), 0);
    expect(ids(first.rows)).toEqual(all.slice(0, 200));
    expect(first.lastId).toBe(all[199]);
    const second = projectFeed(h.store, project(), first.lastId);
    expect(ids(second.rows)).toEqual(all.slice(200, 400));
    const third = projectFeed(h.store, project(), second.lastId);
    expect(ids(third.rows)).toEqual(all.slice(400));
    expect(projectFeed(h.store, project(), third.lastId)).toEqual({ rows: [], lastId: third.lastId });
  });

  it("keeps the newest 200 events without --after", async () => {
    await seedProject(h);
    for (let n = 0; n < 250; n += 1) h.store.event(project().id, null, "custom", "loom", { n });
    const all = ids(h.store.projectEvents(project().id));
    expect(ids(projectFeed(h.store, project()).rows)).toEqual(all.slice(-200));
  });

  it("stops at the rewound event, with --after or without", async () => {
    await seedProject(h);
    for (let n = 0; n < 250; n += 1) h.store.event(project().id, null, "custom", "loom", { n });
    const all = ids(h.store.projectEvents(project().id));
    const at = all[100]!;
    expect(ids(projectFeed(h.store, project(), undefined, at).rows)).toEqual(all.slice(0, 101));
    expect(ids(projectFeed(h.store, project(), all[49], at).rows)).toEqual(all.slice(50, 101));
  });
});
