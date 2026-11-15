import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fixtureDecor, fixtureDetail, fixtureLedger, fixtureJournal, fixtureRegistry, fixtureReport } from "../../../src/ui/thread/fixtures";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";
import { ThreadWidget, CrestToggle } from "../../../src/ui/thread/composer";
import { QuestMapCard, ReportCard } from "../../../src/ui/thread/cards";
import { JournalTab } from "../../../src/ui/thread/tabs";
async function preview() {
    await loadPluginApp(definePluginApp(registerThreadSurfaces));
    const log = new URLSearchParams(location.search).has("log");
    renderSlot({ component: () => log ? <JournalTab threadId="keeper-1" environment={null} params={null}/> : <main className="tavern stack"><QuestMapCard detail={fixtureDetail} version={1}/><ReportCard report={fixtureReport}/><ThreadWidget threadId="keeper-1"/><div className="toolbar"><CrestToggle /></div></main> }, {}, { composer: { scope: { kind: "thread", threadId: "keeper-1" } }, rpc: { registry: () => fixtureRegistry, decor: () => fixtureDecor, ledger: () => fixtureLedger, journal: () => fixtureJournal, answerAsk: () => ({ ok: true }), setHidden: () => ({ ok: true }), journalEdit: () => ({ ok: true, message: "Fixture change recorded" }) } });
}
void preview();
