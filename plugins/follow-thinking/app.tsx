import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  definePluginApp,
  experimental_Icon as Icon,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { mountFollowThinking } from "./src/follow-thinking";
import { createPreference } from "./src/preference";

const preference = createPreference(window);

function FollowThinkingToggle(_props: PluginThreadHeaderActionProps) {
  const enabled = useSyncExternalStore(preference.subscribe, preference.isEnabled);
  return (
    <button
      type="button"
      aria-label="Follow thinking"
      aria-pressed={enabled}
      title={
        enabled
          ? "Follow thinking is on: thinking blocks open and scroll as they stream"
          : "Follow thinking is off"
      }
      onClick={() => preference.toggle()}
      className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-pressed:bg-state-active aria-pressed:text-foreground"
    >
      <Icon name="AiBrain01" className="size-4" aria-hidden />
    </button>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "follow-thinking",
    mount: ({ signal }) => mountFollowThinking({ document, preference, signal }),
  });
  app.slots.experimental_threadHeaderAction({
    id: "toggle",
    title: "Follow thinking",
    component: FollowThinkingToggle,
  });
  app.commands.register({
    id: "toggle",
    title: "Follow Thinking: Toggle auto-expand and auto-scroll of thinking",
    run: () => {
      toast(preference.toggle() ? "Follow thinking is on" : "Follow thinking is off");
    },
  });
});
