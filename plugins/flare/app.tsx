import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { FlareDivider } from "./src/ui/dividers";
import { FlaresTab } from "./src/ui/panel";
import { FlareSegmentDetails, FlareSegmentSummary, useFlareSegmentVisible } from "./src/ui/segment";
import { FLARE_ICON, FLARES_TAB, FLARES_TAB_ID } from "./src/ui/tab";

export default definePluginApp((app) => {
  // Beside the thread's other context, before bb's changed files; hidden while the thread has no flare to show.
  app.slots.experimental_threadContextSegment({
    id: "flares",
    title: "Flares",
    group: "2_flare",
    order: 10,
    summary: FlareSegmentSummary,
    details: FlareSegmentDetails,
    useVisible: useFlareSegmentVisible,
  });

  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: FLARES_TAB_ID,
    title: "Flares",
    icon: FLARE_ICON,
    layout: "flush",
    component: FlaresTab,
  });

  // Draws nothing outside the Flares tab's rendered view: a divider shows only over a companion's flare messages.
  app.slots.experimental_messageMetadata({ id: "divider", placement: "above", component: FlareDivider });

  app.commands.register({
    id: "show-flares",
    title: "Flare: show this thread's flares",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ threadId, experimental_panel }) => {
      if (threadId !== null) experimental_panel.openTab({ tab: FLARES_TAB, title: "Flares" });
    },
  });
});
