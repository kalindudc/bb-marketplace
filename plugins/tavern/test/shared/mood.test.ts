import { describe, expect, it } from "vitest";
import { characterMood, roomMoodFacts, widgetMoodFacts, waypointMoodVerdict, type MoodFacts } from "../../src/shared/mood";
import type { Room } from "../../src/shared/contract";
import { fixtureAsk, fixtureBoard, fixtureDecor, fixtureJournal, fixtureMember, fixtureQuest, fixtureReport } from "../../src/ui/thread/fixtures";

const now = 1_000_000;
const failed = { activity: "failed", now } as const;
const maker = { ...fixtureMember, role: "member", threadId: "member-1", classId: "ranger", keeperThreadId: "keeper-1", waypointId: "w1", boardQuestId: "vault" } as const;
const done = { status: "done", createdAt: now - 1 } as const;
const blocked = { status: "blocked", createdAt: now - 80_000 } as const;
const verified = { status: "verified", at: now - 1 } as const;
const rejected = { status: "rejected", at: now - 80_000 } as const;

it("uses the reported and verified durations sent on the decor read", () => {
  const data = { ...fixtureDecor, member: { ...fixtureMember, state: "working" as const } };
  const report = { ...data, moodSignals: { archived:false,released:false,handBack:false, report:{...done,createdAt:now-30_000}, verdict:null } };
  const verdict = { ...data, moodSignals: { archived:false,released:false,handBack:false, report:null, verdict:{...verified,at:now-120_000} } };
  expect(characterMood({...widgetMoodFacts(report,now),openAsk:false})).toBe("reported");
  expect(characterMood({...widgetMoodFacts({...report,reportedPoseSeconds:10},now),openAsk:false})).toBe("working");
  expect(characterMood({...widgetMoodFacts(verdict,now),openAsk:false})).toBe("verified");
  expect(characterMood({...widgetMoodFacts({...verdict,verifiedPoseMinutes:1},now),openAsk:false})).toBe("working");
});

describe("character mood precedence", () => {
  it.each([
    [{ ...failed, released: true }, "released"],
    [{ ...failed, archived: true }, "released"],
    [{ ...failed, activity: "stopped" }, "released"],
    [{ ...failed, openAsk: true }, "error"],
    [{ now, activity: "working", openAsk: true, verdict: verified }, "waiting"],
    [{ now, activity: "working", handBack: true }, "waiting"],
    [{ now, activity: "waiting" }, "idle"],
    [{ now, activity: "idle", report: blocked }, "blocked"],
    [{ now, activity: "working", verdict: rejected, report: done }, "blocked"],
    [{ now, activity: "idle", verdict: verified, report: blocked }, "verified"],
    [{ now, activity: "working", verdict: { status: "verified", at: now - 600_000 } }, "working"],
    [{ now, activity: "done", report: done }, "reported"],
    [{ now, activity: "done", report: { ...done, createdAt: now - 60_000 } }, "resting"],
    [{ now, activity: "working", settled: true }, "working"],
    [{ now, activity: "idle", settled: true }, "resting"],
    [{ now, activity: "idle", verdict: { ...verified, at: now + 1 } }, "idle"],
  ] satisfies [MoodFacts, string][])("%j is %s", (facts, expected) => {
    expect(characterMood(facts)).toBe(expected);
  });
});

it("reads the member's linked verdict, not another member's or a partial verification", () => {
  const entry = { ...fixtureJournal.entries[0]!, threadId: maker.threadId, status: "verified" as const,
    link: { boardQuestId: "vault", waypointId: "w1" }, updatedAt: now,
    review: { actor: { kind: "user" as const }, at: now - 1, evidence: [], reason: null, previousNote: null, memberEvidenceAt: null } };
  expect(waypointMoodVerdict(maker, [entry])).toEqual({ ...verified, waypointId: "w1", checkerThreadId: null });
  expect(waypointMoodVerdict(maker, [entry, { ...entry, status: "done" }])).toBeNull();
  expect(waypointMoodVerdict(maker, [{ ...entry, threadId: "other" }])).toBeNull();
});

it("reads widget asks, verdicts and lifecycle without treating scope errors as failures", () => {
  const data = { ...fixtureDecor, member: maker, keeperView: null, boardQuest: fixtureBoard,
    moodSignals: { released: false, archived: false, handBack: false, report: null, verdict: verified } };
  expect(characterMood(widgetMoodFacts(data, now))).toBe("verified");
  const scope = { threadId: maker.threadId, scope: null, error: "Not loaded", armed: false, pendingAskId: null };
  expect(characterMood(widgetMoodFacts({ ...data, scope, moodSignals: undefined }, now))).toBe("idle");
  expect(characterMood(widgetMoodFacts({ ...data, scope: { ...scope, pendingAskId: "ask-1" } }, now))).toBe("waiting");
  expect(characterMood(widgetMoodFacts({ ...data, moodSignals: { ...data.moodSignals, archived: true } }, now))).toBe("released");
  expect(characterMood(widgetMoodFacts({ ...fixtureDecor, member: { ...fixtureMember, state: "working" } }, now))).toBe("waiting");
});

it("reads room reports, rejects and asks without attributing a Keeper ask to its member", () => {
  const quest = { ...fixtureQuest, waypoints: [{ ...fixtureQuest.waypoints[0]!, ownerMember: maker, state: "rejected" as const }] };
  const room: Pick<Room, "asks" | "keepers"> = { asks: [fixtureAsk], keepers: [{ member: fixtureMember, boardQuests: [quest], errands: [], status: "listening" }] };
  expect(characterMood(roomMoodFacts(room, fixtureMember, now))).toBe("waiting");
  expect(characterMood(roomMoodFacts(room, maker, now))).toBe("blocked");
  const reports = [{ ...fixtureReport, createdAt: now - 1 }];
  const unreviewed = { ...room, keepers: [{ ...room.keepers[0]!, boardQuests: [fixtureQuest] }] };
  expect(characterMood(roomMoodFacts(unreviewed, maker, now, { reports }))).toBe("reported");
  expect(characterMood(roomMoodFacts(unreviewed, maker, now, { reports, briefAt: now }))).toBe("idle");
});
