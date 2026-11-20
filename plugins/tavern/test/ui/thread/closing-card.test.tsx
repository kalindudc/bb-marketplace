// @vitest-environment jsdom
import { fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, it, vi } from "vitest";
import type { Ask, WaypointState } from "../../../src/shared/schema";
import type { BoardQuestDetail } from "../../../src/shared/contract";
import { AskCard } from "../../../src/ui/kit/ask-card";
import { TalePage } from "../../../src/ui/page/tale";
import { fixtureAsk, fixtureDetail, fixtureRegistry } from "../../../src/ui/thread/fixtures";

const waivers = [
  { waypointId: "w1", title: "Collect the rollout updates", state: "reported", reason: "The release owner cancelled the next shift" },
  { waypointId: "w2", title: "Check the next shift", state: "planned", reason: "The release owner cancelled the next shift" },
] as const;
const quote = "The release has been cancelled. Close the watch here.";
const prs = [
  { id: "pr-1", url: "https://github.com/example/monitoring-tool/pull/1234", state: "draft", owner: "maker", ownerName: "Vale", headVerified: false },
  { id: "pr-2", url: "https://github.com/example/monitoring-tool/pull/1235", state: "ready", owner: "keeper-1", ownerName: "Wren", headVerified: true },
];
function model(early: boolean, withPRs: boolean): Ask {
  const optionId = early ? "close-early" : "conclude";
  return { ...fixtureAsk, id: `ask-${optionId}-${withPRs}`, kind: "conclude", draft: null, createdAt: 1700000000000, meanwhile: "The quest stays open until you answer.", question: early ? "Can the rollout watch close early?" : "Can the rollout watch conclude?",
    why: early ? "Only your answer can close it early." : "Only your answer can conclude it.", holds: early ? ["w1", "w2"] : [],
    options: [{ id: optionId, label: early ? "Close early" : "Conclude the quest", detail: "Tell the tale and archive the party.", recommended: !early }, { id: "hold", label: "Keep open", detail: "Keep the party on the quest.", recommended: early }],
    effect: { type: optionId, draft: { outcome: "The rollout has ended", left: "", ...(early ? { unsettled: waivers, fromSteer: { routeId: "steer-1", text: quote, at: 1700000000000 } } : {}), pullRequests: withPRs ? prs : [] } },
  } as unknown as Ask;
}

it("shows the reason, quote, named dispositions and default pull-request choices", async () => {
  const send = vi.fn((_input: unknown) => ({ ok: true }));
  const slot = renderSlot({ component: () => <AskCard ask={model(true, true)} /> } as never, {}, { rpc: { answerAsk: send } });
  try {
    expect(await slot.findByText(quote, { exact: false })).toBeTruthy();
    const rows = await slot.findByRole("list", { name: "Waivers if you close early" });
    expect(rows.textContent).toContain("w1 recorded as made, not verified");
    expect(rows.textContent).toContain("w2 recorded as not done");
    expect(rows.textContent).not.toContain("(now reported)");
    expect(await slot.findByText(waivers[0].reason, { exact: false })).toBeTruthy();
    expect(within(rows).queryByText(waivers[0].reason, { exact: false })).toBeNull();
    const select = await slot.findByRole("combobox", { name: /1235/ }) as HTMLSelectElement;
    expect(select.value).toBe("keep");
    fireEvent.change(select, { target: { value: "close" } });
    fireEvent.click(await slot.findByRole("radio", { name: /Close early/ }));
    fireEvent.click(await slot.findByRole("button", { name: "Close early" }));
    await waitFor(() => expect(send.mock.calls[0]?.[0]).toMatchObject({ optionId: "close-early", pullRequestChoices: [{ id: "pr-2", action: "close" }] }));
  } finally { slot.lifecycle.unmount(); }
});

it("shows the Keeper's reason on a no-map closing card", async () => {
  const ask = model(true, false);
  const reason = "The alert was fixed upstream before we planned";
  ask.effect = { type: "close-early", draft: { outcome: "No work needed", left: "", noPlan: true, unsettled: [], reason } } as Ask["effect"];
  const slot = renderSlot({ component: () => <AskCard ask={ask} /> } as never, {}, {});
  try { expect(await slot.findByText(reason, { exact: false })).toBeTruthy(); }
  finally { slot.lifecycle.unmount(); }
});

it("tells each waived waypoint exactly as it was at close, without verified loot", async () => {
  const records = waivers.map(w => ({ ...w, askId: "ask-answer", planVersion: 1 }));
  const detail = { ...fixtureDetail,
    quest: { ...fixtureDetail.quest, phase: "done", outcome: "closed-early", endedAt: 1700000000000, waypoints: records.map((w, i) => ({ ...fixtureDetail.quest.waypoints[i]!, state: "waived" as WaypointState, title: w.title, waiver: w })) },
    tale: { outcome: "The rollout ended", left: null, skipped: [], wrappedAt: 1700000000000, closure: "closed-early", waivers: records },
  } as BoardQuestDetail;
  const slot = renderSlot({ component: () => <TalePage detail={detail} registry={fixtureRegistry} /> } as never, {}, {});
  try {
    const story = await slot.findByRole("region", { name: "Closed early at your request" });
    expect(within(story).getByText(/w1 recorded as made, not verified/)).toBeTruthy();
    expect(within(story).getByText(/w2 recorded as not done/)).toBeTruthy();
    expect(await slot.findByText("No verified loot.")).toBeTruthy();
  } finally { slot.lifecycle.unmount(); }
});

it.runIf(process.env.TAVERN_CLOSING_LAYOUT === "1")("renders closing cards for the browser harness", async () => {
  const markup: Record<string, string> = {};
  const cases: [boolean, boolean, boolean?][] = [[false, false], [false, true], [true, false], [true, true], [true, false, true]];
  for (const [early, withPRs, noPlan] of cases) {
    const ask = model(early, withPRs);
    if (noPlan) {
      ask.question = "Can the unplanned rollout watch close early?";
      ask.holds = [];
      ask.options[0]!.detail = "No quest map was written.";
      ask.effect = { type: "close-early", draft: { outcome: "Nothing was needed", left: "", unsettled: [], noPlan: true } };
    }
    const slot = renderSlot({ component: () => <AskCard ask={ask} /> } as never, {}, { rpc: { answerAsk: () => ({ ok: true }) } });
    try {
      await slot.findByRole("radio", { name: early ? /Close early/ : /Conclude the quest/ });
      markup[noPlan ? "early-no-map" : `${early ? "early" : "conclude"}-${withPRs ? "with-pr" : "no-pr"}`] = slot.container.innerHTML;
    } finally { slot.lifecycle.unmount(); }
  }
  process.stdout.write("CLOSING_LAYOUT=" + JSON.stringify(markup) + "\n");
});
