import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SETTINGS_SECTIONS, settingsSection } from "../../../src/ui/page/settings";
import { settingsContract } from "../../../src/shared/settings";
import { settingsView } from "../../../src/ui/page/fixtures-insights";
import { ReportCard } from "../../../src/ui/thread/cards";
import { fixtureReport } from "../../../src/ui/thread/fixtures";
it("shows Atmosphere controls without a voice check and still renders an old report", async () => {
  const atmosphere = settingsSection(SETTINGS_SECTIONS.find(section => section.id === "atmosphere")!);
  const slot = renderSlot(atmosphere, {}, { pluginId: "tavern", experimental_rpcContract: settingsContract, rpc: { settings: () => settingsView } });
  try {
    await slot.findByText("Speech bubbles", { selector: "label" });
    await slot.findByText("Reported pose lasts", { selector: "label" });
    expect(slot.queryByText(/Voice checks|how often a voice check/)).toBeNull();
    const report = renderToStaticMarkup(<main className="tavern"><ReportCard report={fixtureReport} /></main>);
    expect(report).toContain('class="voice"');
    expect(report).toContain(fixtureReport.voice);
    if (process.env.TAVERN_VOICE_HARNESS === "1") {
      process.stdout.write("VOICE_HARNESS=" + JSON.stringify({ settings: slot.container.innerHTML, report }) + "\n");
    }
  } finally {
    slot.lifecycle.unmount();
  }
});
