// @vitest-environment node
import { seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { planInput } from "./support";
import { makePluginAgentConfigurationContext } from "./host";
import { registerRpc } from "../../src/server/rpc";
import { tags } from "../../src/shared/contract";
import { readStatus, statusInput } from "../../src/server/status";

const sends = (f: ReturnType<typeof setup>) =>
  f.harness.inspection.sdk
    .callsTo("threads.send")
    .map((c) => (c.args[0] as { input: { text: string }[] }).input[0]!.text);
const approve = (f: ReturnType<typeof setup>) => {
  for (const ask of f.k.store
    .openAsks("lead")
    .filter((a) => a.kind === "greenlight"))
    f.k.answerAsk(ask.id, "approve", null, "page");
};
async function gateFixture(blocked = false) {
  const f = setup();
  const q = await seedQuest(f.k,"lead", "Gate", "Gate");
  const base = planInput(q.id).waypoints[0]!;
  const waypoints = [
    ...(blocked ? [{ ...base, optional: true }] : []),
    {
      ...base,
      id: "w2",
      title: "Luc approves",
      actor: "outside" as const,
      owner: "Luc",
      leadTime: "2 days",
      dependsOn: blocked ? ["w1"] : [],
    },
  ];
  f.k.plan("lead", { ...planInput(q.id), waypoints });
  approve(f);
  f.k.store.patch("lead", { cursor: f.k.store.events("lead").at(-1)!.id });
  return { ...f, q, waypoints };
}
describe("Memory re-check regressions", () => {
  it.each([true, false])(
    "N-1 does not wake for eight hours on a gate alone (blocked=%s), except one ready reminder",
    async (blocked) => {
      const f = await gateFixture(blocked);
      for (let i = 0; i < 480; i++) {
        f.advance(61_000);
        await f.runtime.tick("lead");
      }
      expect(sends(f)).toHaveLength(blocked ? 0 : 1);
      if (blocked) {
        f.k.store.put("skips", `${f.q.id}:1:w1`, {
          boardQuestId: f.q.id,
          version: 1,
          waypointId: "w1",
        });
        await f.runtime.tick("lead");
        f.advance(61_000);
        await f.runtime.tick("lead");
        expect(sends(f)).toHaveLength(1);
      }
    },
  );
  it("N-1 a ten-minute refresh changes the next real tick, not its wake schedule", async () => {
    const f = setup();
    await seedQuest(f.k, "lead", "Awaiting the user", "Wait");
    f.k.store.patch("lead", { userAt: null });
    f.k.reanchor("lead", "initial");
    await f.runtime.tick("lead");
    f.advance(8 * 3600_000);
    await f.runtime.tick("lead");
    expect(sends(f)).toHaveLength(1);
    f.k.store.event(f.time(), "lead", null, "member.failed", "New fact");
    await f.runtime.tick("lead");
    expect(sends(f)).toHaveLength(2);
    expect(sends(f).at(-1)).toContain("Ledger as of");
  });
  it("N-3 tells the Keeper to use a newer configure version instead of the older tick", async () => {
    const f = setup();
    await seedQuest(f.k, "lead", "A", "A");
    f.k.store.patch("lead", { userAt: null });
    f.k.reanchor("lead", "initial");
    await f.runtime.tick("lead");
    const tickVersion = Number(/version (\d+)/.exec(sends(f)[0]!)![1]);
    f.k.memory.note("lead", {
      kind: "commitment",
      text: "New promise",
      condition: "When the user replies",
    });
    const config = f.runtime.configure(
      makePluginAgentConfigurationContext({ thread: { id: "lead" } }),
    ).instructions!;
    expect(Number(/version (\d+)/.exec(config)![1])).toBeGreaterThan(
      tickVersion,
    );
    expect(config).toContain("highest ledger version wins");
    expect(config).not.toContain("newest tick's restatement wins");
  });
  it("N-2 resumes quiet on a greenlight answer and exposes a manual Resume RPC", async () => {
    const f = setup();
    const q = await seedQuest(f.k,"lead", "A", "A");
    f.k.plan("lead", planInput(q.id));
    f.k.store.patch("lead", { manualStopAt: f.time() });
    approve(f);
    expect(f.k.store.runtime("lead").manualStopAt).toBeNull();
    expect(f.bb.rpc.experimental_invalidate).toHaveBeenCalledWith(
      expect.arrayContaining([tags.thread("lead")]),
    );
    f.advance(61_000);
    await f.runtime.tick("lead");
    expect(sends(f)).toHaveLength(1);
    registerRpc(f.bb, f.runtime);
    f.k.store.patch("lead", { manualStopAt: f.time() });
    expect(
      await f.harness.invokeRpc("ledger", { threadId: "lead" }),
    ).toMatchObject({ quietSince: f.time() });
    const invalidations = vi.mocked(f.bb.rpc.experimental_invalidate).mock.calls
      .length;
    await f.harness.invokeRpc("resumeKeeper", { threadId: "lead" });
    expect(f.k.store.runtime("lead").manualStopAt).toBeNull();
    expect(
      vi
        .mocked(f.bb.rpc.experimental_invalidate)
        .mock.calls.slice(invalidations),
    ).toEqual(
      expect.arrayContaining([[expect.arrayContaining([tags.thread("lead")])]]),
    );
    expect(
      await f.harness.invokeRpc("ledger", { threadId: "lead" }),
    ).toMatchObject({ quietSince: null });
    expect(
      await f.harness.invokeRpc("decor", { threadId: "lead" }),
    ).toMatchObject({ keeperView: { quietSince: null } });
  });
  it.each(["owner", "title", "doneWhen"])(
    "N-4 preserves contact across re-plans but invalidates it when %s changes",
    async (field) => {
      const f = await gateFixture();
      f.k.memory.gate("lead", {
        boardQuestId: f.q.id,
        waypointId: "w2",
        askedWho: "Luc",
        via: "The user's message",
        answer: "Acknowledged",
      });
      f.k.plan("lead", {
        ...planInput(f.q.id),
        waypoints: f.waypoints,
        changeNote: "Unrelated change",
      });
      expect(f.k.summary(f.q.id).waypoints[0]!.gate?.answer).toBe(
        "Acknowledged",
      );
      f.k.plan("lead", {
        ...planInput(f.q.id),
        waypoints: f.waypoints.map((w) => ({ ...w, [field]: "Changed gate" })),
      });
      expect(f.k.summary(f.q.id).waypoints[0]!.gate).toBeNull();
    },
  );
  it("N-5 ages only unscoped promises and keeps new facts/hand-backs visible", async () => {
    const f = setup();
    for (let i = 0; i < 12; i++)
      f.k.memory.note("lead", {
        kind: "commitment",
        text: `OLD ${i} ` + "x".repeat(240),
        dueAt: f.time() + 60_000,
      });
    f.advance(3 * 86400_000);
    f.k.memory.note("lead", {
      kind: "waiting-on-user",
      text: "NEW-HANDBACK send one line",
    });
    f.k.memory.note("lead", { kind: "fact", text: "NEW-FACT Luc is online" });
    const text = f.k.restatement("lead");
    expect(text).toContain("older promises: 12");
    expect(text).toContain("NEW-HANDBACK");
    expect(text).toContain("NEW-FACT");
    expect(text).not.toContain("OLD 0");
  });
  it("keeps legacy version-keyed gate contact without editing installed rows", async () => {
    const f = await gateFixture();
    f.k.memory.gate("lead", {
      boardQuestId: f.q.id,
      waypointId: "w2",
      askedWho: "Luc",
      via: "The user's message",
    });
    const { identity, ...legacy } = f.k.store.all("gates")[0]!;
    f.k.store.db.prepare("DELETE FROM tavern_records WHERE kind='gates'").run();
    expect(f.k.store.all("gates")).toHaveLength(0);
    f.k.store.put("gates", `${f.q.id}:1:w2`, legacy);
    f.k.plan("lead", { ...planInput(f.q.id), waypoints: f.waypoints });
    expect(f.k.summary(f.q.id).waypoints[0]!.gate?.askedWho).toBe("Luc");
    expect(f.k.store.all("gates")).toHaveLength(1);
  });
  it("retains scoped promises and pages older unscoped promises from explicit history", async () => {
    const f = setup(),
      q = await seedQuest(f.k,"lead", "A", "A");
    f.k.memory.note("lead", {
      kind: "commitment",
      boardQuestId: q.id,
      text: "Scoped promise",
      dueAt: f.time() + 1,
    });
    f.k.memory.note("lead", {
      kind: "commitment",
      text: "Old conditional promise",
      condition: "When ready",
    });
    f.advance(3 * 86400_000 + 1);
    expect(f.k.memory.notes("lead").map((n) => n.text)).toEqual([
      "Scoped promise",
    ]);
    expect(f.k.memory.olderPromiseCount("lead")).toBe(1);
    expect(
      readStatus(f.runtime, "lead", statusInput.parse({ section: "notes" })),
    ).toMatchObject({ total: 2, olderPromises: 1 });
  });
  it("acknowledges only included one-shot gate reminders and delivers overflow next", async () => {
    const f = setup(),
      q = await seedQuest(f.k, "lead", "Many gates", "Gates");
    f.k.store.patch("lead", { userAt: null });
    f.k.plan("lead", {
      ...planInput(q.id),
      waypoints: Array.from({ length: 24 }, (_, i) => ({
        ...planInput(q.id).waypoints[0]!,
        id: `w${i + 1}`,
        actor: "outside",
        owner: "Luc",
        title: `Gate ${i + 1}`,
      })),
    });
    approve(f);
    await f.runtime.tick("lead");
    expect(f.k.store.all("gateReminders")).toHaveLength(20);
    f.advance(61000);
    await f.runtime.tick("lead");
    expect(f.k.store.all("gateReminders")).toHaveLength(24);
    f.advance(61000);
    await f.runtime.tick("lead");
    expect(sends(f)).toHaveLength(2);
  });
  it("expires unused review-budget decisions after one day", () => {
    const f = setup();
    f.k.decide("lead", {
      text: "Exceed once",
      why: "Thin work",
      source: "keeper",
      reversible: true,
      reviewBudgetOverride: true,
    });
    expect(f.k.memory.reviewPermit("lead", null)).toBeTruthy();
    f.advance(86400_001);
    expect(f.k.memory.reviewPermit("lead", null)).toBeNull();
  });
});
