// @vitest-environment node
import { expect, it } from "vitest";
import { setup } from "./runtime-fixture";
import { seedQuest, planInput } from "./support";
import { rpcHandlers } from "../../src/server/rpc";

it("compares waypoint identities with the last greenlight, including same-size replacements", async () => {
  const f = setup(), q = await seedQuest(f.k, "lead", "Build", "Build");
  const input = planInput(q.id);
  const first = input.waypoints[0]!;
  const approve = () => {
    const ask = f.k.store.openAsks("lead").find(a => a.kind === "greenlight")!;
    f.k.answerAsk(ask.id, "approve", null, "page", "user");
  };
  const summary = async () => (await rpcHandlers(f.runtime).boardQuest({ id: q.id })).quest;
  f.k.plan("lead", input);
  expect((await summary()).pathChange).toBeUndefined();
  approve();
  expect((await summary()).pathChange).toBeUndefined();
  f.k.plan("lead", { ...input, waypoints: [first, { ...first, id: "w2", title: "New step" }] });
  expect((await summary()).pathChange).toEqual({ added: 1, removed: 0 });
  f.k.plan("lead", { ...input, waypoints: [{ ...first, id: "w2", title: "New step" }], party: [{ classId: "smith", characterId: null, model: null, purpose: "Build the new step", waypointIds: ["w2"] }] });
  expect((await summary()).pathChange).toEqual({ added: 1, removed: 1 });
  approve();
  expect((await summary()).pathChange).toBeUndefined();
});
