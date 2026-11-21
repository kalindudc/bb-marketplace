import { describe, expect, it } from "vitest";
import type { Member, Report } from "../../../src/shared/schema";
import { memberName } from "../../../src/shared/member-name";
import { durationWords, eventLines, stoppedStory, stopperOf, type StoryNames } from "../../../src/ui/page/model";
import * as scenes from "./scenes";

const vault = scenes.richDetails.vault!;
const NAMES: Record<string, string> = { "thr-juno": "Juno", "thr-vex": "Vex", "thr-pip": "Pip", "thr-rook": "Rook", "thr-wren": "the Keeper" };
const names: StoryNames = { name: (id) => NAMES[id] ?? null, headline: (r) => r.headline ?? null };
const wp = (id: string, state: string, extra: Record<string, unknown> = {}) => ({ ...vault.quest.waypoints.find((w) => w.id === id)!, state, verifiedBy: null, evidenceCount: 0, ...extra }) as (typeof vault.quest.waypoints)[number];
const report = (o: Partial<Report> & Pick<Report, "id" | "memberThreadId" | "waypointId">): Report => ({ keeperThreadId: "thr-wren", boardQuestId: "vault", status: "done", outcome: "done", evidence: [], artifacts: [], confidence: null, voice: null, createdAt: scenes.min(30), deliveredAt: null, ...o });
const stopEvent = (actor: Record<string, unknown>, data: Record<string, unknown> = {}) => ({ type: "quest.stopped", boardQuestId: "vault", actor, data }) as never;
const base = (waypoints: (typeof vault.quest.waypoints)[number][], extra: Record<string, unknown> = {}) => ({ quest: { id: "vault", waypoints }, reports: [] as Report[], asks: [], events: [stopEvent({ kind: "user" })], memberCredits: [], ...extra });

describe("stoppedStory", () => {
  it("a stop by you with no reason: nothing finished, each waypoint left in words, no reason line and no who-and-when", () => {
    const lines = stoppedStory(base([wp("w1", "doing", { ownerMember: scenes.juno }), wp("w4", "planned"), wp("w7", "planned")]), names);
    expect(lines).toEqual(["Nothing was finished.", "“Code change” was in progress.", "“Merge” was waiting on Riley.", "“DNS cut” was still yours."]);
    expect(lines.join(" ")).not.toMatch(/reason|stopped it|thr-|\bw\d\b/);
  });
  it("a stop with a recorded reason says it first", () => {
    const lines = stoppedStory(base([wp("w1", "planned")], { events: [stopEvent({ kind: "user" }, { reason: "the window closed" })] }), names);
    expect(lines[0]).toBe("The reason given: the window closed.");
  });
  it("names the stopper: you, an agent by name, or nobody when unknown", () => {
    const request = (actor: Record<string, unknown>) => ({ type: "quest.stopping", boardQuestId: "vault", actor, data: {} }) as never;
    expect(stopperOf([request({ kind: "user" })], "vault", names)).toBe("you");
    expect(stopperOf([request({ kind: "agent", threadId: "thr-wren" })], "vault", names)).toBe("the Keeper");
    expect(stopperOf([request({ kind: "agent", threadId: "thr-gone" })], "vault", names)).toBeNull();
    expect(stopperOf([request({ kind: "tavern" })], "vault", names)).toBeNull();
    expect(stopperOf([], "vault", names)).toBeNull();
  });
  it("nothing verified: what was made says so, with its evidence, and is not listed again as left", () => {
    const lines = stoppedStory(base([wp("w1", "reported", { ownerMember: scenes.juno, evidenceCount: 9 }), wp("w2", "planned")], { memberCredits: [{ memberThreadId: "thr-juno", madeWaypointIds: ["w1"], verifiedWaypointIds: [] }] }), names);
    expect(lines).toEqual(["Juno made “Code change” (9 evidence), not verified.", "“Staging test” was not started."]);
  });
  it("verified work is finished; a checker's report on what was left gives its headline", () => {
    const lines = stoppedStory(base([wp("w1", "verified", { ownerMember: scenes.juno }), wp("w2", "reported", { ownerMember: scenes.juno })], {
      memberCredits: [{ memberThreadId: "thr-juno", madeWaypointIds: ["w1", "w2"], verifiedWaypointIds: [] }, { memberThreadId: "thr-rook", madeWaypointIds: [], verifiedWaypointIds: ["w1"] }],
      reports: [report({ id: "r1", memberThreadId: "thr-rook", waypointId: "w2", headline: "the guard blocked npm test in Juno’s worktree" })],
    }), names);
    expect(lines).toEqual(["Juno made “Code change”, and Rook verified it.", "Rook’s check of “Staging test” was left: the guard blocked npm test in Juno’s worktree."]);
  });
  it("files a checker's report under the waypoint it checks for, as the live formatDuration quest records it", () => {
    const lines = stoppedStory(base([wp("w1", "reported", { ownerMember: scenes.juno, evidenceCount: 9 }), wp("w2", "planned")], {
      quest: { id: "vault", waypoints: [wp("w1", "reported", { ownerMember: scenes.juno, evidenceCount: 9 }), wp("w2", "planned")], members: [{ threadId: "thr-juno", checkerWaypointId: null }, { threadId: "thr-rook", checkerWaypointId: "w2" }] },
      memberCredits: [{ memberThreadId: "thr-juno", madeWaypointIds: ["w1"], verifiedWaypointIds: [] }],
      reports: [report({ id: "r1", memberThreadId: "thr-rook", waypointId: "w1", status: "needs-decision", headline: "the guard blocked npm test in the maker’s worktree", createdAt: scenes.min(20) })],
    }), names);
    expect(lines).toEqual(["Juno made “Code change” (9 evidence), not verified.", "Rook’s check of “Staging test” was left waiting on a decision: the guard blocked npm test in the maker’s worktree."]);
    const noHeadline = stoppedStory({ quest: { id: "vault", waypoints: [wp("w2", "planned")], members: [{ threadId: "thr-rook", checkerWaypointId: "w2" }] }, reports: [report({ id: "r2", memberThreadId: "thr-rook", waypointId: "w1", status: "blocked" })], asks: [], events: [] }, names);
    expect(noHeadline).toEqual(["Nothing was finished.", "Rook’s check of “Staging test” was left blocked."]);
  });
  it("prefers the quest's stored stop reason, and counts asks the stop's receipt names as withdrawn when it stopped", () => {
    const lines = stoppedStory(base([wp("w1", "planned")], {
      quest: { id: "vault", waypoints: [wp("w1", "planned")], stopReason: "the window closed" },
      events: [stopEvent({ kind: "user" }, { reason: null, withdrawnAskIds: ["a1", "a2"] })],
      asks: [{ boardQuestId: "vault", state: "withdrawn", withdrawnCause: "quest-stopped" }],
    }), names);
    expect(lines[0]).toBe("The reason given: the window closed.");
    expect(lines.at(-1)).toBe("2 asks withdrawn when it stopped.");
  });
  it("uses each ask's cause when there is no receipt, and leaves out asks withdrawn for another cause", () => {
    const lines = stoppedStory(base([wp("w1", "planned")], { asks: [{ boardQuestId: "vault", state: "withdrawn", withdrawnCause: "quest-stopped" }, { boardQuestId: "vault", state: "withdrawn", withdrawnCause: "plan-superseded" }] }), names);
    expect(lines.at(-1)).toBe("1 ask withdrawn when it stopped.");
  });
  it("counts withdrawn asks without claiming when they were withdrawn", () => {
    const lines = stoppedStory(base([wp("w1", "planned")], { asks: [{ boardQuestId: "vault", state: "withdrawn" }, { boardQuestId: "other", state: "withdrawn" }, { boardQuestId: "vault", state: "answered" }] }), names);
    expect(lines.at(-1)).toBe("1 ask withdrawn.");
    expect(lines.join(" ")).not.toMatch(/when it stopped/);
  });
});

describe("durationWords", () => {
  it("reads minutes, hours and days", () => {
    expect(durationWords(13 * 60_000)).toBe("13 min");
    expect(durationWords(125 * 60_000)).toBe("2 h 5 min");
    expect(durationWords(120 * 60_000)).toBe("2 h");
    expect(durationWords((24 * 60 + 4 * 60) * 60_000)).toBe("1 day 4 h");
  });
});

describe("archived member threads in a history", () => {
  const members = new Map([scenes.wren, scenes.juno, scenes.vex, scenes.pip].map((m) => [m.threadId, m]));
  const ctx = { members, characterName: (id: string) => scenes.registry.characters.find((c) => c.id === id)?.name ?? null, memberName: (m: Member) => memberName(m, scenes.registry), questShort: () => "Vault cutover", decisions: new Map<string, string>() };
  const archived = (id: number, at: number, member: string, keeperArchiveRequested = false, actor: Record<string, unknown> = { kind: "tavern" }) => ({ id, at, keeperThreadId: "thr-wren", boardQuestId: "vault", actor, type: "thread.archived", text: `${member} archived; actor unknown (not supplied by the host)`, data: { memberThreadId: member, originActor: null, keeperArchiveRequested } }) as never;
  it("credits the Keeper only when it asked for the archive, and folds its run into one line", () => {
    const lines = eventLines([archived(1, 1000, "thr-juno", true), archived(2, 1200, "thr-vex", true)], ctx);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ actor: { kind: "keeper" }, head: "archived 2 member threads: Vex and Juno", note: undefined });
  });
  it("credits you when the event says the user archived it", () => {
    expect(eventLines([archived(1, 1000, "thr-juno", false, { kind: "user" })], ctx)[0]).toMatchObject({ actor: { kind: "you" }, head: "archived Juno’s thread" });
  });
  it("keeps runs more than a minute apart, or by different actors, as separate lines", () => {
    expect(eventLines([archived(1, 0, "thr-juno"), archived(2, 61_000, "thr-vex")], ctx).map((l) => l.head)).toEqual(["Vex’s thread archived", "Juno’s thread archived"]);
    expect(eventLines([archived(1, 0, "thr-juno", true), archived(2, 1000, "thr-vex")], ctx)).toHaveLength(2);
  });
});
