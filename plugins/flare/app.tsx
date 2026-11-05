import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { FlareBanner } from "./src/ui/banner";
import { FlareDivider } from "./src/ui/dividers";
import { FlaresTab } from "./src/ui/panel";
import { FLARE_ICON, FLARES_TAB, FLARES_TAB_ID } from "./src/ui/tab";

export default definePluginApp((app) => {
  app.composer.customize({
    id: "flare",
    scopes: ["thread"],
    // Bare, so a thread with no flare shows no empty card above its message box.
    banners: [{ id: "latest", chrome: "bare", component: FlareBanner }],
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
