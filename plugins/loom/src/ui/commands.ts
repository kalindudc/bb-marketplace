// Loom's rows in bb's own palette (Mod+Shift+P), which reach Loom from anywhere in bb. bb gives a command no navigator,
// so the rail badge's hook, which bb keeps mounted on every screen, hands one over.
import { useEffect } from "react";
import { useBbNavigate, type BbNavigate, type PluginCommandRegistration } from "@get-bb/plugin-sdk/app";
import { intent, palette } from "./dispatch";

let navigate: BbNavigate | null = null;
let pageOpen = false;

/** Keeps the navigator the commands use; call it from a hook bb mounts wherever the person is. */
export function useCommandNavigator() {
  const current = useBbNavigate();
  useEffect(() => {
    navigate = current;
    return () => {
      if (navigate === current) navigate = null;
    };
  });
}

/** Marks Loom's page as open while it is mounted, so a command acts in place instead of navigating there first. */
export function usePageOpen() {
  useEffect(() => {
    pageOpen = true;
    return () => {
      pageOpen = false;
    };
  }, []);
}

export function createCommands(): PluginCommandRegistration[] {
  const ready = () => navigate !== null;
  return [
    {
      id: "next-needs-you",
      title: "Loom: Go to the next thing that needs me",
      isAvailable: ready,
      run() {
        // The page opens the oldest item in Home's Needs you, or Home itself when nothing waits.
        intent.set("next");
        if (!pageOpen) navigate?.toPluginPanel("loom", { subPath: "_home" });
      },
    },
    {
      id: "jump-to",
      title: "Loom: Jump to a project or ticket",
      isAvailable: ready,
      run() {
        palette.set(true);
        if (!pageOpen) navigate?.toPluginPanel("loom");
      },
    },
  ];
}
