import type { PluginAppBuilder, PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { ClassBanner, ClassPickerPopover, CrestToggle, TavernBanner } from "./composer";
import { classStartInput, selectionFor, startRefusal } from "./class-start";
import { DIRECTIVE_IDS, DirectiveCard } from "./cards";
import { LedgerTab, JournalTab, JOURNAL_TAB, LEDGER_TAB, useKeeperVisible } from "./tabs";
import { MessageRouteTab, ReadAsTag, RuleTab } from "./metadata";
import { REPORTS_TAB, ReportsTab } from "./reports-tab";
import { registerRowCrests } from "./rows";
import { NameMentionSwap } from "./mentions";
import { JournalCardSection, JournalSegmentSummary, useJournalSegmentVisible } from "./journal-segment";
import { getRpc, threadDecorCache } from "./state";
import { motion } from "../kit/motion";
import { SetupDirective } from "../page/setup";
export function registerThreadSurfaces(app: PluginAppBuilder) {
    app.composer.customize({ id: "tavern-new-thread", scopes: ["new-thread"], banners: [{ id: "class-preview", chrome: "bare", component: ClassBanner }, { id: "names", chrome: "bare", component: NameMentionSwap }], experimental_popups: [{ id: "tavern-classes", label: "Pick a class (thread type)", component: ClassPickerPopover }], plusMenu: [{ id: "pick-class", label: "Choose a Tavern class", run: ({ composer }) => { composer.experimental_openPopup("tavern-classes"); } }], sendMenu: ["Keeper", "Wanderer", "Ranger", "Smith"].map(label => ({ id: `start-${label.toLowerCase()}`, label: `Start as ${label}`, description: "Use this class’s provider, model and role", run: async ({ composer }) => {
                const registry = await getRpc().call("registry", {});
                const cls = registry.classes.find(c => c.id === label.toLowerCase() && c.startable);
                if (!cls)
                    throw new Error(`${label} is not a startable class.`);
                const input = classStartInput(cls.id, composer);
                if (!input)
                    throw new Error("Pick a project first.");
                const facts = await getRpc().call("classExecution", input);
                if (facts.errors[0] || !facts.execution)
                    throw new Error(`${label} can’t start here: ${facts.errors[0] ?? "it has no settings."}`);
                const selection = await composer.setSelection(selectionFor(facts.execution));
                const refusal = startRefusal(facts, selection);
                if (refusal)
                    throw new Error(`Won’t start as ${label}. ${refusal}`);
                await composer.submit({ experimental_data: { classId: cls.id } });
            } })) });
    // The Widget row setting is off: no thread can show the row, so "Show Tavern" and ⌥⌘T say so instead of flipping the thread's flag.
    const rowOff = (composer: PluginComposerApi) => composer.scope.kind === "thread" && threadDecorCache.get(composer.scope.threadId)?.widgetRow === false;
    const ROW_OFF = "The widget row is off in Tavern settings.";
    const keeperOnly = (composer: PluginComposerApi) => composer.scope.kind !== "thread" || threadDecorCache.get(composer.scope.threadId)?.member?.role !== "keeper";
    app.composer.customize({ id: "tavern-thread", scopes: ["thread"], actions: [{ id: "toggle", component: CrestToggle }], banners: [{ id: "widget", chrome: "bare", component: TavernBanner }, { id: "names", chrome: "bare", component: NameMentionSwap }], plusMenu: [{ id: "show", label: "Show Tavern", icon: "tavern/tavern", disabled: rowOff, run: async ({ composer }) => { if (composer.scope.kind !== "thread")
                    return; if ((await getRpc().call("decor", { threadId: composer.scope.threadId })).widgetRow === false)
                    throw new Error(ROW_OFF); await getRpc().call("setHidden", { threadId: composer.scope.threadId, hidden: false }); } }], sendMenu: [
            { id: "aside", label: "Send as an aside", icon: "tavern/side-quest", description: "Unrelated to the board quests; never changes one", disabled: keeperOnly, run: async ({ composer }) => { if (composer.scope.kind !== "thread" || (await getRpc().call("decor", { threadId: composer.scope.threadId })).member?.role !== "keeper")
                    throw new Error("Asides are available in Keeper threads."); await composer.submit({ experimental_data: { route: "aside" } }); } },
            { id: "new-quest", label: "Send as a new goal", icon: "tavern/board-quest", description: "Opens the Keeper’s first quest or asks where an outside goal should go", disabled: keeperOnly, run: async ({ composer }) => { if (composer.scope.kind !== "thread" || (await getRpc().call("decor", { threadId: composer.scope.threadId })).member?.role !== "keeper")
                    throw new Error("Board quests are available in Keeper threads."); await composer.submit({ experimental_data: { route: "new-quest" } }); } },
            { id: "add-journal", label: "Add to journal (checklist)", icon: "tavern/journal", description: "Adds this draft to this thread’s own checklist without sending it", disabled: composer => !composer.text.trim(), run: async ({ composer }) => { if (composer.scope.kind !== "thread")
                    return; const text = composer.text.trim(); if (text.length > 500)
                    throw new Error("Journal entry descriptions are limited to 500 characters. Shorten the draft first."); await getRpc().call("journalEdit", { threadId: composer.scope.threadId, edit: { op: "add", descriptions: [text], parentId: null } }); composer.replace(d => d.text.trim() === text ? { ...d, text: "", mentions: [] } : d); } },
        ] });
    app.composer.experimental_registerCommand({ id: "toggle-tavern", title: "Tavern: hide or show the widget", defaultShortcut: { key: "t", mod: true, alt: true }, run: async ({ composer }) => { if (composer.scope.kind !== "thread")
            return; const decor = await getRpc().call("decor", { threadId: composer.scope.threadId }); if (decor.widgetRow === false)
            throw new Error(ROW_OFF); await getRpc().call("setHidden", { threadId: composer.scope.threadId, hidden: !decor.hidden }); } });
    app.commands.register({ id: "open-journal", title: "Open the journal", defaultShortcut: { key: "l", mod: true, shift: true }, isAvailable: ctx => ctx.threadId !== null, run: ctx => { ctx.experimental_panel.openTab({ tab: JOURNAL_TAB }); } });
    app.slots.experimental_tab({ ...JOURNAL_TAB, title: "Journal (checklist)", icon: "tavern/journal", layout: "flush", component: JournalTab });
    // The journal joins bb's context row beside Shuttle's pull requests (2_pullRequest) and before git (3_git), and the card's sections; it shows in the card only while the card is on screen (card-shown.ts).
    app.slots.experimental_threadContextSegment({ id: "journal", title: "Journal (checklist)", group: "2_tavern-journal", summary: JournalSegmentSummary, useVisible: useJournalSegmentVisible });
    app.slots.experimental_threadContextCardSection({ id: "journal", title: "Journal", group: "1_related", order: 10, component: JournalCardSection });
    app.slots.experimental_tab({ ...LEDGER_TAB, title: "Ledger", icon: "tavern/ledger", layout: "flush", useVisible: useKeeperVisible, component: LedgerTab });
    app.slots.experimental_tab({ id: "message-route", context: { kind: "thread" }, availability: "action", title: "Re-route message", icon: "tavern/route", useVisible: useKeeperVisible, component: MessageRouteTab });
    app.slots.experimental_tab({ id: "message-rule", context: { kind: "thread" }, availability: "action", title: "Standing rule", icon: "tavern/rule", component: RuleTab });
    app.slots.experimental_tab({ ...REPORTS_TAB, title: "Reports", icon: "tavern/report", component: ReportsTab });
    app.slots.experimental_messageMetadata({ id: "read-as", placement: "above", component: ReadAsTag });
    // No global "Re-route…": messageAction cannot be scoped to Keeper threads or to the user's own messages, so correction lives in the Keeper-only read-as tag.
    app.slots.messageAction({ id: "make-rule", title: "Make this a rule", icon: "tavern/rule", run: ctx => { ctx.experimental_panel.openTab({ tab: { id: "message-rule", context: { kind: "thread" }, availability: "action" }, params: { text: (ctx.selectedText ?? ctx.message.text).slice(0, 500) } }); } });
    app.slots.messageAction({ id: "add-to-journal", title: "Add to journal (checklist)", icon: "tavern/journal", run: ctx => { ctx.experimental_panel.openTab({ tab: JOURNAL_TAB, params: { text: (ctx.selectedText ?? ctx.message.text).slice(0, 500) } }); } });
    for (const kind of DIRECTIVE_IDS)
        app.slots.messageDirective({ id: kind, component: props => <DirectiveCard {...props} kind={kind}/> });
    app.slots.messageDirective({ id: "tavern-setup", component: SetupDirective });
    registerRowCrests(app);
    // The motion coordinator lives for one frontend generation: its document and window listeners go when bb replaces or deactivates the bundle.
    app.contentScripts.register({ id: "tavern-motion", mount() { motion.activate(); return () => motion.dispose(); } });
}
