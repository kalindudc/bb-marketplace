// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REMIND_EVERY_MS, REPORT_GRACE_MS, STATE_ACTIONS, reminderDue } from "../../src/server/journal/store";
import type { JournalEntry } from "../../src/shared/schema";

/**
 * Stuart's replay: the coordinator's real day (13,791 events, reduced to a text-free skeleton of its 989 requests and 164 journal
 * calls) through the shipped reminder rule. Delivery is assumed possible at every request: the steer's other gates (a running
 * tool, no journal call first) are tested in requests.test.ts.
 */
type Event = { t: number; k: "req"; from: string | null; plugin: string | null; visible: boolean; retry: boolean; note: boolean; child: string | null }
  | { t: number; k: "journal"; action: string; ok: boolean; open: number | null };
const { events } = JSON.parse(readFileSync(new URL("./fixtures/coordinator-skeleton.json", import.meta.url), "utf8")) as { events: Event[] };
const openEntry = [{ status: "todo" }] as JournalEntry[];
const inbound = (e: Event) => e.k === "req" && e.visible && !e.retry && !e.note;
const human = (e: Event) => e.k === "req" && e.visible && !e.retry && !e.note && e.from === "user" && !e.plugin;
type Owned = { reportAt: number; closedAt: number | null };

function replay(owned: Owned[] = []) {
  let open = 0, stateChangedAt: number | null = null, notedAt: number | null = null, previous: number | null = null;
  const reminders: { t: number; byReport: boolean }[] = [];
  for (const e of events) {
    if (e.k === "journal") {
      if (e.ok && e.open !== null) open = e.open;
      if (e.ok && STATE_ACTIONS.includes(e.action)) stateChangedAt = e.t;
      continue;
    }
    if (!inbound(e)) continue;
    const waiting = owned.filter((o) => o.reportAt <= e.t && (o.closedAt === null || o.closedAt > e.t)).map((o) => o.reportAt);
    const state = { stateChangedAt, notedAt, reportAt: waiting.length ? Math.max(...waiting) : null, now: e.t };
    if (reminderDue(state, open > 0 ? openEntry : [], previous)) {
      const byRequest = reminderDue({ ...state, reportAt: null }, open > 0 ? openEntry : [], previous);
      reminders.push({ t: e.t, byReport: !byRequest }); notedAt = e.t;
    }
    previous = e.t;
  }
  return reminders;
}
/** The old rule: only human requests, any edit (rewording included) resets staleness, once per stretch. */
function replayOld() {
  let open = 0, changedAt: number | null = null, notedAt: number | null = null, previous: number | null = null, count = 0;
  for (const e of events) {
    if (e.k === "journal") { if (e.ok && e.open !== null) open = e.open; if (e.ok && !["list", "get", "rules", "skill"].includes(e.action)) changedAt = e.t; continue; }
    if (!human(e)) continue;
    if (open > 0 && changedAt !== null && previous !== null && changedAt < previous && (notedAt === null || notedAt < changedAt)) { count++; notedAt = e.t; }
    previous = e.t;
  }
  return count;
}

describe("replaying the coordinator's day through the reminder rule", () => {
  const inboundCount = events.filter(inbound).length;
  it("reminds about three times as often as the old rule, still about 3 per 100 messages, and never twice in 15 minutes", () => {
    const reminders = replay();
    // Old rule, with the same assumption that every reminder could be delivered: 10. Stuart's target is 1 to 3 per 100 inbound.
    expect(replayOld()).toBe(10);
    expect(reminders).toHaveLength(33);
    expect(reminders.length / inboundCount).toBeLessThan(0.035);
    for (let i = 1; i < reminders.length; i++) expect(reminders[i]!.t - reminders[i - 1]!.t).toBeGreaterThanOrEqual(REMIND_EVERY_MS);
  });

  const children = events.filter((e): e is Extract<Event, { k: "req" }> => e.k === "req" && !!e.child);
  const baseline = replay();
  // A delegate's completion during a quiet hour: no reminder would fire in the next hour without the owned entry.
  const quiet = children.find((c) => !baseline.some((r) => r.t > c.t && r.t <= c.t + 60 * 60_000) && events.filter((e) => inbound(e) && e.t > c.t + REPORT_GRACE_MS && e.t <= c.t + 60 * 60_000).length > 0)!;

  it("names a delegate's report left unchecked past its grace, even in a stretch where nothing else would remind", () => {
    expect(quiet).toBeDefined();
    const after = replay([{ reportAt: quiet.t, closedAt: null }]).filter((r) => r.t > quiet.t);
    expect(after[0]).toMatchObject({ byReport: true });
    expect(after[0]!.t - quiet.t).toBeGreaterThanOrEqual(REPORT_GRACE_MS);
    expect(after[0]!.t - quiet.t).toBeLessThanOrEqual(60 * 60_000);
  });

  it("stays as quiet as the day without owners when every delegated entry is closed within its grace", () => {
    const prompt = children.slice(0, 200).map((c) => ({ reportAt: c.t, closedAt: c.t + 2 * 60_000 }));
    expect(replay(prompt)).toEqual(baseline);
  });
});
