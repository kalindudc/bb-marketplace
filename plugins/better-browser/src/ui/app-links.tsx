import { useEffect } from "react";
import { useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import { interceptAppLinks } from "../app-links";
import type { RpcContract } from "../rpc";
import { openExternally, readSettings } from "./common";

/** Renders nothing: while it is mounted, Cmd+click on a link in bb's own window opens the real browser. */
export function AppLinks() {
  const rpc = useRpc<RpcContract>();
  const { modifierClick } = readSettings(useSettings().values);
  useEffect(() => {
    // The plugin opens links on the computer running the desktop app, so a bb web client elsewhere keeps its own Cmd+click.
    if (!modifierClick || !("bbDesktop" in window)) return;
    return interceptAppLinks(window, { open: (url) => openExternally(rpc, url) });
  }, [rpc, modifierClick]);
  return null;
}
