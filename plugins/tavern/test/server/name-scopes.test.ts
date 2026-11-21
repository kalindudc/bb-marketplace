// @vitest-environment node
import { expect, it } from "vitest";
import { patchThreadFixture, putMemberFixture } from "./member-fixture";
import { setup } from "./runtime-fixture";

function party() {
  const { k, runtime } = setup();
  const classId = "ranger";
  const characterId = runtime.snapshot().classes.find(c => c.id === classId)!.characters[0]!;
  const name = runtime.snapshot().characters.find(c => c.id === characterId)!.name;
  const input = { classId, characterId, errand: true as const, title: "Read", brief: { outcome: "Read", mode: "make-it-work" as const, outOfScope: "Writes", doneWhen: "Report", context: [], questions: ["What changed?"], timeboxMinutes: 5 } };
  return { k, runtime, input, name, hire: (keeper: string) => runtime.hire(keeper, "project", input) };
}

it("lets different Keepers hire the same Ranger, qualifying and ordering the names in the composer", async () => {
  const { k, runtime, hire, name } = party();
  k.bind("other", "keeper", "moss", "project");
  const moss = await hire("other");
  const wren = await hire("lead");
  expect([moss.displayName, wren.displayName]).toEqual([name, name]);
  expect(runtime.mentionNames(name, "lead")).toEqual([
    expect.objectContaining({ id: wren.threadId, title: name, subtitle: "Wren's Ranger · Read" }),
    expect.objectContaining({ id: moss.threadId, title: name, subtitle: "Moss's Ranger · Read" }),
  ]);
});

it("holds resting names and reuses released ones without shortening existing names", async () => {
  const { k, runtime, hire, name } = party();
  k.bind("other", "keeper", "moss", "project");
  const first = await hire("lead");
  putMemberFixture(k.store, first.threadId, { state: "done" });
  const second = await hire("lead");
  expect(second.displayName).toBe(`${name} II`);
  patchThreadFixture(k.store, first.threadId, { released: { reason: "done", decisionId: "d" } });
  const other = await hire("other");
  expect(other.displayName).toBe(name);
  await runtime.reconcileNames();
  expect(k.member(second.threadId)?.displayName).toBe(`${name} II`);
  expect(k.member(first.threadId)?.displayName).toBe(name);
  expect((await hire("lead")).displayName).toBe(name);
});

it("reserves different names for overlapping hires from the same Keeper", async () => {
  const { hire, name } = party();
  const members = await Promise.all([hire("lead"), hire("lead")]);
  expect(members.map(m => m.displayName)).toEqual([name, `${name} II`]);
});
