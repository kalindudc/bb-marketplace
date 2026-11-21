import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { it } from "vitest";
import { InsightsPage } from "../../../src/ui/page/insights";
import { ClassesSection } from "../../../src/ui/page/settings";
import { insightsView, settingsView } from "../../../src/ui/page/fixtures-insights";
import { registry } from "../../../src/ui/page/fixtures";

it.runIf(process.env.TAVERN_WARDEN_LAYOUT === "1")("renders Warden quality in both fixture surfaces", async () => {
  const rpc = { insights: () => insightsView, wardenQuality: () => insightsView.wardenQuality, settings: () => settingsView, registry: () => registry };
  const providers = { status: "ready" as const, providers: [{ id: "codex", displayName: "Codex", available: true }] as never };
  const insights = renderSlot({ component: InsightsPage }, {}, { rpc, providers });
  await insights.findByText("2 of 10 verifications reopened (20%)");
  const insightsMarkup = insights.container.innerHTML;
  insights.lifecycle.unmount();
  const settings = renderSlot({ component: ClassesSection }, {}, { rpc, providers });
  await settings.findByText("2 of 10 verifications reopened (20%)");
  const settingsMarkup = settings.container.innerHTML;
  settings.lifecycle.unmount();
  process.stdout.write("WARDEN_LAYOUT=" + JSON.stringify({ insights: '<div class="tavern tv-page">' + insightsMarkup + "</div>", settings: settingsMarkup }) + "\n");
});
