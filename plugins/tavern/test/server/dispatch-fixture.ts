import type { MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { makeMessageDispatchHookContext } from "./host";

type Row = MessageDispatchHookContext["queuedMessages"][number];
export function dispatch049(
  options: {
    threadId?: string;
    text?: string;
    now?: number;
    status?: "idle" | "active" | "pending" | "error";
    pluginId?: string | null;
    senderThreadId?: string | null;
    retry?: boolean;
    rows?: Row[];
    submission?: MessageDispatchHookContext["experimental_submission"];
  } = {},
): MessageDispatchHookContext {
  const sender =
    options.senderThreadId === (options.threadId ?? "lead")
      ? null
      : (options.senderThreadId ?? null);
  const author = options.retry ? "system" : sender ? "agent" : "user";
  const rows = options.rows ?? [];
  const text = rows.length
    ? rows
        .map((r) =>
          r.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n"),
        )
        .join("\n")
    : (options.text ?? "hello");
  const shared = <K extends "initiator" | "senderThreadId" | "originPluginId">(field: K) =>
    rows.every((r) => r[field] === rows[0]![field]) ? rows[0]![field] : "mixed";
  return {
    ...makeMessageDispatchHookContext({
      thread: { id: options.threadId ?? "lead", status: options.status ?? "idle" },
    }),
    input: { text, blocks: [{ type: "text", text, mentions: [] }] },
    initiator: rows.length
      ? (shared("initiator") as MessageDispatchHookContext["initiator"])
      : author,
    senderThreadId: rows.length ? shared("senderThreadId") : sender,
    originPluginId: rows.length ? rows[0]!.originPluginId : (options.pluginId ?? null),
    experimental_submission: options.submission ?? null,
    queuedMessages: rows,
  };
}
export function queued049(
  id: string,
  text: string,
  at: number,
  options: { pluginId?: string; senderThreadId?: string; retry?: boolean } = {},
): Row {
  return {
    id,
    threadId: "lead",
    createdAt: at,
    updatedAt: at,
    content: [{ type: "text", text, mentions: [] }],
    editable: true,
    failureReason: null,
    groupWithNext: false,
    model: "test",
    origin: options.pluginId ? "plugin" : "app",
    payload: { kind: "inline" },
    permissionMode: "full",
    reasoningLevel: "",
    serviceTier: "",
    sendAt: null,
    state: "queued",
    systemNotice: null,
    waitingOn: null,
    initiator: options.retry ? "system" : options.senderThreadId ? "agent" : "user",
    senderThreadId: options.senderThreadId ?? null,
    originPluginId: options.pluginId ?? null,
  };
}
