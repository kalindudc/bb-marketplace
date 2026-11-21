import { it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { ThreadWidget } from "../../../src/ui/thread/composer";
import { LedgerTab } from "../../../src/ui/thread/tabs";
import { InsightsPage } from "../../../src/ui/page/insights";
import { insightsView, settingsView } from "../../../src/ui/page/fixtures-insights";
import { fixtureDecor, fixtureLedger, fixtureQuest, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { Chart } from "../../../src/ui/kit/charts";
import { waitFor } from "@testing-library/react";
import { AttentionSection } from "../../../src/ui/page/settings";
import { ClosingTimeTab } from "../../../src/ui/page/panels";
import { emptyRoomScene } from "../page/scenes";
import type { AlertRouteView } from "../../../src/shared/alert-route";

it.runIf(process.env.TAVERN_ALERT_HARNESS === "1")("renders the alert route states for browser measurement", async () => {
  const unproven: AlertRouteView = { proven: false, lastTest: null, lastFailure: null };
  const at = Date.now() - 120_000;
  const sent: AlertRouteView = { ...unproven, lastTest: { id: 1, at, outcome: "sent", response: null } };
  const arrived: AlertRouteView = { proven: true, lastTest: { id: 1, at, outcome: "sent", response: "arrived" }, lastFailure: { at: at - 180_000, error: "The notification service did not respond." } };
  const settings = async (route: AlertRouteView, ready: string) => {
    const slot = renderSlot({ component: AttentionSection }, {}, { rpc: { settings: () => settingsView, alertRoute: () => route } });
    await slot.findByText(ready);
    const markup = slot.container.innerHTML;
    slot.lifecycle.unmount();
    return markup;
  };
  const before = await settings(unproven, "No test alert yet.");
  const waiting = await settings(sent, "Tavern sent the test. Did it arrive on your device?");
  const after = await settings(arrived, "You confirmed it arrived.");
  const closing = renderSlot({ component: ClosingTimeTab }, { subPath: "closing", params: null }, {
    rpc: {
      room: () => emptyRoomScene, registry: () => fixtureRegistry, settings: () => settingsView, alertRoute: () => unproven,
      away: () => ({ revision: 0, status: { closed: false, until: null, dueBack: false, windowId: null }, window: null, watchedCount: 0, heldCount: 0, pendingStops: [], resumeRequired: [] }),
    },
  });
  await closing.findByText("Alerts have not reached you yet. Blocker wakes may not either.");
  await waitFor(() => { if ((closing.getByRole("button", { name: "Review before closing" }) as HTMLButtonElement).disabled) throw new Error("Waiting for the loaded sheet"); });
  const sheet = closing.container.innerHTML;
  closing.lifecycle.unmount();
  process.stdout.write("ALERT_HARNESS=" + JSON.stringify({ before, waiting, after, sheet }) + "\n");
});

it.runIf(process.env.TAVERN_LAYOUT_HARNESS === "1")("renders branch components for the browser layout harness", async () => {
  const widgets: string[] = [];
  for (const n of [1, 2, 3, 0]) {
    const count = n || 1;
    const decor = { ...fixtureDecor, characters: false, pendingEvents: 4, member: { ...fixtureDecor.member!, displayName: "Wren XVIII" }, keeperView: { ...fixtureDecor.keeperView!, boardQuests: Array.from({ length: count }, (_, i) => ({ ...fixtureQuest, id: `q${i}`, short: n === 0 ? "Vault" : ["Edge infrastructure", "Resiliency action", "Operations monitoring"][i]! })), openAsks: Array.from({ length: 3 }, (_, i) => ({ ...fixtureDecor.keeperView!.openAsks[0]!, id: `ask${i}` })) } };
    const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { decor: () => decor, registry: () => fixtureRegistry } });
    await slot.findByRole("button", { name: /3 asks need you/ });
    widgets.push(slot.container.innerHTML);
    slot.lifecycle.unmount();
  }
  const shortWidget = widgets.pop()!;
  const member = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { decor: () => ({ ...fixtureDecor, characters: false, member: { ...fixtureDecor.member!, role: "member" as const, displayName: "Wren XVIII" }, keeperView: null, boardQuest: fixtureQuest }), registry: () => fixtureRegistry } });
  await waitFor(() => { if (!member.container.querySelector(".tw-member-id")) throw new Error("Waiting for member identity"); });
  const memberHtml = member.container.innerHTML;
  member.lifecycle.unmount();
  const title = "Monitor Edge Infrastructure operations and prepare non-staging resiliency action";
  const ledger = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { ledger: () => ({ ...fixtureLedger, boardQuests: [{ ...fixtureQuest, title }] }), decor: () => fixtureDecor, registry: () => fixtureRegistry } });
  await ledger.findByRole("button", { name: title });
  const ledgerHtml = ledger.container.innerHTML;
  ledger.lifecycle.unmount();
  const insights = renderSlot({ component: InsightsPage }, {}, { rpc: { insights: () => insightsView, settings: () => settingsView, registry: () => fixtureRegistry } });
  await insights.findByText("Median goal to return");
  await waitFor(() => { if (!insights.container.querySelector(".tchart:not(.sk)")) throw new Error("Waiting for loaded charts"); });
  const insightsHtml = renderToStaticMarkup(<div className="tavern tv-page" dangerouslySetInnerHTML={{ __html: insights.container.innerHTML }} />);
  insights.lifecycle.unmount();
  const stress = renderToStaticMarkup(<div className="tavern"><Chart type="bars" series={{ id: "models", label: "Long model ids", unit: "count", points: [{ x: "anthropic/claude-sonnet-5-5-20261101-long-model-identifier-without-spaces", y: 24 }] }} /></div>);
  process.stdout.write("LAYOUT_HARNESS=" + JSON.stringify({ widgets, shortWidget, member: memberHtml, ledger: ledgerHtml, insights: insightsHtml, stress }) + "\n");
});
