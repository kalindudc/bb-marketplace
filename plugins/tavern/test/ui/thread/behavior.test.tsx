// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, cleanup, waitFor } from "@testing-library/react";
import { afterEach } from "vitest";
import { fixtureAsk, fixtureDecor, fixtureQuest, fixtureRegistry, fixtureReport } from "../../../src/ui/thread/fixtures";
import { AskCard, layoutWaypoints } from "../../../src/ui/kit";
import { ReportCard } from "../../../src/ui/thread/cards";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";
afterEach(cleanup);
const load = () => loadPluginApp(definePluginApp(registerThreadSurfaces));
describe("thread UI", () => {
    it("keeps sends-as-you unselected and shows the entire consent preview", async () => {
        const app = await loadPluginApp(definePluginApp(app => app.slots.homepageSection({ id: "ask-test", title: "Ask test", component: () => <AskCard ask={fixtureAsk}/> })));
        const mutate = vi.fn(() => ({ ok: true }));
        const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, { rpc: { answerAsk: mutate } });
        expect(slot.getByText("Luc in #vault")).toBeTruthy();
        expect(slot.getByText(fixtureAsk.draft!.body)).toBeTruthy();
        expect((slot.getByRole("button", { name: "Send as you" }) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(slot.getByRole("radio", { name: /Send.*exact draft/ }));
        fireEvent.click(slot.getByRole("button", { name: "Send as you" }));
        await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
        await slot.findByText("Answered");
        slot.lifecycle.unmount();
    });
    it("suppresses voice on bad news even if the backend includes it", () => {
        const view = render(<ReportCard report={{ ...fixtureReport, status: "blocked", voice: "Should not appear" }}/>);
        expect(view.queryByText("Should not appear")).toBeNull();
        expect(view.getByText(/safe to ship/)).toBeTruthy();
    });
    it("lays branches on parallel lanes and rejects broken dependencies", () => {
        const first = fixtureQuest.waypoints[0]!;
        const nodes = layoutWaypoints([first, { ...first, id: "w2", dependsOn: ["w1"] }, { ...first, id: "w3", dependsOn: ["w1"] }]);
        expect(nodes[1]!.column).toBe(nodes[2]!.column);
        expect(nodes[1]!.lane).not.toBe(nodes[2]!.lane);
        expect(() => layoutWaypoints([{ ...first, dependsOn: ["missing"] }])).toThrow("missing waypoint");
        expect(() => layoutWaypoints([{ ...first, dependsOn: ["w1"] }])).toThrow("cycle");
    });
    it("registers all seven directives and only one thread composer action", async () => {
        const app = await load();
        expect(app.messageDirectives.map(d => d.id)).toEqual(["tavern-questmap", "tavern-ask", "tavern-reports", "tavern-ledger", "tavern-party", "tavern-errand", "tavern-tale"]);
        const thread = app.composerCustomizations.find(c => c.id === "tavern-thread")!;
        expect(thread.actions).toHaveLength(1);
        expect(thread.banners?.[0]?.chrome).toBe("bare");
        expect(thread.plusMenu?.map(m => m.label)).toContain("Show Tavern");
    });
    it("hidden widget takes no space and toggle retains the ask count", async () => {
        const app = await load();
        const thread = app.composerCustomizations.find(c => c.id === "tavern-thread")!;
        const options = { composer: { scope: { kind: "thread" as const, threadId: "keeper-1" } }, rpc: { decor: () => ({ ...fixtureDecor, hidden: true }), registry: () => fixtureRegistry } };
        const slot = renderSlot(thread.banners![0]!, {}, options);
        await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
        expect(slot.queryByLabelText("Tavern widget")).toBeNull();
        slot.lifecycle.unmount();
        const toggle = renderSlot(thread.actions![0]!, {}, options);
        await toggle.findByRole("button", { name: /Show Tavern.*1 open ask/ });
        toggle.lifecycle.unmount();
    });
});
