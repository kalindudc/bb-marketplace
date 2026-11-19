// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, cleanup, waitFor } from "@testing-library/react";
import { afterEach } from "vitest";
import { fixtureAsk, fixtureDecor, fixtureQuest, fixtureRegistry, fixtureReport } from "../../../src/ui/thread/fixtures";
import { AskCard, layoutWaypoints } from "../../../src/ui/kit";
import { ReportCard } from "../../../src/ui/thread/cards";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { renderAttentionSlot as renderSlot } from "../attention-fixture";
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
        // The note is offered inline for every kind, not only decisions.
        expect(slot.container.querySelector(".ask-notefield input")).not.toBeNull();
        expect((slot.getByRole("button", { name: "Send as you" }) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(slot.getByRole("radio", { name: /Send.*exact draft/ }));
        fireEvent.click(slot.getByRole("button", { name: "Send as you" }));
        await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
        await slot.findByText("Answered");
        expect(slot.getByText("answered from a client Tavern could not attribute")).toBeTruthy();
        slot.lifecycle.unmount();
    });
    it("surfaces a visible note field on a decision, sends the note, and shows it on the receipt", async () => {
        const decision = { ...fixtureAsk, id: "decide-ship", kind: "decision" as const, draft: null, question: "Ship without the migration?", options: [{ id: "ship", label: "Ship it", detail: "Merge now", recommended: true }, { id: "wait", label: "Wait", detail: "Hold for the migration", recommended: false }] };
        const app = await loadPluginApp(definePluginApp(a => a.slots.homepageSection({ id: "ask-note", title: "Ask note", component: () => <AskCard ask={decision} /> })));
        const mutate = vi.fn(() => ({ ok: true }));
        const slot = renderSlot(app.homepageSections[0]!, { projectId: null }, { rpc: { answerAsk: mutate } });
        // A labeled input beside the answers, never a collapsed details, so the note reads before the decision is made.
        const field = await slot.findByLabelText(/Add a note for the Keeper/);
        expect(field.tagName).toBe("INPUT");
        expect(field.getAttribute("maxlength")).toBe("2000");
        expect(slot.container.querySelector(".tavern.ask details")).toBeNull();
        fireEvent.change(field, { target: { value: "Watch the rollback path" } });
        fireEvent.click(slot.getByRole("button", { name: "Send answer" }));
        await waitFor(() => expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ askId: "decide-ship", note: "Watch the rollback path" })));
        // The receipt keeps the note the user wrote, from the local answer before the server's next read.
        await slot.findByText(/Watch the rollback path/);
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
        await toggle.findByRole("button", { name: /Show Tavern.*1 need you/ });
        toggle.lifecycle.unmount();
    });
});
