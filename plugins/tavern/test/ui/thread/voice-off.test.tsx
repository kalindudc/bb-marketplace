// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { ReportView, voiceShown } from "../../../src/ui/kit";
import { fixtureCharacter, fixtureDetail, fixtureMember, fixtureRegistry, fixtureReport } from "../../../src/ui/thread/fixtures";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";

afterEach(cleanup);
const load = () => loadPluginApp(definePluginApp(registerThreadSurfaces));
const message = { id: "m1", threadId: "keeper-1", turnId: null, projectId: null };
const report = { ...fixtureReport, status: "done" as const, voice: "Clear skies over the vault." };
const wren = { ...fixtureMember, threadId: "member-1", role: "member" as const, keeperThreadId: "keeper-1", boardQuestId: "vault", state: "working" as const, strikes: 0 };
const withVoice = (voice?: "full" | "light" | "off") => ({ ...fixtureRegistry, ...(voice ? { voice } : {}) });

describe("Character voice off: no character lines anywhere, history kept", () => {
  it("reads the setting from the registry, with a missing field meaning on and an unknown registry meaning not yet", () => {
    expect(voiceShown(withVoice("off"))).toBe(false);
    expect(voiceShown(withVoice("full"))).toBe(true);
    expect(voiceShown(withVoice("light"))).toBe(true);
    expect(voiceShown(withVoice())).toBe(true);
    expect(voiceShown(undefined)).toBe(false);
  });

  it("drops the report view's voice line only when told to, and keeps the rest of the report", () => {
    const on = render(<ReportView report={report} />);
    expect(on.container.querySelector(".rv-voice")!.textContent).toBe(report.voice);
    cleanup();
    const off = render(<ReportView report={report} voice={false} />);
    expect(off.container.querySelector(".rv-voice")).toBeNull();
    expect(off.container.textContent).toContain("Staging green");
  });

  for (const voice of ["off", "full", undefined] as const) {
    it(`${voice === "off" ? "hides" : "shows"} the report card's voice with voice ${voice ?? "missing"}`, async () => {
      const app = await load();
      const reports = app.messageDirectives.find(d => d.id === "tavern-reports")!;
      const slot = renderSlot(reports, { attributes: { ids: "report-1" }, source: "reports", message, openWorkspaceFile: null }, { rpc: { reports: () => ({ reports: [report] }), registry: () => withVoice(voice) } });
      await slot.findByText("Staging green");
      // The registry is read before the voice is drawn, so a turned-off line never flashes in.
      await new Promise(r => setTimeout(r, 30));
      expect(slot.container.textContent!.includes(report.voice)).toBe(voice !== "off");
      slot.lifecycle.unmount();
    });

    it(`${voice === "off" ? "hides" : "shows"} the party card's hired line with voice ${voice ?? "missing"}`, async () => {
      const app = await load();
      const directive = app.messageDirectives.find(d => d.id === "tavern-party")!;
      const detail = { ...fixtureDetail, quest: { ...fixtureDetail.quest, members: [wren] } };
      const slot = renderSlot(directive, { attributes: { quest: "vault" }, source: "tavern-party", message, openWorkspaceFile: null }, { rpc: { boardQuest: () => detail, registry: () => withVoice(voice), crests: () => ({ crests: [] }) } });
      await slot.findByText(fixtureCharacter.name);
      expect(slot.container.textContent!.includes(fixtureCharacter.lines.hired)).toBe(voice !== "off");
      slot.lifecycle.unmount();
    });
  }
});
