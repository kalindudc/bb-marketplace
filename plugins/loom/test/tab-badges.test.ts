import { describe, expect, it } from "vitest";
import type { MergeEntry, MergeOrderView, RolloutView, RolloutWarning } from "../src/contract";
import { acknowledged, tabBadges } from "../src/ui/tab-badges";
import { card, overview, projectView } from "./fixtures";

const entry = (key: string, over: Partial<MergeEntry> = {}) => ({ key, title: `${key} title`, prUrl: `https://github.com/acme/shop/pull/${key.slice(4)}`, verdict: "first", step: 1, mergedInto: null, mergedIntoState: null, ...over }) as MergeEntry;
const order = (entries: MergeEntry[]) => ({ repos: [null], steps: 1, entries, counts: { open: entries.length, first: entries.length, ready: 0, wrong: 0 } }) as MergeOrderView;
const elsewhere = (key: string, intoState: MergeEntry["mergedIntoState"] = "pr_open") => entry(key, { state: "done", step: 0, verdict: "merged_elsewhere", mergedInto: "CSV-1", mergedIntoState: intoState });
const warning = (kind: RolloutWarning["kind"], tone: RolloutWarning["tone"], key: string): RolloutWarning => ({ kind, tone, keys: [key], text: `${key} ${kind}.` });
const rollout = (warnings: RolloutWarning[]) => ({ warnings }) as RolloutView;
const pr = overview({ strategy: "pr", branch: null });

describe("tab badges", () => {
  it("say what each one counts, how it clears, and list the items behind it with where they lead", () => {
    const badges = tabBadges(
      projectView({
        overview: overview({ pendingVersion: 2 }),
        board: [card({ key: "CSV-1", title: "Model", state: "blocked" }), card({ key: "CSV-2", state: "working" })],
        askSteps: [
          { index: 0, action: "other", text: "Rotate the token.", key: null },
          { index: 2, action: "live", text: "Mark traffic-low live.", key: "traffic-low" },
          { index: 3, action: "reply", text: "Answer CSV-2.", key: "CSV-2" },
        ],
      }),
    );
    expect(badges.board).toMatchObject({ text: "1", label: "1 ticket is blocked", tone: "destructive", items: [{ id: "CSV-1", text: "CSV-1: Model", ticket: "CSV-1" }] });
    expect(badges.board!.clears).toContain("requeued");
    expect(badges.spec).toMatchObject({ text: "1", label: "Spec v2 waits for your approval", tone: "warning" });
    expect(badges.spec!.clears).toContain("approve v2");
    // A milestone ref is no ticket, so only the ticket key links.
    expect(badges.planner).toMatchObject({
      text: "3",
      label: "The planner asks you to do 3 things",
      items: [
        { id: "0", text: "Step 1: Rotate the token." },
        { id: "2", text: "Step 3: Mark traffic-low live." },
        { id: "3", text: "Step 4: Answer CSV-2.", ticket: "CSV-2" },
      ],
    });
    expect(badges.planner!.items[1]).not.toHaveProperty("ticket");
    expect(badges.planner!.clears).toContain("mark it Done");
    for (const badge of Object.values(badges)) expect(badge!.ack).toBeUndefined();
  });

  it("shows the planner's wait in its chat before its asks, linking the thread", () => {
    const badges = tabBadges(projectView({ askSteps: [{ index: 0, action: "other", text: "Rotate the token.", key: null }] }), null, true);
    expect(badges.planner).toMatchObject({ text: "?", label: "The planner's thread waits for your answer in its chat", items: [{ id: "thread", thread: "thr_plan" }] });
    expect(badges.planner!.clears).toContain("Reading the thread does not clear it.");
  });

  it("gives the Merge order tab no badge for pull requests that only have nothing before them", () => {
    expect(tabBadges(projectView({ overview: pr, mergeOrder: order([entry("CSV-1"), entry("CSV-2", { verdict: "ready" })]) })).merge).toBeUndefined();
    // Once the ticket it merged into is done too, its change can be on the base through it.
    expect(tabBadges(projectView({ overview: pr, mergeOrder: order([elsewhere("CSV-2", "done")]) })).merge).toBeUndefined();
  });

  it("counts the pull requests merged the wrong way, and hides the badge while the human's acknowledgement covers each one", () => {
    const view = (keys: string[], acked: string[]) => projectView({ overview: pr, mergeOrder: order([entry("CSV-1"), ...keys.map((key) => elsewhere(key))]), badgeAcks: { merge: acked, rollout: [] } });
    const badge = tabBadges(view(["CSV-2"], [])).merge!;
    expect(badge).toMatchObject({ text: "1", tone: "destructive", ack: { tab: "merge", items: ["CSV-2"] }, items: [{ id: "CSV-2", text: "CSV-2 merged into CSV-1's branch", ticket: "CSV-2", url: "https://github.com/acme/shop/pull/2" }] });
    expect(tabBadges(view(["CSV-2"], ["CSV-2"])).merge).toBeUndefined();
    // A new one brings it back with both, and one that went away leaves the rest acknowledged.
    expect(tabBadges(view(["CSV-2", "CSV-3"], ["CSV-2"])).merge).toMatchObject({ text: "2", ack: { items: ["CSV-2", "CSV-3"] } });
    expect(tabBadges(view(["CSV-3"], ["CSV-2", "CSV-3"])).merge).toBeUndefined();
  });

  it("counts only the Rollout tab's warning-tone warnings, and hides them once acknowledged until a new one appears", () => {
    expect(tabBadges(projectView({ rollout: rollout([warning("milestone", "info", "CSV-2"), warning("window", "info", "CSV-3")]) })).rollout).toBeUndefined();
    const view = (warnings: RolloutWarning[], acked: string[]) => projectView({ rollout: rollout(warnings), badgeAcks: { merge: [], rollout: acked } });
    const two = [warning("milestone", "info", "CSV-2"), warning("ships_on_merge", "warning", "CSV-2"), warning("soak", "warning", "CSV-3")];
    const badge = tabBadges(view(two, [])).rollout!;
    expect(badge).toMatchObject({ text: "2", tone: "warning", label: "2 rollout warnings before you merge or deploy", ack: { tab: "rollout", items: ["ships_on_merge:CSV-2:CSV-2 ships_on_merge.", "soak:CSV-3:CSV-3 soak."] } });
    expect(badge.items.map((item) => item.text)).toEqual(["CSV-2 ships_on_merge.", "CSV-3 soak."]);
    const acked = ["ships_on_merge:CSV-2:CSV-2 ships_on_merge.", "soak:CSV-3:CSV-3 soak."];
    expect(tabBadges(view(two, acked)).rollout).toBeUndefined();
    expect(tabBadges(view([...two, warning("deploy_early", "warning", "CSV-4")], acked)).rollout).toMatchObject({ text: "3" });
  });

  it("brings the Rollout badge back for a second freeze window on a ticket whose first window was acknowledged", () => {
    const freeze = (title: string): RolloutWarning => ({ kind: "window", tone: "warning", keys: ["LANE-2"], text: `LANE-2 deploys on merge, and the ${title} is on until Jan 4.` });
    const holiday = tabBadges(projectView({ rollout: rollout([freeze("Holiday freeze")]) })).rollout!;
    const view = projectView({ rollout: rollout([freeze("Holiday freeze"), freeze("Launch freeze")]), badgeAcks: { merge: [], rollout: holiday.ack!.items } });
    expect(tabBadges(view).rollout).toMatchObject({ text: "2" });
  });

  it("acknowledges nothing with an empty list", () => {
    expect(acknowledged([], [])).toBe(false);
    expect(acknowledged(["a"], [])).toBe(false);
    expect(acknowledged(["a", "b"], ["b"])).toBe(true);
    expect(acknowledged(["a"], ["a", "b"])).toBe(false);
  });
});
