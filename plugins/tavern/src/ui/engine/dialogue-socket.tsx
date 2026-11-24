import { experimental_usePluginId, experimental_useServers, useBbContext } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef } from "react";
import { dialogueRequestSchema, SPEECH_REPLY_MS, validateDialogue, type DialogueRequest } from "../../shared/strip-scene";

export type DialogueLine = { revision: string; text: string; receivedAt: number; request?: DialogueRequest };

export function DialogueSocket({ threadId, onLine, request }: { threadId: string; onLine: (line: DialogueLine) => void; request?: DialogueRequest }) {
  const context = useBbContext();
  const pluginId = experimental_usePluginId();
  const servers = experimental_useServers();
  const origin = servers?.servers.find(server => server.active)?.origin ?? window.location.origin;
  const project = context.projectId;
  const current = useRef(onLine);
  current.current = onLine;
  const socket = useRef<WebSocket | null>(null);
  const pending = useRef(request);
  const sent = useRef<DialogueRequest>(undefined);
  pending.current = request;
  const send = useCallback(() => {
    const message = pending.current;
    if (!message || sent.current === message || document.hidden || socket.current?.readyState !== WebSocket.OPEN || Date.now() - message.at >= SPEECH_REPLY_MS) return;
    socket.current.send(JSON.stringify(message));
    sent.current = message;
  }, []);
  useEffect(() => {
    if (!project || context.threadId !== threadId) return;
    let disposed = false;
    const connect = () => {
      if (disposed || document.hidden || socket.current) return;
      try {
        const url = new URL(`/api/v1/plugins/${encodeURIComponent(pluginId)}/http/strip-dialogue`, origin);
        if (url.protocol !== "https:" && url.protocol !== "http:") return;
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.search = new URLSearchParams({ thread: threadId, project }).toString();
        const opened = socket.current = new WebSocket(url);
        opened.onopen = () => { if (!disposed && opened === socket.current) send(); };
        opened.onmessage = ({ data }) => {
          if (disposed || opened !== socket.current || document.hidden || typeof data !== "string" || data.length > 1024) return;
          try {
            const value = JSON.parse(data);
            if (typeof value?.revision !== "string") return;
            const replyTo = dialogueRequestSchema.optional().safeParse(value.request);
            const text = validateDialogue(value.text);
            if (text && replyTo.success) current.current({ revision: value.revision, text, receivedAt: Date.now(), request: replyTo.data });
          } catch { return; }
        };
      } catch { return; }
    };
    const visibility = () => {
      if (document.hidden) { socket.current?.close(); socket.current = null; }
      else connect();
    };
    connect();
    document.addEventListener("visibilitychange", visibility);
    return () => { disposed = true; document.removeEventListener("visibilitychange", visibility); socket.current?.close(); socket.current = null; };
  }, [origin, pluginId, project, threadId, context.threadId, send]);
  useEffect(send, [send, request]);
  return null;
}
