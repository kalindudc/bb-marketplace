// @vitest-environment node
import { seedQuest } from "./support";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Registry } from "../../src/server/registry";
import { parseRegistryDefinition } from "../../src/server/registry-file";
import { classLimits } from "../../src/server/class-execution";
import { classRules } from "../../src/shared/class-rules";
import { readStatus, statusInput } from "../../src/server/status";
import { checkerAssignments } from "../../src/server/assignments";
import { resolveHireExecution } from "../../src/server/execution";
import { setup } from "./runtime-fixture";
import { planInput } from "./support";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const shipped = new URL("../../", import.meta.url).pathname;
function registry() { const home = mkdtempSync(join(tmpdir(), "tavern-class-policy-")); roots.push(home); return new Registry(shipped, home); }

describe("class character and quality policy", () => {
  it("never selects an unchecked character, even when the selected one is busy", () => {
    const r = registry(), snapshot = r.read();
    snapshot.classes.find(role => role.id === "ranger")!.characters = ["lark"];
    vi.spyOn(r, "read").mockReturnValue(snapshot);
    expect(r.character("ranger", ["lark"])!.id).toBe("lark");
    expect(() => r.character("ranger", [], null, "otto")).toThrow(/compatible|unchecked/);
  });

  it("returns explicit no-character for an empty pool and permits an unnamed hire", async () => {
    const r = registry(), snapshot = r.read();
    snapshot.classes.find(role => role.id === "ranger")!.characters = [];
    vi.spyOn(r, "read").mockReturnValue(snapshot);
    expect(r.character("ranger", [])).toBeNull();
    const f = setup();
    f.runtime.registry.read = () => snapshot;
    const member = await f.runtime.hire("lead", "project", { classId: "ranger", errand: true, title: "Scout", brief: { outcome: "Read", mode: "make-it-work", outOfScope: "Changes", doneWhen: "Answer", context: [], questions: ["What exists?"], timeboxMinutes: 5 } });
    expect(member).toMatchObject({ characterId: null, displayName: "Ranger" });
  });

  it.each(["class", "character"] as const)("reports unknown keys in %s files", kind => {
    const raw = readFileSync(join(shipped, kind === "class" ? "classes/smith.md" : "characters/bram.md"), "utf8").replace(/^---\n/, "---\nmodle: typo\n");
    expect(() => parseRegistryDefinition(kind, raw, "test")).toThrow(/modle/);
  });

  it("rejects oversized UTF-8 class bodies instead of silently cutting the role", () => {
    const r = registry();
    const revision = r.classLayers("smith").revision;
    expect(() => r.saveClass("smith", { body: "界".repeat(4001) }, { target: "global", revision })).toThrow(/12000|12,000/);
  });

  it("puts the tick-id replay rule only in the Keeper contract", () => {
    expect(classRules("keeper")).toContain("Ignore a tick id you have already seen or acted on");
    expect(classRules("member")).not.toContain("tick id");
    expect(classRules("solo")).not.toContain("tick id");
  });

  it("never widens settings limits through a project Keeper budget", () => {
    const f = setup();
    const keeper = f.runtime.snapshot().classes.find(role => role.id === "keeper")!;
    expect(classLimits({ ...keeper, source: "/repo/.agents/tavern/classes/keeper.md", budget: { members: 99, rangers: 99, rangerMinutes: 99 } }, f.runtime.config())).toEqual({ partyMax: f.runtime.config().keepers.partyMax, rangerMinutes: f.runtime.config().knobs.rangerTimeboxMaxMinutes });
  });

  it("keeps the project Keeper budget below the settings limit at hire", async () => {
    const f = setup();
    const snapshot = f.runtime.snapshot();
    vi.spyOn(f.runtime, "snapshot").mockReturnValue({ ...snapshot, classes: snapshot.classes.map(role => role.id === "keeper" ? { ...role, source: "/project/keeper.md", budget: { members: 99, rangers: 99, rangerMinutes: 99 } } : role) });
    for (let n = 0; n < f.runtime.config().keepers.partyMax; n++) f.k.bind(`busy-${n}`, "wanderer", "pip", "project", { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Busy", brief: { outcome: "Busy", mode: "make-it-work", outOfScope: "Other work", doneWhen: "Done", context: [], questions: [], timeboxMinutes: null } });
    await expect(f.runtime.hire("lead", "project", { classId: "wanderer", errand: true, title: "Extra", brief: { outcome: "Read", mode: "make-it-work", outOfScope: "Other work", doneWhen: "Answer", context: [], questions: [], timeboxMinutes: null } })).rejects.toThrow(/party budget/);
  });

  it("labels an unknown maker family as not established rather than same-family", async () => {
    const f = setup();
    expect((await resolveHireExecution(f.bb, f.runtime.snapshot().classes.find(role => role.id === "warden")!, { providerId: "pi", environmentId: null, projectId: "project", maker: { providerId: "pi", model: "opaque", environmentId: null } })).checkIndependence).toBe("not-established");
  });

  it("names an unnamed errand by class label in Keeper status", () => {
    const f = setup();
    f.k.bind("unnamed", "smith", null, "project", { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Work", brief: { outcome: "Work", mode: "make-it-work", outOfScope: "Other work", doneWhen: "Evidence", context: [], questions: [], timeboxMinutes: null } });
    expect(readStatus(f.runtime, "lead", statusInput.parse({ section: "errands" }))).toMatchObject({ inFlight: [{ owner: { name: "Smith" } }] });
  });

  it("allows several checker waypoints from one maker and refuses a mixed-maker slot", async () => {
    const f = setup();
    const q = await seedQuest(f.k,"lead", "Build", "Build");
    const brief = { outcome: "Make", mode: "make-it-work" as const, outOfScope: "Other work", doneWhen: "Done", context: [], questions: [], timeboxMinutes: null };
    for (const id of ["maker", "other"]) f.k.bind(id, "smith", "bram", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, title: "Make", errand: false, brief });
    const base = planInput(q.id);
    const input = { ...base, waypoints: [{ ...base.waypoints[0]!, owner: "maker" }, { ...base.waypoints[0]!, id: "w2", owner: "maker" }], party: [{ classId: "warden", characterId: "vex", model: null, purpose: "Check", waypointIds: ["w1", "w2"] }] };
    const plan = await f.runtime.plan("lead", input);
    const member = f.k.bind("check", "warden", "vex", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: "w1", title: "Check", errand: false, brief, reviewTarget: { boardQuestId: q.id, waypointId: "w1", makerThreadId: "maker", entryIds: ["a1"] } });
    expect(checkerAssignments(plan, f.k.store.all("members"))[0]!.waypointIds).toEqual(["w1", "w2"]);
    await expect(f.runtime.plan("lead", { ...input, waypoints: input.waypoints.map(waypoint => waypoint.id === "w2" ? { ...waypoint, owner: "other" } : waypoint) })).rejects.toThrow(/one maker|different maker|mixed maker/i);
  });
});
