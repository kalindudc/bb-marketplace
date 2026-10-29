import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { BrowserSave, checkAction, CiteDirective, createCommands, HeaderChip, InfoResearch, policyAction, SegmentDetails, SegmentSummary, SourcesDirective, useSegmentVisible } from "./src/ui/chat.tsx";
import { CHECK_TAB_ID, RESEARCH_TAB_ID } from "./src/ui/nav-store.ts";
import { PAGE_PATH, ResearchHeader, ResearchPage, ResearchSidebar, usePageTitle, useResearchBadge } from "./src/ui/page.tsx";
import { CheckTab, ResearchTab } from "./src/ui/research.tsx";

export default definePluginApp((app) => {
 // The ids are the ones the Sources page and tab had, so pages and tabs people left open keep working.
 app.slots.navPanel({
  id: "sources", title: "Research", icon: "forage/forage", path: PAGE_PATH, component: ResearchPage,
  experimental_sidebar: ResearchSidebar, headerContent: ResearchHeader, experimental_usePageTitle: usePageTitle, experimental_useBadge: useResearchBadge,
 });
 app.slots.experimental_tab({ id: RESEARCH_TAB_ID, title: "Research", icon: "forage/forage", context: { kind: "thread" }, availability: "fixed", layout: "flush", component: ResearchTab });
 app.slots.experimental_tab({ id: CHECK_TAB_ID, title: "Check in sources", icon: "forage/forage", context: { kind: "thread" }, availability: "action", layout: "flush", component: CheckTab });
 app.slots.experimental_threadHeaderAction({ id: "research", title: "Research", component: HeaderChip });
 app.slots.experimental_threadContextSegment({ id: "research", title: "Research", group: "4_research", order: 50, summary: SegmentSummary, details: SegmentDetails, useVisible: useSegmentVisible });
 app.slots.experimental_threadInfoSection({ id: "research", group: "1_related", order: 50, component: InfoResearch });
 app.slots.experimental_threadAction(policyAction);
 app.slots.messageDirective({ id: "forage-cite", component: CiteDirective });
 app.slots.messageDirective({ id: "forage-sources", component: SourcesDirective });
 app.slots.messageAction(checkAction);
 app.slots.experimental_browserToolbarAction({ id: "save", title: "Save to research", component: BrowserSave });
 for (const command of createCommands()) app.commands.register(command);
});
