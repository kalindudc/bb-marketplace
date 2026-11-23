import { experimental_usePluginId, experimental_useServers, useBbContext } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef } from "react";
import { validateDialogue } from "../../shared/strip-scene";

export type DialogueLine = { revision: string; text: string | null; receivedAt: number };

export function DialogueSocket({ threadId, onLine }: { threadId: string; onLine: (line: DialogueLine) => void }) {
  const context = useBbContext();
  const pluginId = experimental_usePluginId();
  const servers = experimental_useServers();
  const origin = servers?.servers.find(server => server.active)?.origin ?? window.location.origin;
  const project = context.projectId;
  const current = useRef(onLine);
  current.current = onLine;
  useEffect(() => {
    if (!project || context.threadId !== threadId) return;
    let socket: WebSocket | null = null;
    let disposed = false;
    const connect = () => {
      if (disposed || document.hidden || socket) return;
      try {
        const url = new URL(`/api/v1/plugins/${encodeURIComponent(pluginId)}/http/strip-dialogue`, origin);
        if (url.protocol !== "https:" && url.protocol !== "http:") return;
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.search = new URLSearchParams({ thread: threadId, project }).toString();
        const opened = socket = new WebSocket(url);
        opened.onmessage = ({ data }) => {
          if (disposed || opened !== socket || document.hidden || typeof data !== "string" || data.length > 1024) return;
          try {
            const value = JSON.parse(data);
            if (typeof value?.revision !== "string") return;
            current.current({ revision: value.revision, text: validateDialogue(value.text), receivedAt: Date.now() });
          } catch { return; }
        };
      } catch { return; }
    };
    const visibility = () => {
      if (document.hidden) { socket?.close(); socket = null; }
      else connect();
    };
    connect();
    document.addEventListener("visibilitychange", visibility);
    return () => { disposed = true; document.removeEventListener("visibilitychange", visibility); socket?.close(); };
  }, [origin, pluginId, project, threadId, context.threadId]);
  return null;
}
