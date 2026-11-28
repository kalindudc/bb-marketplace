// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, mountPluginContentScripts, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fixtureAsk, fixtureBoard, fixtureClass, fixtureDecor, fixtureDetail, fixtureJournal, fixtureRegistry, fixtureReport, fixtureRoute } from "../../../src/ui/thread/fixtures";
import { JournalTab } from "../../../src/ui/thread/tabs";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";
import { directiveAttributes } from "../../../src/ui/thread/cards";
import { MessageRouteTab, routeForMetadata } from "../../../src/ui/thread/metadata";
import { safeHref } from "../../../src/ui/kit";
afterEach(cleanup);
const load = () => loadPluginApp(definePluginApp(registerThreadSurfaces));
describe("Tavern surfaces", () => {
    it("inserts a class mention at the start without losing the user's draft", async () => {
        const app = await load();
        const classes = app.composerCustomizations.find(c => c.id === "tavern-new-thread")!;
        const slot = renderSlot(classes.experimental_popups![0]!, {}, { pluginId: "tavern", composer: { scope: { kind: "new-thread", projectId: "p1" }, text: "Move Vault safely", selection: {} }, rpc: { registry: () => fixtureRegistry } });
        const option = await slot.findByRole("option", { name: /Keeper/ });
        fireEvent.click(option);
        await waitFor(() => expect(slot.inspection.composer.draft.mentions).toHaveLength(1));
        expect(slot.inspection.composer.text).toBe("!Keeper Move Vault safely");
        expect(slot.inspection.composer.draft.mentions[0]).toMatchObject({ kind: "plugin", provider: "classes", id: "keeper", from: 0 });
        slot.lifecycle.unmount();
    });
    it("adds no chip to the new-thread composer: the class comes from the plus menu, the send menu or the start cards", async () => {
        const app = await load();
        const classes = app.composerCustomizations.find(c => c.id === "tavern-new-thread")!;
        expect(classes.actions ?? []).toHaveLength(0);
        expect(classes.plusMenu?.map(i => i.label)).toContain("Choose a Tavern class");
        expect(classes.sendMenu?.map(i => i.label)).toEqual(expect.arrayContaining(["Start as Keeper", "Start as Wanderer"]));
        expect(classes.banners?.map(b => b.id)).toContain("class-preview");
    });
    it("class picker supports arrows and excludes hire-only classes", async () => {
        const app = await load();
        const classes = app.composerCustomizations.find(c => c.id === "tavern-new-thread")!;
        const slot = renderSlot(classes.experimental_popups![0]!, {}, { rpc: { registry: () => ({ ...fixtureRegistry, classes: [fixtureClass, { ...fixtureClass, id: "smith", label: "Smith" }, { ...fixtureClass, id: "warden", label: "Warden", startable: false }] }) } });
        await slot.findByRole("option", { name: /Keeper/ });
        expect(slot.getAllByRole("option")).toHaveLength(2);
        fireEvent.keyDown(slot.getByRole("listbox"), { key: "ArrowDown" });
        expect(document.activeElement?.textContent).toContain("Smith");
        slot.lifecycle.unmount();
    });
    it("reuses answer receipts from another device instead of showing open controls", async () => {
        const app = await load();
        const directive = app.messageDirectives.find(d => d.id === "tavern-ask")!;
        const slot = renderSlot(directive, { attributes: { id: fixtureAsk.id }, source: "ask", message: { id: "m1", threadId: "keeper-1", turnId: null, projectId: null }, openWorkspaceFile: null }, { rpc: { ledger: () => ({ keeperThreadId: "keeper-1", boardQuests: [], asks: [{ ...fixtureAsk, draft: null, state: "answered", answer: { optionId: "wait", note: null, by: "user", via: "phone", at: 1000 } }], decisions: [], rules: [], routes: [], restatement: "", lastReanchorAt: null }) } });
        await slot.findByText("Answered");
        expect(slot.queryByRole("button", { name: "Send as you" })).toBeNull();
        slot.lifecycle.unmount();
    });
    it("renders the report digest with evidence and two-part confidence", async () => {
        const app = await load();
        const reports = app.messageDirectives.find(d => d.id === "tavern-reports")!;
        const slot = renderSlot(reports, { attributes: { ids: "report-1" }, source: "reports", message: { id: "m1", threadId: "keeper-1", turnId: null, projectId: null }, openWorkspaceFile: null }, { rpc: { reports: () => ({ reports: [fixtureReport] }) } });
        await slot.findByText("Staging green");
        expect(slot.getByText(/matches intent 95%.*safe to ship 60%/)).toBeTruthy();
        slot.lifecycle.unmount();
    });
    it("shows historical plans without letting an old seal approve a newer plan", async () => {
        const app = await load();
        const card = app.messageDirectives.find(d => d.id === "tavern-questmap")!;
        const slot = renderSlot(card, { attributes: { quest: "vault", version: "1" }, source: "map", message: { id: "m1", threadId: "keeper-1", turnId: null, projectId: null }, openWorkspaceFile: null }, { rpc: { boardQuest: () => ({ ...fixtureDetail, quest: { ...fixtureDetail.quest, planVersion: 2 } }), registry: () => fixtureRegistry } });
        await slot.findByText("This plan was superseded; it cannot be greenlit here.");
        expect(slot.queryByRole("button", { name: "Approve: Form the party (greenlight)" })).toBeNull();
        slot.lifecycle.unmount();
    });
    it("validates untrusted directive attributes before querying", () => {
        expect(directiveAttributes("tavern-questmap", { quest: "vault", version: "-2" }).success).toBe(false);
        expect(directiveAttributes("tavern-reports", { ids: Array(31).fill("x").join(",") }).success).toBe(false);
        expect(directiveAttributes("tavern-errand", { member: "" }).success).toBe(false);
        expect(safeHref("javascript:alert(1)")).toBeNull();
        expect(safeHref("https://example.com")).toBe("https://example.com/");
    });
    it("matches routes by the shared text key and refuses ambiguous repeats", () => {
        expect(routeForMetadata([fixtureRoute], 9999, "Skip  the audience check")).toEqual(fixtureRoute);
        expect(routeForMetadata([fixtureRoute, { ...fixtureRoute, id: "r2" }], 9999, "skip the audience check")).toBeNull();
        expect(routeForMetadata([fixtureRoute], 9999, "an unrelated aside")).toBeNull();
    });
    it("describes an aside as asking for no work in the route-correction panel", async () => {
        await load();
        const slot = renderSlot({ component: MessageRouteTab }, { threadId: "keeper-1", environment: null, params: null }, { rpc: { routes: () => ({ routes: [fixtureRoute], boardQuests: [] }) } });
        expect(slot.getByRole("radio", { name: /^aside.*asks for no work/i })).toBeTruthy();
        slot.lifecycle.unmount();
    });
    it("journal edits use RPC and do not mark linked work done without evidence", async () => {
        const app = await load();
        const tab = app.tabs.find(t => t.id === "journal")!;
        const journalEdit = vi.fn(() => ({ ok: true, message: "You started the retry" }));
        const slot = renderSlot({ component: JournalTab }, { threadId: "keeper-1", environment: null, params: null }, { rpc: { journal: () => ({ ...fixtureJournal, entries: [{ ...fixtureJournal.entries[0]!, link: { boardQuestId: "vault", waypointId: "w1" } }] }), journalEdit } });
        await slot.findByRole("button", { name: /^Doing: Add the retry/ });
        expect(slot.queryByRole("region", { name: /Details of/ })).toBeNull();
        fireEvent.click(slot.getByRole("button", { name: /Mark “Add the retry” done: add evidence first/ }));
        await slot.findByRole("region", { name: "Details of Add the retry" });
        expect(journalEdit).not.toHaveBeenCalled();
        expect((slot.getByRole("button", { name: "Mark done" }) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(slot.getByRole("button", { name: /Block “Add the retry”/ }));
        fireEvent.change(slot.getByRole("textbox", { name: /What blocks it/ }), { target: { value: "waiting for CI" } });
        fireEvent.click(slot.getByRole("button", { name: "Mark blocked" }));
        await waitFor(() => expect(journalEdit).toHaveBeenCalled());
        expect(slot.inspection.rpcCalls.find(c => c.method === "journalEdit")?.input).toMatchObject({ threadId: "keeper-1", edit: { op: "status", status: "blocked", entryIds: ["a1"], reason: "waiting for CI" } });
        slot.lifecycle.unmount();
    });
    it("keeps the hidden composer toggle after a banner mutation fails", async () => {
        const app = await load();
        const custom = app.composerCustomizations.find(c => c.id === "tavern-thread")!;
        const slot = renderSlot(custom.actions![0]!, {}, { composer: { scope: { kind: "thread", threadId: "keeper-1" } }, rpc: { decor: () => ({ ...fixtureDecor, hidden: true }), registry: () => fixtureRegistry, setHidden: () => { throw new Error("Offline"); } } });
        fireEvent.click(await slot.findByRole("button", { name: /Show Tavern/ }));
        await slot.findByRole("alert");
        expect(slot.getByRole("button", { name: /Show Tavern/ })).toBeTruthy();
        slot.lifecycle.unmount();
    });
    it("uses a native row-status content script and clears its bridge on disposal", async () => {
        const app = await load();
        const mounted = await mountPluginContentScripts(app, { pluginId: "tavern" });
        expect(mounted.inspection.mountedIds).toContain("tavern-row-crests");
        // One crest per shape, hue and charge (6 x 6 x 9), plus one plain crest per shape for members with no character.
        expect(app.icons).toHaveLength(6 * 6 * 9 + 6);
        expect(app.icons.map(i => i.name)).toContain("tavern-crest-pennant-plain");
        await mounted.lifecycle.dispose();
        expect(mounted.inspection.disposed).toBe(true);
    });
});
