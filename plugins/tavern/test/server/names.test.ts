// @vitest-environment node
import { patchThreadFixture } from "./member-fixture";
import { describe, expect, it } from "vitest";
import { setup } from "./runtime-fixture";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights";
import { makeThreadResponse, makeMessageDispatchHookContext } from "./host";

describe("live Tavern names", () => {
  it("waits for a real Keeper title, prefixes once, and preserves later renames", async () => {
    const f = setup();
    await f.runtime.syncKeeperTitle(makeThreadResponse({ id: "lead", title: null, titleFallback: "Fallback" }));
    expect(f.harness.inspection.sdk.callsTo("threads.update")).toHaveLength(0);
    await f.runtime.syncKeeperTitle(makeThreadResponse({ id: "lead", title: "Read the tree" }));
    expect(f.harness.inspection.sdk.callsTo("threads.update")[0]!.args[0]).toEqual({ threadId: "lead", title: "Wren · Read the tree" });
    await f.runtime.syncKeeperTitle(makeThreadResponse({ id: "lead", title: "My renamed task" }));
    expect(f.harness.inspection.sdk.callsTo("threads.update")).toHaveLength(1);
    expect(f.k.store.runtime("lead").keeperTitleRetired).toBe(true);
  });
  it("resolves party display names case-insensitively and still accepts ids", () => {
    const { k } = setup();
    const bind = (id: string, keeperThreadId: string) => k.bind(id, "ranger", "juno", "project", { keeperThreadId, boardQuestId: null, waypointId: null, errand: true, title: "Read", displayName: "Juno II", brief: { outcome: "Read", mode: "make-it-work", outOfScope: "Writes", doneWhen: "Report", context: [], questions: [], timeboxMinutes: 5 } });
    bind("helper", "lead"); bind("outsider", "other");
    expect(k.resolvePartyMember("lead", "juno ii").threadId).toBe("helper");
    expect(k.resolvePartyMember("lead", "helper").threadId).toBe("helper");
    expect(() => k.resolvePartyMember("lead", "outsider")).toThrow(/Juno II/);
    bind("duplicate", "lead");
    expect(() => k.resolvePartyMember("lead", "Juno II")).toThrow(/ambiguous/i);
  });
  it.each(["helper", "juno ii"])("tells a party member using %s", async reference => {
    const f = setup();
    f.k.bind("helper", "ranger", "juno", "project", { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Read", displayName: "Juno II", brief: { outcome: "Read", mode: "make-it-work", outOfScope: "Writes", doneWhen: "Report", context: [], questions: [], timeboxMinutes: 5 } });
    f.runtime.spawnBriefDelivered("helper");
    expect((await f.runtime.tell("lead", reference, "Read again")).memberName).toBe("Juno II");
    expect(f.harness.inspection.sdk.callsTo("threads.send")[0]!.args[0]).toMatchObject({ threadId: "helper" });
  });
  it("ignores a stale event carrying the title Tavern replaced", async () => {
    const f = setup();
    const thread = makeThreadResponse({ id: "lead", title: "Read" });
    await f.runtime.syncKeeperTitle(thread);
    await f.runtime.syncKeeperTitle(thread);
    expect(f.k.store.runtime("lead").keeperTitleRetired).not.toBe(true);
  });
  it("continues reconciling names when an unrelated member title cannot be read", async () => {
    const f = setup();
    f.k.bind("other", "keeper", "wren", "project");
    f.k.bind("third", "keeper", "wren", "project");
    f.bb.sdk.threads.get = async () => { throw new Error("Thread no longer exists"); };
    await expect(f.runtime.reconcileNames()).resolves.toBeUndefined();
    expect(f.k.member("other")!.displayName).toBe("Wren II");
    expect(f.k.member("third")!.displayName).toBe("Wren III");
  });
  it("does not let an unrelated title lookup failure block a composer message", async () => {
    const f = setup();
    f.k.bind("other", "keeper", "wren", "project");
    const get = f.bb.sdk.threads.get;
    f.bb.sdk.threads.get = async input => {
      if (input.threadId === "other") throw new Error("Unrelated thread is gone");
      return get(input);
    };
    const settings = new SettingsStore(f.k.store.db, f.time);
    f.runtime.enableSettings(settings, new InsightsReader(f.k.store.db, settings, f.time));
    settings.update({ revision: 0, patch: { tavern: { defaultClass: "keeper" } }, why: "Default Keeper for admission test" });
    const ctx = makeMessageDispatchHookContext({ thread: { id: "new", status: "pending" } });
    ctx.requestedExecution = { providerId: "pi", model: "small", reasoningLevel: "low", permissionMode: "full", serviceTier: null };
    ctx.executionSources.model = "explicit";
    await expect(f.runtime.dispatch(ctx)).resolves.toEqual({ action: "proceed" });
    expect(f.k.member("new")?.role).toBe("keeper");
  });
  it.each(["startup", "hire"] as const)("does not let an unrelated title failure block %s", async action => {
    const f = setup();
    f.k.bind("other", "keeper", "wren", "project");
    const get = f.bb.sdk.threads.get;
    f.bb.sdk.threads.get = async input => {
      if (input.threadId === "other") throw new Error("Unrelated thread is gone");
      return get(input);
    };
    if (action === "startup") await expect(f.runtime.reconcile()).resolves.toBeUndefined();
    else await expect(f.runtime.hire("lead", "project", { classId: "ranger", errand: true, title: "Read", brief: { outcome: "Read", mode: "make-it-work", outOfScope: "Writes", doneWhen: "Report", context: [], questions: ["What changed?"], timeboxMinutes: 5 } })).resolves.toMatchObject({ role: "member" });
  });
  it("continues name reconciliation after a title update fails", async () => {
    const f = setup();
    f.k.bind("other", "keeper", "wren", "project");
    f.k.store.patch("other", { keeperTitleSet: "Wren · Read" });
    f.bb.sdk.threads.get = async ({ threadId }) => makeThreadResponse({ id: threadId, title: "Wren · Read" });
    f.bb.sdk.threads.update = async () => { throw new Error("Update unavailable"); };
    await expect(f.runtime.reconcileNames()).resolves.toBeUndefined();
    expect(f.k.member("other")!.displayName).toBe("Wren II");
  });
  it("gives the oldest duplicate the bare name and updates only owned Keeper titles", async () => {
    const f = setup();
    f.k.bind("older", "keeper", "wren", "project");
    f.k.store.put("members", "lead", { ...f.k.member("lead")!, createdAt: 20, displayName: "Wren" });
    f.k.store.put("members", "older", { ...f.k.member("older")!, createdAt: 10, displayName: "Wren" });
    f.k.store.patch("lead", { keeperTitleSet: "Wren · Read" });
    f.bb.sdk.threads.get = async ({ threadId }) => makeThreadResponse({ id: threadId, title: "Wren · Read" });
    await f.runtime.reconcileNames();
    expect(f.k.member("older")!.displayName).toBe("Wren");
    expect(f.k.member("lead")!.displayName).toBe("Wren II");
    expect(f.harness.inspection.sdk.callsTo("threads.update")[0]!.args[0]).toEqual({ threadId: "lead", title: "Wren II · Read" });
    expect(f.k.store.runtime("lead").keeperTitleSet).toBe("Wren II · Read");
  });
  it.each([false, true])("updates renamed member titles only while still owned (manual rename: %s)", async manual => {
    const f = setup();
    const characterId = f.runtime.snapshot().classes.find(c => c.id === "ranger")!.characters[0]!;
    const name = f.runtime.snapshot().characters.find(c => c.id === characterId)!.name;
    const member = await f.runtime.hire("lead", "project", { classId: "ranger", characterId, errand: true, title: "Read", brief: { outcome: "Read", mode: "make-it-work", outOfScope: "Writes", doneWhen: "Report", context: [], questions: ["What changed?"], timeboxMinutes: 5 } });
    f.k.bind("older", "ranger", characterId, "elsewhere", { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Read", brief: { outcome: "Read", mode: "make-it-work", outOfScope: "Writes", doneWhen: "Report", context: [], questions: [], timeboxMinutes: 5 } });
    f.k.store.put("members", "older", { ...f.k.member("older")!, createdAt: 0, displayName: name });
    f.bb.sdk.threads.get = async ({ threadId }) => makeThreadResponse({ id: threadId, title: manual ? "My title" : `${name} · Read` });
    await f.runtime.reconcileNames();
    expect(f.k.member(member.threadId)!.displayName).toBe(`${name} II`);
    const updates = f.harness.inspection.sdk.callsTo("threads.update");
    if (manual) expect(updates).toHaveLength(0);
    else expect(updates[0]!.args[0]).toEqual({ threadId: member.threadId, title: `${name} II · Read` });
  });
  it("replaces a previous character prefix instead of stacking a second prefix", async () => {
    const f = setup();
    f.k.store.put("members", "lead", { ...f.k.member("lead")!, displayName: "Wren II" });
    await f.runtime.syncKeeperTitle(makeThreadResponse({ id: "lead", title: "Wren · Read" }));
    expect(f.harness.inspection.sdk.callsTo("threads.update")[0]!.args[0]).toEqual({ threadId: "lead", title: "Wren II · Read" });
  });
  it("keeps the name list available when a quest is missing", () => {
    const { k, runtime } = setup();
    k.store.put("members", "lead", { ...k.member("lead")!, boardQuestId: "missing" });
    expect(runtime.mentionNames("")).toHaveLength(1);
  });
  it("repairs duplicate live identities without changing their character", async () => {
    const { k, runtime } = setup();
    k.bind("other", "keeper", "wren", "elsewhere");
    await runtime.reconcileNames();
    expect(k.member("lead")?.displayName).toBe("Wren");
    expect(k.member("other")?.displayName).toBe("Wren II");
    expect(k.member("other")?.characterId).toBe("wren");
  });
  it("chooses the least-used class character after all characters are occupied", () => {
    const { k, runtime } = setup();
    const pool = runtime.snapshot().classes.find(c => c.id === "keeper")!.characters;
    pool.forEach((id, i) => k.bind(`keeper-${i}`, "keeper", id, "elsewhere"));
    const selected = (runtime as unknown as { pickCharacter(classId: string, projectId: string, busy: (string | null)[]): { id: string } }).pickCharacter("keeper", "project", runtime.busyCharacters({ role: "keeper", keeperThreadId: null }));
    expect(selected.id).not.toBe("wren");
  });
  it("counts Keeper characters across projects and excludes archived threads", () => {
    const { k, runtime } = setup();
    k.bind("other", "keeper", "moss", "elsewhere");
    k.bind("gone", "keeper", "ada", "elsewhere");
    patchThreadFixture(k.store, "gone", { archivedAt: 10 });
    k.bind("released", "ranger", "juno", "elsewhere");
    patchThreadFixture(k.store, "released", { released: { reason: "done", decisionId: "d" } });
    expect(runtime.busyCharacters({ role: "keeper", keeperThreadId: null })).toEqual(["wren", "moss"]);
  });
  it("mentions live names with their class and quest, without raw identifiers in text", () => {
    const { k, runtime } = setup();
    k.store.put("members", "lead", { ...k.member("lead")!, displayName: "Wren II", title: "Read the tree" });
    expect(runtime.mentionNames("wren")).toEqual([{ id: "lead", title: "Wren II", subtitle: "Keeper · Read the tree", icon: expect.stringContaining("tavern-crest-") }]);
    patchThreadFixture(k.store, "lead", { archivedAt: 10 });
    expect(runtime.mentionNames("")).toEqual([]);
  });
  it("rosters identify the Keeper and fellows by display name and role", () => {
    const { k, runtime } = setup();
    k.bind("helper", "ranger", "juno", "project", { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Read", displayName: "Juno II", brief: { outcome: "Read", mode: "make-it-work", outOfScope: "Writes", doneWhen: "Report", context: [], questions: [], timeboxMinutes: 5 } });
    expect(runtime.nameRoster("helper")).toContain("Wren (Keeper)");
    expect(runtime.nameRoster("lead")).toContain("Juno II (Ranger)");
    expect(runtime.nameRoster("helper")).not.toContain("lead");
  });
});
