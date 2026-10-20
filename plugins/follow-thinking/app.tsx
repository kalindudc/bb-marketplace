import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_THREAD_ACTION_GROUPS,
  type PluginThreadActionRegistration,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { mountFollowThinking } from "./src/follow-thinking";
import { createPreference } from "./src/preference";

const preference = createPreference(window);

const useEnabled = () => useSyncExternalStore(preference.subscribe, preference.isEnabled);

const announceToggle = () => {
  toast(preference.toggle() ? "Follow thinking is on" : "Follow thinking is off");
};

function FollowThinkingToggle({ isCompactViewport }: PluginThreadHeaderActionProps) {
  const enabled = useEnabled();
  // A phone header has no room to spare; the thread actions menu carries the toggle there.
  if (isCompactViewport) return null;
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

const toggleAction: PluginThreadActionRegistration<boolean> = {
  id: "toggle",
  title: "Follow thinking",
  icon: "AiBrain01",
  group: experimental_THREAD_ACTION_GROUPS.settings,
  useData: useEnabled,
  item: ({ data: enabled }) => ({
    label: "Follow thinking",
    detail: enabled ? "On" : "Off",
    icon: "AiBrain01",
    run: announceToggle,
  }),
};

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
  app.slots.experimental_threadAction(toggleAction);
  app.commands.register({
    id: "toggle",
    title: "Follow Thinking: Toggle auto-expand and auto-scroll of thinking",
    run: announceToggle,
  });
});
